//! `COUNT / SUM / AVG (DISTINCT x)` as two aggregations: the first groups by
//! the keys and `x`, so the regular hash aggregation (partitioned, spilling)
//! finds the distinct values instead of a hash set per group; the second
//! groups by the keys and finishes: `COUNT(DISTINCT x)` is `COUNT(x)` over
//! the groups, the other aggregates combine their partial results.
//!
//! `SELECT r, SUM(a), AVG(w), AVG(DISTINCT u) FROM t GROUP BY r` groups by
//! `(r, u)` computing `SUM(a)`, `SUM(w)` and `COUNT(w)`, then by `r` computing
//! `SUM(SUM(a))`, `SUM(SUM(w)) / SUM(COUNT(w))` and `AVG(u)`. Only when all
//! distinct aggregates share their argument and every other aggregate
//! combines (`COUNT`, `SUM`, `MIN`, `MAX`, `AVG` of integers and floats), none
//! with FILTER or ORDER BY.
//!
//! Grouped aggregations whose distinct aggregates have per-group sets keep
//! them: carrying the other aggregates through a grouping by `(r, u)` costs
//! more than the sets while the groups are few (ClickBench Q9: 800 ms split,
//! 450 ms with the sets). A global aggregation has one set, merged from every
//! thread's on one thread: grouping by `u` alone is faster.

use std::sync::Arc;

use arrow::datatypes::DataType;

use crate::error::Result;
use crate::expr::{AggFunc, Expr, Operator, ScalarFunc};
use crate::logical::{Aggregate, LogicalPlan};
use crate::scalar::Scalar;
use crate::schema::{Column, PlanSchema};

/// Name of the distinct argument in the first aggregation.
const VALUE: &str = "__dx";

/// How the second aggregation rebuilds one original aggregate.
enum Out {
    /// `func` over the distinct values
    Key(AggFunc),
    /// `func` over a partial aggregate; `count`: a count, which is 0 (not NULL) over no rows
    Over { func: AggFunc, partial: usize, count: bool },
    /// `avg`: sum of the partial sums over sum of the partial counts
    Mean { sum: usize, count: usize },
}

fn agg(func: AggFunc, args: Vec<Expr>) -> Expr {
    Expr::Agg { func, args, distinct: false, filter: None, order_by: vec![] }
}

/// Index of `e` in `list` (added when missing).
fn slot(list: &mut Vec<Expr>, e: Expr) -> usize {
    list.iter().position(|x| x == &e).unwrap_or_else(|| {
        list.push(e);
        list.len() - 1
    })
}

/// The argument the `COUNT / SUM / AVG (DISTINCT ..)` aggregates share (None:
/// there is none, or they differ).
fn shared_arg(aggs: &[Expr]) -> Option<&Expr> {
    let mut shared: Option<&Expr> = None;
    for e in aggs {
        let Expr::Agg { func: AggFunc::Count | AggFunc::Sum | AggFunc::Mean, args, distinct: true, .. } = e.unalias_ref() else { continue };
        if args.len() != 1 || shared.is_some_and(|x| x != &args[0]) {
            return None;
        }
        shared = Some(&args[0]);
    }
    shared
}

/// How aggregate `e` finishes, with its partial aggregates added to `partials`
/// (None: it does not combine).
fn finish(e: &Expr, x: &Expr, schema: &PlanSchema, partials: &mut Vec<Expr>) -> Option<Out> {
    let Expr::Agg { func, args, distinct, filter: None, order_by } = e.unalias_ref() else { return None };
    if !order_by.is_empty() || args.len() > 1 || e.contains_subquery() || e.contains_outer_ref() {
        return None;
    }
    let arg_type = match args.first() {
        Some(a) => Some(a.data_type(schema).ok()?),
        None => None,
    };
    let typed = arg_type.as_ref().is_some_and(|t| t != &DataType::Null);
    let minmax = matches!(func, AggFunc::Min | AggFunc::Max);
    if *distinct {
        if args.first() == Some(x) && (minmax || matches!(func, AggFunc::Count | AggFunc::Sum | AggFunc::Mean)) {
            return Some(Out::Key(*func));
        }
        // the minimum or maximum of distinct values is the plain one
        if !minmax {
            return None;
        }
    }
    Some(match func {
        AggFunc::Count => Out::Over { func: AggFunc::Sum, partial: slot(partials, agg(AggFunc::Count, args.clone())), count: true },
        AggFunc::Sum | AggFunc::Min | AggFunc::Max if typed => {
            Out::Over { func: *func, partial: slot(partials, agg(*func, args.clone())), count: false }
        }
        AggFunc::Mean if arg_type.as_ref().is_some_and(|t| t.is_integer() || t.is_floating()) => {
            // as `avg` does: the sum in f64
            let a = args[0].clone();
            let a = if arg_type == Some(DataType::Float64) { a } else { a.cast(DataType::Float64) };
            Out::Mean { sum: slot(partials, agg(AggFunc::Sum, vec![a])), count: slot(partials, agg(AggFunc::Count, args.clone())) }
        }
        _ => return None,
    })
}

