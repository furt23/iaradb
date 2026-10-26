//! Rule based logical optimizer.
//!
//! 1. constant folding / boolean simplification
//! 2. predicate pushdown (through projections, aliases, aggregates, sorts,
//!    unions and joins; extraction of equi-join keys from WHERE clauses;
//!    pruning hints into scans)
//! 3. limit pushdown (Sort + Limit => TopK, limits into scans)
//! 4. projection pushdown (column pruning down to the file readers)
//! 5. aggregate rewrites (`SUM(x + c)` as `SUM(x) + c * COUNT(x)`, `DISTINCT`
//!    aggregates as a second grouping)

use std::collections::BTreeSet;
use std::sync::Arc;

use crate::error::Result;
use crate::expr::{Expr, Operator, conjunction, split_conjunction};
use crate::logical::*;
use crate::physical::expr::evaluate_constant;
use crate::scalar::Scalar;
use crate::schema::{Column, PlanSchema};

pub fn optimize(plan: &LogicalPlan) -> Result<LogicalPlan> {
    let plan = simplify_plan(plan)?;
    let plan = push_down_filters(&plan, vec![])?;
    let plan = simplify_plan(&plan)?;
    let plan = push_down_semi_joins(&plan)?;
    let plan = push_down_limit(&plan, None)?;
    let plan = rewrite_aggregates(&plan)?;
    let n = plan.schema().len();
    let plan = prune_columns(&plan, &(0..n).collect())?;
    Ok(plan)
}

/// Cardinality estimate of a plan once its predicates were pushed into joins
/// and scans (a raw `FROM a, b WHERE a.k = b.k` looks like a cross product).
/// `plan` with its filters pushed down (for analysis; the input on failure).
pub fn pushed_down(plan: &LogicalPlan) -> LogicalPlan {
    simplify_plan(plan).and_then(|p| push_down_filters(&p, vec![])).unwrap_or_else(|_| plan.clone())
}

pub fn estimate_after_pushdown(plan: &LogicalPlan) -> f64 {
    let pushed = simplify_plan(plan).and_then(|p| push_down_filters(&p, vec![]));
    match pushed {
        Ok(p) => crate::physical::planner::estimate_rows(&p),
        Err(_) => crate::physical::planner::estimate_rows(plan),
    }
}

mod agg_pushdown;
mod distinct_agg;
mod sum_shift;

fn rewrite_aggregates(plan: &LogicalPlan) -> Result<LogicalPlan> {
    let plan = map_inputs(plan, &mut |p| rewrite_aggregates(p))?;
    rewrite_aggregate(&plan)
}

/// Rewrite an aggregation node (any other plan stays as it is).
fn rewrite_aggregate(plan: &LogicalPlan) -> Result<LogicalPlan> {
    if let LogicalPlan::Aggregate(a) = plan {
        if let Some(p) = distinct_agg::rewrite(a)? {
            return Ok(p);
        }
        if let Some(p) = agg_pushdown::rewrite(a)? {
            return Ok(p);
        }
        if let Some(p) = sum_shift::rewrite(a)? {
            return Ok(p);
        }
    }
    Ok(plan.clone())
}

fn map_inputs(plan: &LogicalPlan, f: &mut dyn FnMut(&LogicalPlan) -> Result<LogicalPlan>) -> Result<LogicalPlan> {
    let inputs = plan.inputs();
    if inputs.is_empty() {
        return Ok(plan.clone());
    }
    let new_inputs = inputs.into_iter().map(|i| f(i).map(Arc::new)).collect::<Result<Vec<_>>>()?;
    plan.with_new_inputs(new_inputs)
}

// ---------------------------------------------------------------------------
// expression simplification
// ---------------------------------------------------------------------------

fn is_bool_lit(e: &Expr, v: bool) -> bool {
    matches!(e, Expr::Literal(s) if s.as_bool() == Some(v))
}

