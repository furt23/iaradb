//! Eager aggregation: an aggregation over an inner join whose aggregates all
//! read one side pre-aggregates that side by its join keys (and the grouping
//! columns it holds) before the join, and finishes over the joined groups.
//!
//! `SELECT c_name, count(*), sum(o_totalprice) FROM customer JOIN orders ON
//! c_custkey = o_custkey GROUP BY c_custkey, c_name` joins 150M orders and
//! groups them by wide string keys; pre-aggregated, the join sees one row per
//! customer and the final grouping a tenth of the rows. Only for aggregates
//! that combine (`count`, `sum`, `min`, `max`, `avg`, `count_if`,
//! `bool_and/or`), and when the estimates say the join keeps most rows of the
//! pre-aggregated side and that side has several rows per join key.

use std::collections::BTreeSet;
use std::sync::Arc;

use arrow::datatypes::DataType;

use super::rewrite_columns;
use crate::error::Result;
use crate::expr::{AggFunc, Expr, Operator};
use crate::logical::{Aggregate, Join, JoinType, LogicalPlan};
use crate::physical::planner::{estimate_rows, expr_ndv};

/// Pre-aggregate when the pushed side has at least this many rows per group.
const MIN_ROWS_PER_GROUP: f64 = 4.0;
/// Never pre-aggregate into more than this many times the groups of the
/// aggregation above the join: with few final groups that aggregation is
/// cheap, and a wide pre-aggregation costs more than the join rows it saves.
const MAX_GROUP_GROWTH: f64 = 8.0;

/// The join under `plan` (through projections and aliases), and each column
/// of `plan` as an expression over the join's columns.
fn join_below(plan: &LogicalPlan) -> Option<(&LogicalPlan, Vec<Expr>)> {
    match plan {
        LogicalPlan::Join(j) => {
            // every column must name itself alone (no ambiguous duplicates)
            let cols: Vec<Expr> = (0..j.schema.len()).map(|i| Expr::Column(j.schema.column(i))).collect();
            let unique = cols.iter().enumerate().all(|(i, c)| match c {
                Expr::Column(c) => matches!(j.schema.maybe_index_of(c), Ok(Some(k)) if k == i),
                _ => false,
            });
            unique.then_some((plan, cols))
        }
        LogicalPlan::Projection(p) => {
            let (j, inner) = join_below(&p.input)?;
            let s = p.input.schema();
            let exprs = p
                .exprs
                .iter()
                .map(|e| rewrite_columns(e.unalias_ref(), &|c| Some(inner[s.maybe_index_of(c).ok()??].clone())))
                .collect::<Option<Vec<_>>>()?;
            Some((j, exprs))
        }
        LogicalPlan::SubqueryAlias(a) => join_below(&a.input),
        _ => None,
    }
}

/// How the final aggregation rebuilds one original aggregate from the partial columns.
enum Output {
    /// one final aggregate
    One(usize),
    /// `avg`: final sum / final count
    Mean { sum: usize, count: usize },
}

/// The partial aggregates of one original aggregate and how they finish.
struct Split {
    partials: Vec<Expr>,
    /// final aggregate function over each partial
    finals: Vec<AggFunc>,
    mean: bool,
}

fn split(func: AggFunc, args: &[Expr], filter: &Option<Box<Expr>>, arg_type: Option<&DataType>) -> Option<Split> {
    let agg = |func: AggFunc, args: Vec<Expr>| Expr::Agg { func, args, distinct: false, filter: filter.clone(), order_by: vec![] };
    let one = |f: AggFunc, fin: AggFunc| Split { partials: vec![agg(f, args.to_vec())], finals: vec![fin], mean: false };
    Some(match func {
        AggFunc::Count | AggFunc::CountIf => one(func, AggFunc::Sum),
        AggFunc::Sum | AggFunc::Min | AggFunc::Max | AggFunc::BoolAnd | AggFunc::BoolOr => one(func, func),
        AggFunc::Mean if args.len() == 1 => {
            // decimals sum exactly (as `avg` does); everything else as f64
            let x = match arg_type? {
                DataType::Decimal128(..) => args[0].clone(),
                t if t.is_numeric() || matches!(t, DataType::Null | DataType::Boolean) => args[0].clone().cast(DataType::Float64),
                _ => return None,
            };
            Split {
                partials: vec![agg(AggFunc::Sum, vec![x]), agg(AggFunc::Count, args.to_vec())],
                finals: vec![AggFunc::Sum, AggFunc::Sum],
                mean: true,
            }
        }
        _ => return None,
    })
}

