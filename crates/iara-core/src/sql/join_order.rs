//! Join ordering of comma-separated FROM items by dynamic programming.
//!
//! Equality predicates between relations are grouped into equivalence
//! classes (`a = b AND b = c` puts `a`, `b`, `c` in one class), so a join
//! the query never states directly - `c = a` - is a candidate as well: with
//! `customer.c_nationkey = supplier.s_nationkey = nation.n_nationkey`,
//! customers can be joined with the filtered nations before anything else.
//!
//! Every connected subset of relations gets its cheapest plan (sum of the
//! estimated sizes of its intermediate results, "C_out"), from the plans of
//! its two-way splits. Cardinalities come from one formula for every order:
//! the product of the relations' (filtered) row counts, divided, per class,
//! by the distinct counts of all its members in the subset but the smallest
//! (with each relation's divisors capped at its rows: `(l_partkey,
//! l_suppkey) = (ps_partkey, ps_suppkey)` matches one partsupp row, not
//! 1/(ndv(partkey) * ndv(suppkey)) of them).
//!
//! The plan is a tree of joins without keys. Its equalities replace the
//! stated ones between relations: one per class for every join of two sides
//! that both have members of it (a stated one when there is, else an
//! inferred one), plus equalities between members of a class in one
//! relation. The caller filters the plan with them and the other WHERE
//! conjuncts, and the optimizer pushes them into the joins.

use std::sync::Arc;

use crate::error::Result;
use crate::expr::{Expr, Operator};
use crate::logical::{JoinType, LogicalPlan};
use crate::physical::planner::{expr_ndv, residual_selectivity};

/// Above this many relations the caller falls back to greedy ordering.
pub const MAX_RELATIONS: usize = 12;

/// A relation of the FROM list with its estimated (filtered) row count.
pub struct Relation {
    pub plan: LogicalPlan,
    pub rows: f64,
}

struct Member {
    rel: usize,
    expr: Expr,
    ndv: f64,
}

/// An equality predicate between two relations, as stated: its members.
struct Stated {
    expr: Expr,
    left: usize,
    right: usize,
}

pub struct Ordered {
    pub plan: LogicalPlan,
    /// the equalities that enforce the classes along the plan's joins ...
    pub equalities: Vec<Expr>,
    /// ... in place of these stated ones
    pub replaced: Vec<Expr>,
}