pub fn simplify_expr(e: Expr) -> Result<Expr> {
    e.transform_up(&mut |e| {
        let e = match e {
            Expr::Binary { left, op: Operator::And, right } => {
                if is_bool_lit(&left, true) {
                    return Ok(*right);
                }
                if is_bool_lit(&right, true) {
                    return Ok(*left);
                }
                if is_bool_lit(&left, false) || is_bool_lit(&right, false) {
                    return Ok(Expr::Literal(Scalar::boolean(false)));
                }
                Expr::Binary { left, op: Operator::And, right }
            }
            Expr::Binary { left, op: Operator::Or, right } => {
                if is_bool_lit(&left, false) {
                    return Ok(*right);
                }
                if is_bool_lit(&right, false) {
                    return Ok(*left);
                }
                if is_bool_lit(&left, true) || is_bool_lit(&right, true) {
                    return Ok(Expr::Literal(Scalar::boolean(true)));
                }
                // (A AND B) OR (A AND C)  =>  A AND (B OR C)
                let lc = split_conjunction(&left);
                let rc = split_conjunction(&right);
                let common: Vec<Expr> = lc.iter().filter(|x| rc.contains(x)).cloned().collect();
                if !common.is_empty() {
                    let lrest: Vec<Expr> = lc.into_iter().filter(|x| !common.contains(x)).collect();
                    let rrest: Vec<Expr> = rc.into_iter().filter(|x| !common.contains(x)).collect();
                    let factored = conjunction(common).unwrap();
                    return Ok(match (conjunction(lrest), conjunction(rrest)) {
                        // one side is implied by the common part: A OR (A AND C) == A
                        (None, _) | (_, None) => factored,
                        (Some(l), Some(r)) => factored.and(l.or(r)),
                    });
                }
                Expr::Binary { left, op: Operator::Or, right }
            }
            Expr::Not(inner) => match *inner {
                Expr::Not(x) => *x,
                Expr::Binary { left, op, right } if op.negate().is_some() => {
                    Expr::Binary { left, op: op.negate().unwrap(), right }
                }
                Expr::IsNull(x) => Expr::IsNotNull(x),
                Expr::IsNotNull(x) => Expr::IsNull(x),
                other => Expr::Not(Box::new(other)),
            },
            other => other,
        };
        // fold constant sub-expressions
        let foldable = !matches!(
            e,
            Expr::Literal(_)
                | Expr::Column(_)
                | Expr::Agg { .. }
                | Expr::Window(_)
                | Expr::Alias(..)
                | Expr::Wildcard { .. }
                | Expr::ScalarSubquery(_)
                | Expr::InSubquery { .. }
                | Expr::Exists { .. }
                | Expr::OuterRef(..)
        ) && e.column_refs().is_empty()
            && !e.contains_subquery()
            && !e.contains_outer_ref()
            && !e.contains_agg()
            && !e.contains_window();
        if foldable {
            if let Ok(Some(s)) = evaluate_constant(&e) {
                return Ok(Expr::Literal(s));
            }
        }
        Ok(e)
    })
}

fn simplify_plan(plan: &LogicalPlan) -> Result<LogicalPlan> {
    let plan = map_inputs(plan, &mut |p| simplify_plan(p))?;
    Ok(match plan {
        LogicalPlan::Filter(f) => {
            let p = simplify_expr(f.predicate.clone())?;
            if is_bool_lit(&p, true) {
                return Ok(f.input.as_ref().clone());
            }
            LogicalPlan::filter(f.input.clone(), p)?
        }
        LogicalPlan::Projection(p) => {
            let exprs = p
                .exprs
                .iter()
                .map(|e| {
                    let name = e.output_name();
                    let s = simplify_expr(e.clone())?;
                    // keep output names stable
                    Ok(if s.output_name() != name { s.unalias().alias(name) } else { s })
                })
                .collect::<Result<Vec<_>>>()?;
            // restore the qualifier of plain column references
            let exprs = exprs
                .into_iter()
                .zip(p.exprs.iter())
                .map(|(new, old)| if matches!(old, Expr::Column(_)) { old.clone() } else { new })
                .collect();
            LogicalPlan::project(p.input.clone(), exprs)?
        }
        LogicalPlan::Join(j) => {
            let filter = match &j.filter {
                Some(f) => {
                    let s = simplify_expr(f.clone())?;
                    if is_bool_lit(&s, true) { None } else { Some(s) }
                }
                None => None,
            };
            LogicalPlan::join(j.left.clone(), j.right.clone(), j.on.clone(), filter, j.join_type)?
        }
        other => other,
    })
}

// ---------------------------------------------------------------------------
// predicate pushdown
// ---------------------------------------------------------------------------

/// Replace column references in `e` using `f` (returns None if some column cannot be mapped).
fn rewrite_columns(e: &Expr, f: &dyn Fn(&Column) -> Option<Expr>) -> Option<Expr> {
    let mut ok = true;
    let out = e
        .clone()
        .transform_up(&mut |x| match x {
            Expr::Column(c) => match f(&c) {
                Some(r) => Ok(r),
                None => {
                    ok = false;
                    Ok(Expr::Column(c))
                }
            },
            other => Ok(other),
        })
        .ok()?;
    ok.then_some(out)
}

fn refs_only(e: &Expr, schema: &PlanSchema) -> bool {
    e.column_refs().iter().all(|c| matches!(schema.maybe_index_of(c), Ok(Some(_))))
}

fn wrap_filter(plan: LogicalPlan, preds: Vec<Expr>) -> Result<LogicalPlan> {
    match conjunction(preds) {
        Some(p) => LogicalPlan::filter(Arc::new(plan), p),
        None => Ok(plan),
    }
}