/// Rewrite one aggregation (None: it stays as it is).
pub fn rewrite(a: &Aggregate) -> Result<Option<LogicalPlan>> {
    // a plan this rule cannot build is not an error: the aggregation stays
    Ok(try_rewrite(a).ok().flatten())
}

fn try_rewrite(a: &Aggregate) -> Result<Option<LogicalPlan>> {
    // a global count over an empty join is 0, the sum of no partial counts NULL
    if a.group_by.is_empty() {
        return Ok(None);
    }
    let Some((join_plan, cols)) = join_below(&a.input) else { return Ok(None) };
    let LogicalPlan::Join(j) = join_plan else { return Ok(None) };
    if j.join_type != JoinType::Inner || j.on.is_empty() {
        return Ok(None);
    }
    let in_schema = a.input.schema();
    let to_join = |e: &Expr| rewrite_columns(e, &|c| Some(cols[in_schema.maybe_index_of(c).ok()??].clone()));
    let nl = j.left.schema().len();
    // (left, right) columns an expression over the join reads
    let sides = |e: &Expr| -> Option<(bool, bool)> {
        let mut s = (false, false);
        for c in e.column_refs() {
            let i = j.schema.maybe_index_of(&c).ok()??;
            if i < nl { s.0 = true } else { s.1 = true }
        }
        Some(s)
    };

    // aggregates: all must read one side (or no column, like count(*))
    let mut aggs = vec![];
    let mut agg_side: Option<bool> = None; // Some(true): right
    for e in &a.aggs {
        let Expr::Agg { func, args, distinct: false, filter, order_by } = e.unalias_ref() else { return Ok(None) };
        if !order_by.is_empty() || e.contains_subquery() {
            return Ok(None);
        }
        let args = args.iter().map(&to_join).collect::<Option<Vec<_>>>();
        let filter = match filter {
            Some(f) => to_join(f).map(|f| Some(Box::new(f))),
            None => Some(None),
        };
        let (Some(args), Some(filter)) = (args, filter) else { return Ok(None) };
        let mut s = (false, false);
        for x in args.iter().chain(filter.as_deref()) {
            let Some((l, r)) = sides(x) else { return Ok(None) };
            s = (s.0 | l, s.1 | r);
        }
        let side = match s {
            (true, true) => return Ok(None),
            (true, false) => Some(false),
            (false, true) => Some(true),
            (false, false) => None,
        };
        if let Some(side) = side {
            if agg_side.is_some_and(|x| x != side) {
                return Ok(None);
            }
            agg_side = Some(side);
        }
        aggs.push((*func, args, filter));
    }
    // aggregates that read no column go with the larger side
    let right = match agg_side {
        Some(r) => r,
        None => estimate_rows(&j.right) >= estimate_rows(&j.left),
    };
    let pushed = if right { &j.right } else { &j.left };

    // grouping keys over the join: each reads one side
    let groups = a.group_by.iter().map(&to_join).collect::<Option<Vec<_>>>();
    let Some(groups) = groups else { return Ok(None) };
    if groups.iter().any(|g| g.contains_subquery() || sides(g).is_none_or(|s| s.0 && s.1)) {
        return Ok(None);
    }

    // the pushed side groups by the columns of it the join and the grouping read
    let on_side = |i: usize| if right { i >= nl } else { i < nl };
    let mut key_cols = BTreeSet::new();
    let mut extra_cols = BTreeSet::new();
    for (l, r) in &j.on {
        for c in (if right { r } else { l }).column_refs() {
            key_cols.insert(j.schema.index_of(&c)?);
        }
    }
    for e in groups.iter().chain(j.filter.as_ref()) {
        for c in e.column_refs() {
            let i = j.schema.index_of(&c)?;
            if on_side(i) && !key_cols.contains(&i) {
                extra_cols.insert(i);
            }
        }
    }
    if !worth_it(a, join_plan, j, right, &extra_cols) {
        return Ok(None);
    }

    let pushed_schema = pushed.schema();
    let offset = if right { nl } else { 0 };
    let group_exprs: Vec<Expr> = key_cols.iter().chain(&extra_cols).map(|&i| Expr::Column(pushed_schema.column(i - offset))).collect();
    let mut partials = vec![];
    let mut finals = vec![];
    let mut outputs = vec![];
    for (func, args, filter) in &aggs {
        let arg_type = match args.first() {
            Some(x) => Some(x.data_type(&j.schema)?),
            None => None,
        };
        let Some(s) = split(*func, args, filter, arg_type.as_ref()) else { return Ok(None) };
        let first = finals.len();
        for (p, f) in s.partials.into_iter().zip(s.finals) {
            let name = format!("__pa{}", partials.len());
            finals.push(Expr::Agg { func: f, args: vec![Expr::Column(crate::schema::Column::from_name(&name))], distinct: false, filter: None, order_by: vec![] }.alias(format!("__fa{}", finals.len())));
            partials.push(p.alias(name));
        }
        outputs.push(if s.mean { Output::Mean { sum: first, count: first + 1 } } else { Output::One(first) });
    }

    let partial = LogicalPlan::aggregate(pushed.clone(), group_exprs, partials)?;
    let partial = Arc::new(super::rewrite_aggregate(&partial)?);
    let (left, right_in) = if right { (j.left.clone(), partial) } else { (partial, j.right.clone()) };
    let new_join = LogicalPlan::join(left, right_in, j.on.clone(), j.filter.clone(), JoinType::Inner)?;
    let k = groups.len();
    let fin = LogicalPlan::aggregate(Arc::new(new_join), groups, finals)?;
    let fs = fin.schema().clone();

    // the original aggregation's columns, as its consumers know them
    let mut exprs = Vec::with_capacity(a.schema.len());
    for i in 0..k {
        let orig = a.schema.qualified_field(i);
        let e = Expr::Column(fs.column(i));
        exprs.push(if orig.qualifier.is_none() { e.alias(orig.name()) } else { e });
    }
    for (i, o) in outputs.iter().enumerate() {
        let orig = a.schema.qualified_field(k + i);
        let col = |n: usize| Expr::Column(fs.column(k + n));
        let e = match o {
            Output::One(n) => col(*n),
            Output::Mean { sum, count } => Expr::Binary {
                left: Box::new(col(*sum).cast(DataType::Float64)),
                op: Operator::Divide,
                right: Box::new(col(*count).cast(DataType::Float64)),
            },
        };
        let want = orig.field.data_type();
        let e = if &e.data_type(&fs)? == want { e } else { e.cast(want.clone()) };
        exprs.push(e.alias(orig.name()));
    }
    let plan = LogicalPlan::project(Arc::new(fin), exprs)?;
    let same = plan.schema().len() == a.schema.len()
        && plan.schema().fields().iter().zip(a.schema.fields()).all(|(x, y)| x.column() == y.column() && x.field.data_type() == y.field.data_type());
    Ok(same.then_some(plan))
}