/// Order the joins of `rels`; `None` when the predicates leave the
/// relations disconnected (the caller then orders them otherwise).
pub fn order(rels: Vec<Relation>, conjuncts: &[&Expr]) -> Result<Option<Ordered>> {
    let n = rels.len();
    if !(2..=MAX_RELATIONS).contains(&n) {
        return Ok(None);
    }
    let rel_of = |e: &Expr| -> Vec<usize> {
        let mut s: Vec<usize> = vec![];
        for col in e.column_refs() {
            for (i, r) in rels.iter().enumerate() {
                if r.plan.schema().has_column(&col) && !s.contains(&i) {
                    s.push(i);
                }
            }
        }
        s
    };
    // equivalence classes of the equalities between two relations
    let mut members: Vec<Member> = vec![];
    let mut class: Vec<usize> = vec![]; // union-find parent per member
    let mut stated: Vec<Stated> = vec![];
    // multi-relation predicates other than those equalities: (relations, selectivity)
    let mut others: Vec<(u32, f64)> = vec![];
    let member_of = |members: &mut Vec<Member>, class: &mut Vec<usize>, rel: usize, e: &Expr| -> usize {
        if let Some(i) = members.iter().position(|m| m.rel == rel && &m.expr == e) {
            return i;
        }
        let rows = rels[rel].rows.max(1.0);
        let ndv = expr_ndv(&rels[rel].plan, e).unwrap_or(rows).min(rows).max(1.0);
        members.push(Member { rel, expr: e.clone(), ndv });
        class.push(class.len());
        members.len() - 1
    };
    fn find(class: &mut [usize], mut i: usize) -> usize {
        while class[i] != i {
            class[i] = class[class[i]];
            i = class[i];
        }
        i
    }
    for c in conjuncts {
        if let Expr::Binary { left, op: Operator::Eq, right } = c {
            let (lr, rr) = (rel_of(left), rel_of(right));
            if lr.len() == 1 && rr.len() == 1 && lr[0] != rr[0] {
                let a = member_of(&mut members, &mut class, lr[0], left);
                let b = member_of(&mut members, &mut class, rr[0], right);
                let (ra, rb) = (find(&mut class, a), find(&mut class, b));
                class[ra] = rb;
                stated.push(Stated { expr: (*c).clone(), left: a, right: b });
                continue;
            }
        }
        let rs = rel_of(c);
        if rs.len() > 1 {
            let schemas: Vec<&crate::schema::PlanSchema> = rs.iter().map(|&r| rels[r].plan.schema().as_ref()).collect();
            others.push((rs.iter().fold(0u32, |m, &r| m | 1 << r), residual_selectivity(c, &schemas)));
        }
    }
    let roots: Vec<usize> = (0..members.len()).map(|i| find(&mut class, i)).collect();
    let mut classes: Vec<Vec<usize>> = vec![];
    let mut root_class: Vec<(usize, usize)> = vec![];
    for (m, &r) in roots.iter().enumerate() {
        match root_class.iter().find(|(root, _)| *root == r) {
            Some(&(_, c)) => classes[c].push(m),
            None => {
                root_class.push((r, classes.len()));
                classes.push(vec![m]);
            }
        }
    }
    // relations a relation shares a class or a predicate with
    let mut adj = vec![0u32; n];
    for c in &classes {
        let mask = c.iter().fold(0u32, |m, &i| m | 1 << members[i].rel);
        for &i in c {
            adj[members[i].rel] |= mask & !(1 << members[i].rel);
        }
    }
    for &(mask, _) in &others {
        for r in 0..n {
            if mask & (1 << r) != 0 {
                adj[r] |= mask & !(1 << r);
            }
        }
    }

    let full = (1u32 << n) - 1;
    let card = |s: u32| -> f64 {
        let mut c: f64 = (0..n).filter(|r| s & (1 << r) != 0).map(|r| rels[r].rows.max(1.0)).product();
        // per class, every member in `s` but one (the smallest distinct
        // count; on ties the bigger relation's) divides. The divisors of a
        // relation against one partner relation (the one holding that
        // smallest member) are capped at its rows: a composite key matches
        // at most one row per distinct value
        let mut divisor = vec![vec![1.0f64; n]; n];
        for cl in &classes {
            let mut ndvs: Vec<(f64, usize)> = vec![];
            for r in 0..n {
                if s & (1 << r) == 0 {
                    continue;
                }
                let d = cl.iter().filter(|&&i| members[i].rel == r).map(|&i| members[i].ndv).fold(f64::INFINITY, f64::min);
                if d.is_finite() {
                    ndvs.push((d, r));
                }
            }
            ndvs.sort_by(|a, b| a.0.total_cmp(&b.0).then(rels[b.1].rows.total_cmp(&rels[a.1].rows)));
            if let Some(&(_, partner)) = ndvs.first() {
                for &(d, r) in ndvs.iter().skip(1) {
                    divisor[r][partner] *= d;
                }
            }
        }
        for (r, row) in divisor.iter().enumerate() {
            for &d in row {
                c /= d.min(rels[r].rows.max(1.0));
            }
        }
        for &(mask, sel) in &others {
            if mask & s == mask {
                c *= sel;
            }
        }
        c.max(1.0)
    };
    // best[s] = (cost, cardinality, split)
    let mut best: Vec<Option<(f64, f64, u32)>> = vec![None; 1 << n];
    for r in 0..n {
        best[1 << r] = Some((0.0, rels[r].rows.max(1.0), 0));
    }
    let mut sets: Vec<u32> = (1..=full).filter(|s| s.count_ones() > 1).collect();
    sets.sort_by_key(|s| s.count_ones());
    for s in sets {
        let mut choice: Option<(f64, u32)> = None;
        // splits s1 | s2 = s with s1 holding the lowest relation (each split once)
        let low = s & s.wrapping_neg();
        let mut s1 = (s - 1) & s;
        while s1 > 0 {
            let s2 = s & !s1;
            if s1 & low != 0 {
                if let (Some(a), Some(b)) = (best[s1 as usize], best[s2 as usize]) {
                    let connected = (0..n).any(|r| s1 & (1 << r) != 0 && adj[r] & s2 != 0);
                    if connected {
                        let cost = a.0 + b.0;
                        if choice.is_none_or(|(c, _)| cost < c) {
                            choice = Some((cost, s1));
                        }
                    }
                }
            }
            s1 = (s1 - 1) & s;
        }
        if let Some((cost, s1)) = choice {
            let c = card(s);
            best[s as usize] = Some((cost + c, c, s1));
        }
    }
    if best[full as usize].is_none() {
        return Ok(None);
    }
    let mut equalities = vec![];
    // members of a class within one relation are equal too
    for cl in &classes {
        for (k, &i) in cl.iter().enumerate() {
            if let Some(&j) = cl[..k].iter().find(|&&j| members[j].rel == members[i].rel) {
                equalities.push(eq(&members[j].expr, &members[i].expr));
            }
        }
    }
    let mut plans: Vec<Option<LogicalPlan>> = rels.into_iter().map(|r| Some(r.plan)).collect();
    let plan = build(full, &best, &mut plans, &classes, &members, &stated, &mut equalities)?;
    Ok(Some(Ordered { plan, equalities, replaced: stated.into_iter().map(|s| s.expr).collect() }))
}