fn strip_filters(p: &LogicalPlan) -> &LogicalPlan {
    match p {
        LogicalPlan::Filter(f) => strip_filters(&f.input),
        LogicalPlan::SubqueryAlias(a) => strip_filters(&a.input),
        other => other,
    }
}

/// Whether `e` calls a scalar function or matches a pattern (work worth not repeating).
fn computes_function(e: &Expr) -> bool {
    let mut found = false;
    let _ = e.clone().transform_up(&mut |x| {
        if matches!(x, Expr::Function { .. } | Expr::Like { .. }) {
            found = true;
        }
        Ok(x)
    });
    found
}

fn is_volatile(_e: &Expr) -> bool {
    false
}

fn push_down_filters(plan: &LogicalPlan, preds: Vec<Expr>) -> Result<LogicalPlan> {
    match plan {
        LogicalPlan::Filter(f) => {
            let mut p = preds;
            p.extend(split_conjunction(&f.predicate));
            push_down_filters(&f.input, p)
        }
        LogicalPlan::Projection(proj) => {
            let schema = proj.schema.clone();
            let mut push = vec![];
            let mut keep = vec![];
            // a function computed by the projection would run twice (in the
            // filter, then for the rows that pass): the filter stays above it,
            // unless a join below could use the predicate
            let feeds_join = matches!(strip_filters(&proj.input), LogicalPlan::Join(_));
            for pred in preds {
                let rewritten = rewrite_columns(&pred, &|c| {
                    let idx = schema.maybe_index_of(c).ok()??;
                    let e = proj.exprs[idx].clone().unalias();
                    let dup = !feeds_join && computes_function(&e);
                    if e.contains_agg() || is_volatile(&e) || dup { None } else { Some(e) }
                });
                match rewritten {
                    Some(r) => push.push(r),
                    None => keep.push(pred),
                }
            }
            let input = push_down_filters(&proj.input, push)?;
            let p = LogicalPlan::project(Arc::new(input), proj.exprs.clone())?;
            wrap_filter(p, keep)
        }
        LogicalPlan::SubqueryAlias(sa) => {
            let in_schema = sa.input.schema().clone();
            let out_schema = sa.schema.clone();
            let mut push = vec![];
            let mut keep = vec![];
            for pred in preds {
                let r = rewrite_columns(&pred, &|c| {
                    let idx = out_schema.maybe_index_of(c).ok()??;
                    Some(Expr::Column(in_schema.column(idx)))
                });
                match r {
                    Some(r) => push.push(r),
                    None => keep.push(pred),
                }
            }
            let input = push_down_filters(&sa.input, push)?;
            wrap_filter(LogicalPlan::subquery_alias(Arc::new(input), &sa.alias), keep)
        }
        LogicalPlan::Sort(s) => {
            let input = push_down_filters(&s.input, preds)?;
            LogicalPlan::sort(Arc::new(input), s.exprs.clone(), s.fetch)
        }
        LogicalPlan::Aggregate(a) => {
            let schema = a.schema.clone();
            let ng = a.group_by.len();
            let mut push = vec![];
            let mut keep = vec![];
            for pred in preds {
                let r = rewrite_columns(&pred, &|c| {
                    let idx = schema.maybe_index_of(c).ok()??;
                    if idx < ng { Some(a.group_by[idx].clone().unalias()) } else { None }
                });
                match r {
                    Some(r) => push.push(r),
                    None => keep.push(pred),
                }
            }
            let input = push_down_filters(&a.input, push)?;
            let p = LogicalPlan::aggregate(Arc::new(input), a.group_by.clone(), a.aggs.clone())?;
            wrap_filter(p, keep)
        }
        LogicalPlan::Union(u) => {
            let mut inputs = vec![];
            for i in &u.inputs {
                let in_schema = i.schema().clone();
                let out_schema = u.schema.clone();
                let mapped: Vec<Expr> = preds
                    .iter()
                    .filter_map(|p| {
                        rewrite_columns(p, &|c| {
                            let idx = out_schema.maybe_index_of(c).ok()??;
                            Some(Expr::Column(in_schema.column(idx)))
                        })
                    })
                    .collect();
                if mapped.len() != preds.len() {
                    // could not map every predicate: keep them all above
                    let rebuilt = u.inputs.iter().map(|i| push_down_filters(i, vec![]).map(Arc::new)).collect::<Result<Vec<_>>>()?;
                    return wrap_filter(LogicalPlan::union(rebuilt)?, preds);
                }
                inputs.push(Arc::new(push_down_filters(i, mapped)?));
            }
            LogicalPlan::union(inputs)
        }
        LogicalPlan::Join(j) => push_into_join(j, preds),
        LogicalPlan::Scan(s) => {
            let mut scan = s.clone();
            for p in &preds {
                // pruning hints use unqualified table columns
                if let Some(u) = rewrite_columns(p, &|c| Some(Expr::Column(Column::from_name(c.name.clone())))) {
                    if !u.contains_subquery() && !scan.filters.contains(&u) {
                        scan.filters.push(u);
                    }
                }
            }
            wrap_filter(LogicalPlan::Scan(scan), preds)
        }
        LogicalPlan::Window(w) => push_through_window(w, preds),
        LogicalPlan::Limit(_) | LogicalPlan::Values(_) | LogicalPlan::RecursiveQuery(_) | LogicalPlan::Unnest(_) => {
            let p = map_inputs(plan, &mut |i| push_down_filters(i, vec![]))?;
            wrap_filter(p, preds)
        }
    }
}