/// Rewrite one aggregation (None: it stays as it is).
pub fn rewrite(a: &Aggregate) -> Result<Option<LogicalPlan>> {
    // a plan this rule cannot build is not an error: the aggregation stays
    Ok(try_rewrite(a).ok().flatten())
}

/// A distinct aggregate that no per-group set computes.
fn unsupported(e: &Expr, schema: &PlanSchema) -> bool {
    let Expr::Agg { func, args, distinct: true, .. } = e.unalias_ref() else { return false };
    let t = args.first().and_then(|x| x.data_type(schema).ok());
    t.is_none_or(|t| crate::exec::accumulators::create_accumulator(*func, Some(&t), true).is_err())
}

fn try_rewrite(a: &Aggregate) -> Result<Option<LogicalPlan>> {
    let Some(x) = shared_arg(&a.aggs) else { return Ok(None) };
    let schema = a.input.schema();
    if !a.group_by.is_empty() && !a.aggs.iter().any(|e| unsupported(e, schema)) {
        return Ok(None);
    }
    // grouped by `x` already: the values are distinct per group; a constant has one
    let usable = x.data_type(schema).is_ok_and(|t| t != DataType::Null && !crate::nested::is_nested(&t))
        && !x.column_refs().is_empty()
        && !x.contains_agg()
        && !x.contains_subquery()
        && !x.contains_outer_ref()
        && !a.group_by.iter().any(|g| g.unalias_ref() == x);
    if !usable {
        return Ok(None);
    }

    let mut partials = vec![];
    let mut outs = vec![];
    for e in &a.aggs {
        let Some(o) = finish(e, x, schema, &mut partials) else { return Ok(None) };
        outs.push(o);
    }

    // first aggregation: one row per key and value
    let k = a.group_by.len();
    let mut group_by = a.group_by.clone();
    group_by.push(x.clone().alias(VALUE));
    let aggs = partials.into_iter().enumerate().map(|(i, p)| p.alias(format!("__dp{i}"))).collect();
    let first = LogicalPlan::aggregate(a.input.clone(), group_by, aggs)?;
    let first = Arc::new(super::rewrite_aggregate(&first)?);
    let fs = first.schema().clone();

    // second aggregation: one row per key
    let partial = |i: usize| Expr::Column(Column::from_name(format!("__dp{i}")));
    let mut finals = vec![];
    let mut cols = vec![];
    for o in &outs {
        let (func, arg) = match o {
            Out::Key(func) => (*func, Expr::Column(Column::from_name(VALUE))),
            Out::Over { func, partial: p, .. } => (*func, partial(*p)),
            Out::Mean { sum, .. } => (AggFunc::Sum, partial(*sum)),
        };
        let first_col = slot(&mut finals, agg(func, vec![arg]));
        let second_col = match o {
            Out::Mean { count, .. } => Some(slot(&mut finals, agg(AggFunc::Sum, vec![partial(*count)]))),
            _ => None,
        };
        cols.push((first_col, second_col));
    }
    let finals = finals.into_iter().enumerate().map(|(i, f)| f.alias(format!("__df{i}"))).collect();
    let keys = (0..k).map(|i| Expr::Column(fs.column(i))).collect();
    let second = LogicalPlan::aggregate(first, keys, finals)?;
    let ss = second.schema().clone();

    // the original aggregation's columns, as its consumers know them
    let mut exprs: Vec<Expr> = (0..k).map(|i| Expr::Column(ss.column(i))).collect();
    for (i, (o, (c1, c2))) in outs.iter().zip(&cols).enumerate() {
        let orig = a.schema.qualified_field(k + i);
        let col = |n: usize| Expr::Column(ss.column(k + n));
        let e = match (o, c2) {
            // the sum of no counts (a global aggregation of no rows) is NULL
            (Out::Over { count: true, .. }, _) if k == 0 => {
                Expr::Function { func: ScalarFunc::Coalesce, args: vec![col(*c1), Expr::Literal(Scalar::int64(0))] }
            }
            // no non-NULL value has no count: the sum is NULL, and so is the mean
            (Out::Mean { .. }, Some(c2)) => Expr::Binary { left: Box::new(col(*c1)), op: Operator::Divide, right: Box::new(col(*c2).cast(DataType::Float64)) },
            _ => col(*c1),
        };
        let want = orig.field.data_type();
        let e = if &e.data_type(&ss)? == want { e } else { e.cast(want.clone()) };
        exprs.push(e.alias(orig.name()));
    }
    let plan = LogicalPlan::project(Arc::new(second), exprs)?;
    let same = plan.schema().len() == a.schema.len()
        && plan.schema().fields().iter().zip(a.schema.fields()).all(|(x, y)| x.column() == y.column() && x.field.data_type() == y.field.data_type());
    Ok(same.then_some(plan))
}
