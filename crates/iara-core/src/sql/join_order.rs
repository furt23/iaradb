//! Join ordering of comma-separated FROM items by dynamic programming.
//!
//! Equality predicates between relations are grouped into equivalence
//! classes (`a = b AND b = c` puts `a`, `b`, `c` in one class), so a join
//! the query never states directly - `c = a` - is a candidate as well: with
//! `customer.c_nationkey = supplier.s_nationkey = nation.n_nationkey`,
//! customers can be joined with the filtered nations before anything else.
//!
//! Up to [`EXACT_RELATIONS`] relations, every connected subset gets its
//! cheapest plan (sum of the estimated sizes of its intermediate results,
//! "C_out"), from the plans of its two-way splits: O(3^n) splits. Above, the
//! search is linearized (Neumann & Radke, "Adaptive Optimization of Very
//! Large Join Queries", 2018): the same dynamic programming over only the
//! contiguous runs of an order of the relations (O(n^3) splits) finds the
//! best bushy plan that respects the order. The orders tried are the one of
//! Greedy Operator Ordering (every cluster it joins is a contiguous run, so
//! the plan is at least as cheap as the greedy one) and left-deep greedy
//! orders from the smallest relations, as many as [`LINEAR_BUDGET`] allows.
//! On random join graphs of 6 to 12 relations the result costs about 1% more
//! than the exhaustive search's (see the tests).
//!
//! Cardinalities come from one formula for every order:
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

use std::collections::HashMap;
use std::sync::Arc;

use crate::error::Result;
use crate::expr::{Expr, Operator};
use crate::logical::{JoinType, LogicalPlan};
use crate::physical::planner::{expr_ndv, residual_selectivity};

/// Up to this many relations every connected subset is planned.
const EXACT_RELATIONS: usize = 12;
/// Steps the linearized search may take, about n^4 per order (n^2
/// cardinality estimates of O(n^2) each): every start up to 39 relations, one from 100.
const LINEAR_BUDGET: f64 = 1e8;
/// Above this many relations (the bits of a [`Set`]) the caller falls back to greedy ordering.
pub const MAX_RELATIONS: usize = 128;

/// Relations by index, one bit each.
type Set = u128;

fn bit(r: usize) -> Set {
    1 << r
}

/// The chosen plan: per join (and relation) its estimated rows and the left
/// side of its split (0 for a relation).
type Tree = HashMap<Set, (f64, Set)>;

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
    let mut others: Vec<(Set, f64)> = vec![];
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
            others.push((rs.iter().fold(0, |m, &r| m | bit(r)), residual_selectivity(c, &schemas)));
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
    let mut adj: Vec<Set> = vec![0; n];
    for c in &classes {
        let mask = c.iter().fold(0, |m, &i| m | bit(members[i].rel));
        for &i in c {
            adj[members[i].rel] |= mask & !bit(members[i].rel);
        }
    }
    for &(mask, _) in &others {
        for r in 0..n {
            if mask & bit(r) != 0 {
                adj[r] |= mask & !bit(r);
            }
        }
    }

    let class_masks: Vec<Set> = classes.iter().map(|c| c.iter().fold(0, |m, &i| m | bit(members[i].rel))).collect();
    let estimate = |s: Set| -> f64 {
        // per class, every member in `s` but one (the smallest distinct
        // count; on ties the bigger relation's) divides. The divisors of a
        // relation against one partner relation (the one holding that
        // smallest member) are capped at its rows: a composite key matches
        // at most one row per distinct value
        let mut divisor: Vec<(usize, usize, f64)> = vec![];
        for cl in &classes {
            let mut ndvs: Vec<(f64, usize)> = vec![];
            for r in 0..n {
                if s & bit(r) == 0 {
                    continue;
                }
                let d = cl.iter().filter(|&&i| members[i].rel == r).map(|&i| members[i].ndv).fold(f64::INFINITY, f64::min);
                if d.is_finite() {
                    ndvs.push((d, r));
                }
            }
            ndvs.sort_by(|a, b| a.0.total_cmp(&b.0).then(rels[b.1].rows.total_cmp(&rels[a.1].rows)));
            if let Some(&(_, first)) = ndvs.first() {
                for (idx, &(d, r)) in ndvs.iter().enumerate().skip(1) {
                    let partner = ndvs[..idx]
                        .iter()
                        .map(|&(_, p)| p)
                        .find(|&p| {
                            let pair = bit(r) | bit(p);
                            class_masks.iter().filter(|&&m| m & pair == pair).count() > 1
                        })
                        .unwrap_or(first);
                    match divisor.iter_mut().find(|e| e.0 == r && e.1 == partner) {
                        Some(e) => e.2 *= d,
                        None => divisor.push((r, partner, d)),
                    }
                }
            }
        }
        // relation by relation, so that the product of many row counts doesn't overflow
        let mut c = 1.0f64;
        for r in (0..n).filter(|&r| s & bit(r) != 0) {
            let rows = rels[r].rows.max(1.0);
            c *= rows;
            for e in divisor.iter().filter(|e| e.0 == r) {
                c /= e.2.min(rows);
            }
        }
        for &(mask, sel) in &others {
            if mask & s == mask {
                c *= sel;
            }
        }
        c.max(1.0)
    };
    let mut memo: HashMap<Set, f64> = HashMap::new();
    let mut card = |s: Set| *memo.entry(s).or_insert_with(|| estimate(s));
    let tree = if n <= EXACT_RELATIONS {
        exact(n, &adj, &mut card)
    } else {
        linearized(n, &adj, &mut card)
    };
    let Some(tree) = tree else { return Ok(None) };
    let full = Set::MAX >> (Set::BITS as usize - n);
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
    let plan = build(full, &tree, &mut plans, &classes, &members, &stated, &mut equalities)?;
    Ok(Some(Ordered { plan, equalities, replaced: stated.into_iter().map(|s| s.expr).collect() }))
}