/// Predicates on columns that every window partitions by remove whole
/// partitions, so they can run before the window functions.
fn push_through_window(w: &Window, preds: Vec<Expr>) -> Result<LogicalPlan> {
    let in_schema = w.input.schema().clone();
    let n_in = in_schema.len();
    let mut common: Option<BTreeSet<usize>> = None;
    for e in &w.exprs {
        let Expr::Window(we) = e.unalias_ref() else { continue };
        let cols: BTreeSet<usize> = we
            .partition_by
            .iter()
            .filter_map(|p| p.as_column().and_then(|c| in_schema.maybe_index_of(c).ok().flatten()))
            .collect();
        common = Some(match common {
            Some(c) => c.intersection(&cols).copied().collect(),
            None => cols,
        });
    }
    let common = common.unwrap_or_default();
    let (mut push, mut keep) = (vec![], vec![]);
    for pred in preds {
        let mapped = rewrite_columns(&pred, &|c| {
            let i = w.schema.maybe_index_of(c).ok()??;
            (i < n_in && common.contains(&i)).then(|| Expr::Column(in_schema.column(i)))
        });
        match mapped {
            Some(m) if !pred.column_refs().is_empty() => push.push(m),
            _ => keep.push(pred),
        }
    }
    let input = push_down_filters(&w.input, push)?;
    wrap_filter(LogicalPlan::window(Arc::new(input), w.exprs.clone())?, keep)
}

fn split_disjunction(e: &Expr) -> Vec<Expr> {
    match e {
        Expr::Binary { left, op: Operator::Or, right } => {
            let mut v = split_disjunction(left);
            v.extend(split_disjunction(right));
            v
        }
        other => vec![other.clone()],
    }
}

/// From `(A1 AND B1) OR (A2 AND B2)` derive the predicate implied for one
/// input: `A1 OR A2` (where the Ai only reference `schema`). Lets selective
/// conditions hidden in cross-table disjunctions reach the scans.
pub fn derive_side_predicate(p: &Expr, schema: &PlanSchema) -> Option<Expr> {
    let disjuncts = split_disjunction(p);
    if disjuncts.len() < 2 {
        return None;
    }
    let mut parts = Vec::with_capacity(disjuncts.len());
    for d in &disjuncts {
        let local: Vec<Expr> = split_conjunction(d)
            .into_iter()
            .filter(|c| !c.column_refs().is_empty() && refs_only(c, schema))
            .collect();
        parts.push(conjunction(local)?);
    }
    parts.into_iter().reduce(|a, b| a.or(b))
}

/// Split `a = b` into join keys when each side references exactly one input.
fn as_equi_key(e: &Expr, ls: &PlanSchema, rs: &PlanSchema) -> Option<(Expr, Expr)> {
    if let Expr::Binary { left, op: Operator::Eq, right } = e {
        let lrefs = left.column_refs();
        let rrefs = right.column_refs();
        if lrefs.is_empty() || rrefs.is_empty() {
            return None;
        }
        if refs_only(left, ls) && refs_only(right, rs) && !refs_only(left, rs) && !refs_only(right, ls) {
            return Some((left.as_ref().clone(), right.as_ref().clone()));
        }
        if refs_only(left, rs) && refs_only(right, ls) && !refs_only(left, ls) && !refs_only(right, rs) {
            return Some((right.as_ref().clone(), left.as_ref().clone()));
        }
    }
    None
}