/// The join keeps most rows of the pushed side (a foreign key into an
/// unfiltered table), and that side has several rows per group: at most one
/// group per distinct join key of the other side, times the distinct values
/// of the other columns it groups by. And those groups are not many more
/// than the final ones (`GROUP BY c_mktsegment` over orders joined by
/// customer name keeps the 5 segments, not millions of names).
fn worth_it(a: &Aggregate, join_plan: &LogicalPlan, j: &Join, right: bool, extra_cols: &BTreeSet<usize>) -> bool {
    let (pushed, other) = if right { (&j.right, &j.left) } else { (&j.left, &j.right) };
    let rows = estimate_rows(pushed);
    let other_rows = estimate_rows(other);
    if estimate_rows(join_plan) < rows * 0.5 {
        return false;
    }
    let mut keys = 1.0f64;
    for (l, r) in &j.on {
        let (pk, ok) = if right { (r, l) } else { (l, r) };
        let np = expr_ndv(pushed, pk).unwrap_or(rows);
        let no = expr_ndv(other, ok).unwrap_or(other_rows);
        keys *= np.min(no).max(1.0);
    }
    let mut groups = keys.min(other_rows.max(1.0));
    let offset = if right { j.left.schema().len() } else { 0 };
    for &i in extra_cols {
        let c = Expr::Column(pushed.schema().column(i - offset));
        groups *= expr_ndv(pushed, &c).unwrap_or(rows).max(1.0);
    }
    let pushed_groups = groups.min(rows);
    // unknown final groups (a computed key): no limit
    let top_groups = a.group_by.iter().map(|g| expr_ndv(&a.input, g)).product::<Option<f64>>();
    if top_groups.is_some_and(|top| pushed_groups > MAX_GROUP_GROWTH * top.max(1.0)) {
        return false;
    }
    rows >= MIN_ROWS_PER_GROUP * pushed_groups
}