/// The cheapest plan over every connected subset of the `n` relations.
fn exact(n: usize, adj: &[Set], card: &mut dyn FnMut(Set) -> f64) -> Option<Tree> {
    // best[s] = (cost, cardinality, split)
    let mut best: Vec<Option<(f64, f64, Set)>> = vec![None; 1 << n];
    for r in 0..n {
        best[1 << r] = Some((0.0, card(bit(r)), 0));
    }
    let full: Set = (1 << n) - 1;
    let mut sets: Vec<Set> = (1..=full).filter(|s| s.count_ones() > 1).collect();
    sets.sort_by_key(|s| s.count_ones());
    for s in sets {
        let mut choice: Option<(f64, Set)> = None;
        // splits s1 | s2 = s with s1 holding the lowest relation (each split once)
        let low = s & s.wrapping_neg();
        let mut s1 = (s - 1) & s;
        while s1 > 0 {
            let s2 = s & !s1;
            if s1 & low != 0 {
                if let (Some(a), Some(b)) = (best[s1 as usize], best[s2 as usize]) {
                    let connected = (0..n).any(|r| s1 & bit(r) != 0 && adj[r] & s2 != 0);
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
    let mut tree = Tree::new();
    let mut todo = vec![full];
    while let Some(s) = todo.pop() {
        let (_, c, s1) = best[s as usize]?;
        tree.insert(s, (c, s1));
        if s1 != 0 {
            todo.extend([s1, s & !s1]);
        }
    }
    Some(tree)
}

/// The cheapest of the linearized plans over the orders tried (see the module doc).
fn linearized(n: usize, adj: &[Set], card: &mut dyn FnMut(Set) -> f64) -> Option<Tree> {
    let (goo, _) = greedy_order(n, adj, card)?;
    let starts = (LINEAR_BUDGET / (n as f64).powi(4)).clamp(1.0, n as f64) as usize;
    let mut by_rows: Vec<(f64, usize)> = (0..n).map(|r| (card(bit(r)), r)).collect();
    by_rows.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut orders = vec![goo];
    for &(_, r) in &by_rows[..starts] {
        orders.extend(left_deep_order(r, adj, card));
    }
    let mut best: Option<(f64, Tree)> = None;
    for order in orders {
        if let Some((cost, tree)) = linear(&order, adj, card) {
            if best.as_ref().is_none_or(|(b, _)| cost < *b) {
                best = Some((cost, tree));
            }
        }
    }
    best.map(|(_, tree)| tree)
}

/// The relations in left-deep greedy order from `start`: next, the neighbour
/// giving the smallest result.
fn left_deep_order(start: usize, adj: &[Set], card: &mut dyn FnMut(Set) -> f64) -> Option<Vec<usize>> {
    let (mut order, mut set) = (vec![start], bit(start));
    while order.len() < adj.len() {
        let mut pick: Option<(usize, f64)> = None;
        for r in (0..adj.len()).filter(|&r| set & bit(r) == 0 && adj[r] & set != 0) {
            let c = card(set | bit(r));
            if pick.is_none_or(|(_, b)| c < b) {
                pick = Some((r, c));
            }
        }
        let (r, _) = pick?;
        order.push(r);
        set |= bit(r);
    }
    Some(order)
}

/// Greedy Operator Ordering: join the two connected clusters with the
/// smallest result until one is left. Returns the relations in an order in
/// which every cluster it formed is a contiguous run, and the plan's cost;
/// `None` when the relations are disconnected.
fn greedy_order(n: usize, adj: &[Set], card: &mut dyn FnMut(Set) -> f64) -> Option<(Vec<usize>, f64)> {
    // (relations, their neighbours, relations in order)
    let mut clusters: Vec<(Set, Set, Vec<usize>)> = (0..n).map(|r| (bit(r), adj[r], vec![r])).collect();
    let mut cost = 0.0;
    while clusters.len() > 1 {
        let mut pick: Option<(usize, usize, f64)> = None;
        for i in 0..clusters.len() {
            for j in i + 1..clusters.len() {
                if clusters[i].1 & clusters[j].0 == 0 {
                    continue;
                }
                let c = card(clusters[i].0 | clusters[j].0);
                if pick.is_none_or(|(_, _, b)| c < b) {
                    pick = Some((i, j, c));
                }
            }
        }
        let (i, j, c) = pick?;
        cost += c;
        let (s, near, order) = clusters.remove(j);
        clusters[i].0 |= s;
        clusters[i].1 |= near;
        clusters[i].2.extend(order);
    }
    clusters.pop().map(|c| (c.2, cost))
}

/// The cheapest plan whose joins all join contiguous runs of `order`, and its cost.
fn linear(order: &[usize], adj: &[Set], card: &mut dyn FnMut(Set) -> f64) -> Option<(f64, Tree)> {
    let m = order.len();
    // the relations of order[i..=j] and their neighbours
    let mut set = vec![vec![0 as Set; m]; m];
    let mut near = vec![vec![0 as Set; m]; m];
    for i in 0..m {
        let (mut s, mut a) = (0, 0);
        for j in i..m {
            s |= bit(order[j]);
            a |= adj[order[j]];
            (set[i][j], near[i][j]) = (s, a);
        }
    }
    // best[i][j] = (cost, cardinality, last position of the left side)
    let mut best: Vec<Vec<Option<(f64, f64, usize)>>> = vec![vec![None; m]; m];
    for len in 1..=m {
        for i in 0..=m - len {
            let j = i + len - 1;
            if len == 1 {
                best[i][i] = Some((0.0, card(set[i][i]), i));
                continue;
            }
            let mut choice: Option<(f64, usize)> = None;
            for k in i..j {
                if let (Some(a), Some(b)) = (best[i][k], best[k + 1][j]) {
                    if near[i][k] & set[k + 1][j] != 0 && choice.is_none_or(|(c, _)| a.0 + b.0 < c) {
                        choice = Some((a.0 + b.0, k));
                    }
                }
            }
            if let Some((cost, k)) = choice {
                let c = card(set[i][j]);
                best[i][j] = Some((cost + c, c, k));
            }
        }
    }
    let mut tree = Tree::new();
    let mut todo = vec![(0, m - 1)];
    while let Some((i, j)) = todo.pop() {
        let (_, c, k) = best[i][j]?;
        if i == j {
            tree.insert(set[i][i], (c, 0));
        } else {
            tree.insert(set[i][j], (c, set[i][k]));
            todo.extend([(i, k), (k + 1, j)]);
        }
    }
    Some((best[0][m - 1]?.0, tree))
}

fn eq(a: &Expr, b: &Expr) -> Expr {
    Expr::Binary { left: Box::new(a.clone()), op: Operator::Eq, right: Box::new(b.clone()) }
}

fn build(
    s: Set,
    tree: &Tree,
    plans: &mut [Option<LogicalPlan>],
    classes: &[Vec<usize>],
    members: &[Member],
    stated: &[Stated],
    equalities: &mut Vec<Expr>,
) -> Result<LogicalPlan> {
    if s.count_ones() == 1 {
        return Ok(plans[s.trailing_zeros() as usize].take().expect("each relation once"));
    }
    let (_, s1) = tree[&s];
    let s2 = s & !s1;
    let in_set = |set: Set, rel: usize| set & bit(rel) != 0;
    // one equality for every class with members on both sides
    for cl in classes {
        let side = |set: Set| cl.iter().copied().find(|&i| in_set(set, members[i].rel));
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
    let (c1, c2) = (tree[&s1].0, tree[&s2].0);
    let a = build(s1, tree, plans, classes, members, stated, equalities)?;
    let b = build(s2, tree, plans, classes, members, stated, equalities)?;
    // larger input on the left (the probe side by convention)
    let (l, r) = if c1 >= c2 { (a, b) } else { (b, a) };
    LogicalPlan::join(Arc::new(l), Arc::new(r), vec![], None, JoinType::Inner)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Random connected join graphs (a spanning tree plus extra edges) with
    /// row counts from 10 to 10^7 and per-edge key domains: the linearized
    /// plan is never worse than the greedy one nor better than the exact one.
    #[test]
    fn linearized_lies_between_exact_and_greedy() {
        let mut seed = 42u64;
        let mut next = move |m: u64| {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            (seed >> 33) % m
        };
        let (mut linear_over, mut greedy_over) = (0.0f64, 0.0f64);
        let graphs = 300;
        for _ in 0..graphs {
            let n = 6 + next(7) as usize;
            let rows: Vec<f64> = (0..n).map(|_| 10f64.powf(1.0 + next(600) as f64 / 100.0)).collect();
            let mut edges: Vec<(usize, usize, f64)> = vec![];
            for r in 1..n {
                let p = next(r as u64) as usize;
                edges.push((p, r, rows[p].min(rows[r]) * (1 + next(10)) as f64 / 10.0));
            }
            for _ in 0..next(n as u64) {
                let (a, b) = (next(n as u64) as usize, next(n as u64) as usize);
                if a != b {
                    edges.push((a, b, rows[a].min(rows[b]) * (1 + next(10)) as f64 / 10.0));
                }
            }
            let mut adj: Vec<Set> = vec![0; n];
            for &(a, b, _) in &edges {
                adj[a] |= bit(b);
                adj[b] |= bit(a);
            }
            let mut card = |s: Set| {
                let product: f64 = (0..n).filter(|&r| s & bit(r) != 0).map(|r| rows[r]).product();
                let ndv: f64 = edges.iter().filter(|e| s & bit(e.0) != 0 && s & bit(e.1) != 0).map(|e| e.2.max(1.0)).product();
                (product / ndv).max(1.0)
            };
            let cost = |t: &Tree| -> f64 { t.iter().filter(|(s, _)| s.count_ones() > 1).map(|(_, v)| v.0).sum() };
            let best = cost(&exact(n, &adj, &mut card).unwrap());
            let (_, greedy) = greedy_order(n, &adj, &mut card).unwrap();
            let lin = cost(&linearized(n, &adj, &mut card).unwrap());
            assert!(best <= lin * (1.0 + 1e-9) && lin <= greedy * (1.0 + 1e-9), "{best} {lin} {greedy}");
            linear_over += (lin / best).ln();
            greedy_over += (greedy / best).ln();
        }
        let (lin, greedy) = ((linear_over / graphs as f64).exp(), (greedy_over / graphs as f64).exp());
        eprintln!("geometric mean cost over the exact plan's: linearized {lin:.4}, greedy {greedy:.4}");
        assert!(lin < 1.03, "{lin}");
    }
}