fn push_into_join(j: &Join, preds: Vec<Expr>) -> Result<LogicalPlan> {
    let ls = j.left.schema().clone();
    let rs = j.right.schema().clone();
    let mut left_preds = vec![];
    let mut right_preds = vec![];
    let mut on = j.on.clone();
    let mut join_filter = vec![];
    let mut above = vec![];

    let side = |e: &Expr| -> (bool, bool) {
        let refs = e.column_refs();
        let l = refs.iter().all(|c| matches!(ls.maybe_index_of(c), Ok(Some(_))));
        let r = refs.iter().all(|c| matches!(rs.maybe_index_of(c), Ok(Some(_))));
        (l, r)
    };

    // predicates from above the join
    for p in preds {
        let (l, r) = side(&p);
        match j.join_type {
            JoinType::Inner => {
                if l && !r || (l && r && p.column_refs().is_empty()) {
                    left_preds.push(p);
                } else if r && !l {
                    right_preds.push(p);
                } else if let Some(k) = as_equi_key(&p, &ls, &rs) {
                    on.push(k);
                } else {
                    if let Some(d) = derive_side_predicate(&p, &ls) {
                        left_preds.push(d);
                    }
                    if let Some(d) = derive_side_predicate(&p, &rs) {
                        right_preds.push(d);
                    }
                    join_filter.push(p);
                }
            }
            JoinType::Left | JoinType::Semi | JoinType::Anti => {
                if l && !p.column_refs().is_empty() {
                    left_preds.push(p);
                } else {
                    above.push(p);
                }
            }
            JoinType::Right => {
                if r && !l && !p.column_refs().is_empty() {
                    right_preds.push(p);
                } else {
                    above.push(p);
                }
            }
            JoinType::Full => above.push(p),
        }
    }
    // the join's own (ON) filter
    if let Some(f) = &j.filter {
        for p in split_conjunction(f) {
            let (l, r) = side(&p);
            if let Some(k) = as_equi_key(&p, &ls, &rs) {
                on.push(k);
                continue;
            }
            match j.join_type {
                JoinType::Inner => {
                    if l && !r {
                        left_preds.push(p)
                    } else if r && !l {
                        right_preds.push(p)
                    } else {
                        join_filter.push(p)
                    }
                }
                // ON-clause predicates on the non-preserved side can be pushed into it
                JoinType::Left | JoinType::Semi | JoinType::Anti if r && !l => right_preds.push(p),
                JoinType::Right if l && !r => left_preds.push(p),
                _ => join_filter.push(p),
            }
        }
    }
    let left = push_down_filters(&j.left, left_preds)?;
    let right = push_down_filters(&j.right, right_preds)?;
    let joined = LogicalPlan::join(Arc::new(left), Arc::new(right), on, conjunction(join_filter), j.join_type)?;
    wrap_filter(joined, above)
}

// ---------------------------------------------------------------------------
// limit pushdown
// ---------------------------------------------------------------------------

fn push_down_limit(plan: &LogicalPlan, limit: Option<usize>) -> Result<LogicalPlan> {
    match plan {
        LogicalPlan::Limit(l) => {
            let fetch = l.fetch.map(|f| f + l.skip);
            let child_limit = match (fetch, limit) {
                (Some(a), Some(b)) => Some(a.min(b + l.skip)),
                (a, _) => a,
            };
            let input = push_down_limit(&l.input, child_limit)?;
            Ok(LogicalPlan::limit(Arc::new(input), l.skip, l.fetch))
        }
        LogicalPlan::Sort(s) => {
            let fetch = match (s.fetch, limit) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
            let input = push_down_limit(&s.input, None)?;
            LogicalPlan::sort(Arc::new(input), s.exprs.clone(), fetch)
        }
        LogicalPlan::Projection(p) => {
            let input = push_down_limit(&p.input, limit)?;
            LogicalPlan::project(Arc::new(input), p.exprs.clone())
        }
        LogicalPlan::SubqueryAlias(sa) => {
            let input = push_down_limit(&sa.input, limit)?;
            Ok(LogicalPlan::subquery_alias(Arc::new(input), &sa.alias))
        }
        LogicalPlan::Scan(s) => {
            let mut s = s.clone();
            if let Some(l) = limit {
                s.fetch = Some(s.fetch.map_or(l, |f| f.min(l)));
            }
            Ok(LogicalPlan::Scan(s))
        }
        LogicalPlan::Union(u) => {
            let inputs = u
                .inputs
                .iter()
                .map(|i| push_down_limit(i, limit).map(Arc::new))
                .collect::<Result<Vec<_>>>()?;
            LogicalPlan::union(inputs)
        }
        LogicalPlan::RecursiveQuery(r) => {
            // any `limit` rows of the result will do: stop iterating once produced
            let p = map_inputs(plan, &mut |i| push_down_limit(i, None))?;
            let LogicalPlan::RecursiveQuery(mut q) = p else { unreachable!() };
            if let Some(l) = limit {
                q.fetch = Some(r.fetch.map_or(l, |f| f.min(l)));
            }
            Ok(LogicalPlan::RecursiveQuery(q))
        }
        _ => map_inputs(plan, &mut |i| push_down_limit(i, None)),
    }
}

// ---------------------------------------------------------------------------
// projection pushdown (column pruning)
// ---------------------------------------------------------------------------