fn eq(a: &Expr, b: &Expr) -> Expr {
    Expr::Binary { left: Box::new(a.clone()), op: Operator::Eq, right: Box::new(b.clone()) }
}

fn build(
    s: u32,
    best: &[Option<(f64, f64, u32)>],
    plans: &mut [Option<LogicalPlan>],
    classes: &[Vec<usize>],
    members: &[Member],
    stated: &[Stated],
    equalities: &mut Vec<Expr>,
) -> Result<LogicalPlan> {
    if s.count_ones() == 1 {
        return Ok(plans[s.trailing_zeros() as usize].take().expect("each relation once"));
    }
    let (_, _, s1) = best[s as usize].expect("planned");
    let s2 = s & !s1;
    let in_set = |set: u32, rel: usize| set & (1 << rel) != 0;
    // one equality for every class with members on both sides
    for cl in classes {
        let side = |set: u32| cl.iter().copied().find(|&i| in_set(set, members[i].rel));
        let (Some(a), Some(b)) = (side(s1), side(s2)) else { continue };
        let st = stated.iter().find(|st| {
            cl.contains(&st.left)
                && ((in_set(s1, members[st.left].rel) && in_set(s2, members[st.right].rel))
                    || (in_set(s2, members[st.left].rel) && in_set(s1, members[st.right].rel)))
        });
        equalities.push(match st {
            Some(st) => st.expr.clone(),
            None => eq(&members[a].expr, &members[b].expr),
        });
    }
    let (c1, c2) = (best[s1 as usize].unwrap().1, best[s2 as usize].unwrap().1);
    let a = build(s1, best, plans, classes, members, stated, equalities)?;
    let b = build(s2, best, plans, classes, members, stated, equalities)?;
    // larger input on the left (the probe side by convention)
    let (l, r) = if c1 >= c2 { (a, b) } else { (b, a) };
    LogicalPlan::join(Arc::new(l), Arc::new(r), vec![], None, JoinType::Inner)
}