fn indices_of(exprs: &[&Expr], schema: &PlanSchema) -> Result<BTreeSet<usize>> {
    let mut out = BTreeSet::new();
    for e in exprs {
        for c in e.column_refs() {
            if let Some(i) = schema.maybe_index_of(&c)? {
                out.insert(i);
            }
        }
    }
    Ok(out)
}

/// Keep only the columns `keep` of `plan`'s output (as a column projection).
fn project_columns(plan: LogicalPlan, keep: &BTreeSet<usize>) -> Result<LogicalPlan> {
    let schema = plan.schema().clone();
    if keep.len() == schema.len() {
        return Ok(plan);
    }
    let exprs = keep.iter().map(|&i| Expr::Column(schema.column(i))).collect();
    LogicalPlan::project(Arc::new(plan), exprs)
}

fn prune_columns(plan: &LogicalPlan, required: &BTreeSet<usize>) -> Result<LogicalPlan> {
    match plan {
        LogicalPlan::Scan(s) => {
            let base: Vec<usize> = match &s.projection {
                Some(p) => p.clone(),
                None => (0..s.source.schema().fields().len()).collect(),
            };
            let proj: Vec<usize> = required.iter().map(|&i| base[i]).collect();
            LogicalPlan::scan(&s.table_name, s.qualifier.clone(), s.source.clone(), Some(proj), s.filters.clone(), s.fetch)
        }
        LogicalPlan::Projection(p) => {
            let mut exprs: Vec<Expr> = required.iter().map(|&i| p.exprs[i].clone()).collect();
            let in_schema = p.input.schema();
            let refs: Vec<&Expr> = exprs.iter().collect();
            let child_req = indices_of(&refs, in_schema)?;
            let input = prune_columns(&p.input, &child_req)?;
            // identity projection elimination
            let new_in = input.schema().clone();
            if exprs.len() == new_in.len()
                && exprs.iter().enumerate().all(|(i, e)| match e {
                    Expr::Column(c) => new_in.maybe_index_of(c).ok().flatten() == Some(i) && new_in.field(i).name() == &c.name,
                    _ => false,
                })
                && exprs.iter().zip(new_in.fields()).all(|(e, f)| e.output_name() == f.name())
            {
                // the projection may still requalify columns; keep it if qualifiers differ
                let same_q = exprs.iter().enumerate().all(|(i, e)| match e {
                    Expr::Column(c) => c.relation.is_none() || new_in.qualified_field(i).qualifier == c.relation,
                    _ => false,
                });
                if same_q && !matches!(input, LogicalPlan::Values(_)) {
                    // drop qualifiers that only exist above
                    return Ok(input);
                }
            }
            if exprs.is_empty() && !required.is_empty() {
                exprs = p.exprs.clone();
            }
            LogicalPlan::project(Arc::new(input), exprs)
        }
        LogicalPlan::Filter(f) => {
            let in_schema = f.input.schema();
            let mut child_req = required.clone();
            child_req.extend(indices_of(&[&f.predicate], in_schema)?);
            let input = prune_columns(&f.input, &child_req)?;
            let filtered = LogicalPlan::filter(Arc::new(input), f.predicate.clone())?;
            if child_req.len() > required.len() {
                // drop predicate-only columns right after the filter
                let pos: BTreeSet<usize> = child_req
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| required.contains(c))
                    .map(|(i, _)| i)
                    .collect();
                return project_columns(filtered, &pos);
            }
            Ok(filtered)
        }
        LogicalPlan::Aggregate(a) => {
            let ng = a.group_by.len();
            let aggs: Vec<Expr> = a
                .aggs
                .iter()
                .enumerate()
                .filter(|(i, _)| required.contains(&(ng + i)))
                .map(|(_, e)| e.clone())
                .collect();
            let mut refs: Vec<&Expr> = a.group_by.iter().collect();
            refs.extend(aggs.iter());
            let child_req = indices_of(&refs, a.input.schema())?;
            let input = prune_columns(&a.input, &child_req)?;
            let agg = LogicalPlan::aggregate(Arc::new(input), a.group_by.clone(), aggs.clone())?;
            // re-map required output positions
            let mut keep = BTreeSet::new();
            let mut pos = ng;
            for (i, _) in a.aggs.iter().enumerate() {
                if required.contains(&(ng + i)) {
                    keep.insert(pos);
                    pos += 1;
                }
            }
            for g in 0..ng {
                if required.contains(&g) {
                    keep.insert(g);
                }
            }
            project_columns(agg, &keep)
        }
        LogicalPlan::Join(j) => {
            let nl = j.left.schema().len();
            let mut lreq = BTreeSet::new();
            let mut rreq = BTreeSet::new();
            let semi = matches!(j.join_type, JoinType::Semi | JoinType::Anti);
            for &i in required {
                if i < nl {
                    lreq.insert(i);
                } else if !semi {
                    rreq.insert(i - nl);
                }
            }
            let lrefs: Vec<&Expr> = j.on.iter().map(|(l, _)| l).collect();
            let rrefs: Vec<&Expr> = j.on.iter().map(|(_, r)| r).collect();
            lreq.extend(indices_of(&lrefs, j.left.schema())?);
            rreq.extend(indices_of(&rrefs, j.right.schema())?);
            if let Some(f) = &j.filter {
                lreq.extend(indices_of(&[f], j.left.schema())?);
                rreq.extend(indices_of(&[f], j.right.schema())?);
            }
            let left = prune_columns(&j.left, &lreq)?;
            let right = prune_columns(&j.right, &rreq)?;
            let joined =
                LogicalPlan::join(Arc::new(left), Arc::new(right), j.on.clone(), j.filter.clone(), j.join_type)?;
            // map required positions into the new join output
            let lpos: Vec<usize> = lreq.iter().copied().collect();
            let rpos: Vec<usize> = rreq.iter().copied().collect();
            let mut keep = BTreeSet::new();
            for &i in required {
                if i < nl {
                    keep.insert(lpos.iter().position(|&x| x == i).unwrap());
                } else if !semi {
                    keep.insert(lpos.len() + rpos.iter().position(|&x| x == i - nl).unwrap());
                }
            }
            project_columns(joined, &keep)
        }
        LogicalPlan::Sort(s) => {
            let mut child_req = required.clone();
            let refs: Vec<&Expr> = s.exprs.iter().map(|e| &e.expr).collect();
            child_req.extend(indices_of(&refs, s.input.schema())?);
            let input = prune_columns(&s.input, &child_req)?;
            let sorted = LogicalPlan::sort(Arc::new(input), s.exprs.clone(), s.fetch)?;
            if child_req.len() > required.len() {
                let pos: BTreeSet<usize> = child_req
                    .iter()
                    .enumerate()
                    .filter(|(_, c)| required.contains(c))
                    .map(|(i, _)| i)
                    .collect();
                return project_columns(sorted, &pos);
            }
            Ok(sorted)
        }
        LogicalPlan::Limit(l) => {
            let input = prune_columns(&l.input, required)?;
            Ok(LogicalPlan::limit(Arc::new(input), l.skip, l.fetch))
        }
        LogicalPlan::SubqueryAlias(sa) => {
            let input = prune_columns(&sa.input, required)?;
            Ok(LogicalPlan::subquery_alias(Arc::new(input), &sa.alias))
        }
        LogicalPlan::Union(u) => {
            let inputs = u
                .inputs
                .iter()
                .map(|i| prune_columns(i, required).map(Arc::new))
                .collect::<Result<Vec<_>>>()?;
            LogicalPlan::union(inputs)
        }
        LogicalPlan::Window(w) => prune_window(w, required),
        LogicalPlan::Unnest(u) => prune_unnest(u, required),
        LogicalPlan::RecursiveQuery(r) => {
            // the recursive term reads every column of the work table
            let all: BTreeSet<usize> = (0..r.schema.len()).collect();
            let q = RecursiveQuery {
                static_term: Arc::new(prune_columns(&r.static_term, &all)?),
                recursive_term: Arc::new(prune_columns(&r.recursive_term, &all)?),
                ..r.clone()
            };
            project_columns(LogicalPlan::RecursiveQuery(q), required)
        }
        LogicalPlan::Values(v) => {
            let keep: Vec<usize> = required.iter().copied().collect();
            if keep.len() == v.schema.len() {
                return Ok(plan.clone());
            }
            let schema = Arc::new(v.schema.arrow_schema().project(&keep)?);
            let batches = v.batches.iter().map(|b| b.project(&keep)).collect::<Result<Vec<_>, _>>()?;
            Ok(LogicalPlan::values(schema, batches))
        }
    }
}

/// An unnest keeps all its expressions (it multiplies rows even when its
/// elements are not read); the input only needs the columns read above and by them.
fn prune_unnest(u: &crate::logical::Unnest, required: &BTreeSet<usize>) -> Result<LogicalPlan> {
    let n_in = u.input.schema().len();
    let mut child_req: BTreeSet<usize> = required.iter().copied().filter(|&i| i < n_in).collect();
    let refs: Vec<&Expr> = u.exprs.iter().collect();
    child_req.extend(indices_of(&refs, u.input.schema())?);
    let input = prune_columns(&u.input, &child_req)?;
    let unnest = LogicalPlan::unnest(Arc::new(input), u.exprs.clone(), u.outputs.clone(), u.keep_empty)?;
    let positions: Vec<usize> = child_req.iter().copied().collect();
    let mut keep: BTreeSet<usize> = required
        .iter()
        .filter(|&&i| i < n_in)
        .map(|i| positions.iter().position(|x| x == i).unwrap())
        .collect();
    keep.extend(required.iter().filter(|&&i| i >= n_in).map(|i| positions.len() + (i - n_in)));
    project_columns(unnest, &keep)
}

/// Drop window expressions nobody reads (and the window itself if none is).
fn prune_window(w: &Window, required: &BTreeSet<usize>) -> Result<LogicalPlan> {
    let n_in = w.input.schema().len();
    let kept: Vec<usize> = (0..w.exprs.len()).filter(|i| required.contains(&(n_in + i))).collect();
    let exprs: Vec<Expr> = kept.iter().map(|&i| w.exprs[i].clone()).collect();
    let mut child_req: BTreeSet<usize> = required.iter().copied().filter(|&i| i < n_in).collect();
    if exprs.is_empty() {
        return prune_columns(&w.input, &child_req);
    }
    let refs: Vec<&Expr> = exprs.iter().collect();
    child_req.extend(indices_of(&refs, w.input.schema())?);
    let input = prune_columns(&w.input, &child_req)?;
    let window = LogicalPlan::window(Arc::new(input), exprs)?;
    let positions: Vec<usize> = child_req.iter().copied().collect();
    let mut keep: BTreeSet<usize> = required
        .iter()
        .filter(|&&i| i < n_in)
        .map(|i| positions.iter().position(|x| x == i).unwrap())
        .collect();
    keep.extend((0..kept.len()).map(|k| positions.len() + k));
    project_columns(window, &keep)
}

// ---------------------------------------------------------------------------
// semi / anti join pushdown
// ---------------------------------------------------------------------------

/// Move selective semi/anti joins below inner joins, next to the relation
/// whose columns they test, so they shrink the input of the other joins
/// (e.g. `o_orderkey IN (<57 orders>)` is applied to `orders` before
/// `orders` is joined with `lineitem`).
fn push_down_semi_joins(plan: &LogicalPlan) -> Result<LogicalPlan> {
    let plan = map_inputs(plan, &mut |p| push_down_semi_joins(p))?;
    if let LogicalPlan::Join(j) = &plan {
        if matches!(j.join_type, JoinType::Semi | JoinType::Anti) {
            if let Some(p) = try_push_semi(j)? {
                return Ok(p);
            }
        }
    }
    Ok(plan)
}

fn semi_left_refs(j: &Join) -> Vec<Column> {
    let ls = j.left.schema();
    let mut refs: Vec<Column> = j.on.iter().flat_map(|(l, _)| l.column_refs()).collect();
    if let Some(f) = &j.filter {
        refs.extend(f.column_refs().into_iter().filter(|c| ls.has_column(c)));
    }
    refs
}

fn try_push_semi(j: &Join) -> Result<Option<LogicalPlan>> {
    let refs = semi_left_refs(j);
    if refs.is_empty() {
        return Ok(None);
    }
    let right_est = crate::physical::planner::estimate_rows(&j.right);
    let rebuild_semi = |left: Arc<LogicalPlan>| -> Result<LogicalPlan> {
        let semi = LogicalPlan::join(left, j.right.clone(), j.on.clone(), j.filter.clone(), j.join_type)?;
        Ok(match &semi {
            LogicalPlan::Join(sj) => try_push_semi(sj)?.unwrap_or(semi),
            _ => semi,
        })
    };
    match j.left.as_ref() {
        LogicalPlan::Join(inner) if inner.join_type == JoinType::Inner && !inner.on.is_empty() => {
            let in_a = refs.iter().all(|c| inner.left.schema().has_column(c));
            let in_b = refs.iter().all(|c| inner.right.schema().has_column(c));
            // only worth it when the semi join acts as a reducer of that side
            if in_a && right_est < crate::physical::planner::estimate_rows(&inner.left) {
                let a = rebuild_semi(inner.left.clone())?;
                return Ok(Some(LogicalPlan::join(
                    Arc::new(a),
                    inner.right.clone(),
                    inner.on.clone(),
                    inner.filter.clone(),
                    JoinType::Inner,
                )?));
            }
            if in_b && right_est < crate::physical::planner::estimate_rows(&inner.right) {
                let b = rebuild_semi(inner.right.clone())?;
                return Ok(Some(LogicalPlan::join(
                    inner.left.clone(),
                    Arc::new(b),
                    inner.on.clone(),
                    inner.filter.clone(),
                    JoinType::Inner,
                )?));
            }
            Ok(None)
        }
        LogicalPlan::Filter(f) => {
            let pushed = rebuild_semi(f.input.clone())?;
            if matches!(&pushed, LogicalPlan::Join(pj) if Arc::ptr_eq(&pj.left, &f.input)) {
                return Ok(None);
            }
            Ok(Some(LogicalPlan::filter(Arc::new(pushed), f.predicate.clone())?))
        }
        _ => Ok(None),
    }
}
