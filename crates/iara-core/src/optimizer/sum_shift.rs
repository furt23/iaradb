//! `SUM(x + c)` as `SUM(x) + c * COUNT(x)` (and `SUM(x - c)` alike) for
//! integer and decimal `x`, when several such sums share their `x`: the
//! aggregation then keeps two states instead of one per sum and evaluates
//! no expression per row (`SUM(w + 1), ..., SUM(w + 89)` over 100M rows).
//! Exact for these types; empty and all-NULL groups stay NULL.

use std::sync::Arc;

use crate::error::Result;
use crate::expr::{AggFunc, Expr, Operator};
use crate::logical::{Aggregate, LogicalPlan};
use crate::scalar::Scalar;

/// `(x, c, negate)` of `SUM(x + c)` / `SUM(c + x)` / `SUM(x - c)`.
fn shifted_sum(e: &Expr) -> Option<(Expr, Scalar, bool)> {
    let Expr::Agg { func: AggFunc::Sum, args, distinct: false, filter: None, order_by } = e.unalias_ref() else { return None };
    if !order_by.is_empty() || args.len() != 1 {
        return None;
    }
    let Expr::Binary { left, op, right } = &args[0] else { return None };
    let (x, c, negate) = match (left.as_ref(), op, right.as_ref()) {
        (x, Operator::Plus, Expr::Literal(c)) | (Expr::Literal(c), Operator::Plus, x) => (x, c, false),
        (x, Operator::Minus, Expr::Literal(c)) => (x, c, true),
        _ => return None,
    };
    let exact = |t: &arrow::datatypes::DataType| t.is_integer() || matches!(t, arrow::datatypes::DataType::Decimal128(..));
    if c.is_null() || !exact(c.data_type()) || x.contains_agg() || matches!(x, Expr::Literal(_)) {
        return None;
    }
    Some((x.clone(), c.clone(), negate))
}

/// Rewrite one aggregation (None: nothing to rewrite).
pub fn rewrite(a: &Aggregate) -> Result<Option<LogicalPlan>> {
    let input_schema = a.input.schema();
    let shifted: Vec<Option<(Expr, Scalar, bool)>> = a
        .aggs
        .iter()
        .map(|e| {
            shifted_sum(e).filter(|(x, ..)| x.data_type(input_schema).is_ok_and(|t| t.is_integer() || matches!(t, arrow::datatypes::DataType::Decimal128(..))))
        })
        .collect();
    // worth it when at least two sums share their argument
    let mut bases: Vec<Expr> = vec![];
    for (x, ..) in shifted.iter().flatten() {
        if !bases.contains(x) {
            bases.push(x.clone());
        }
    }
    let shared = |x: &Expr| shifted.iter().flatten().filter(|s| &s.0 == x).count() >= 2;
    if !bases.iter().any(shared) {
        return Ok(None);
    }
    let mut aggs: Vec<Expr> = vec![];
    // index in `aggs` of each original aggregate (when kept), or of the base sum and count
    enum Out {
        Kept(usize),
        Shifted { sum: usize, count: usize, c: Scalar, negate: bool },
    }
    let mut outs = vec![];
    for (e, s) in a.aggs.iter().zip(&shifted) {
        match s {
            Some((x, c, negate)) if shared(x) => {
                let mut slot = |agg: Expr| match aggs.iter().position(|a| a == &agg) {
                    Some(i) => i,
                    None => {
                        aggs.push(agg);
                        aggs.len() - 1
                    }
                };
                let sum = slot(Expr::Agg { func: AggFunc::Sum, args: vec![x.clone()], distinct: false, filter: None, order_by: vec![] });
                let count = slot(Expr::Agg { func: AggFunc::Count, args: vec![x.clone()], distinct: false, filter: None, order_by: vec![] });
                outs.push(Out::Shifted { sum, count, c: c.clone(), negate: *negate });
            }
            _ => {
                aggs.push(e.clone());
                outs.push(Out::Kept(aggs.len() - 1));
            }
        }
    }
    let k = a.group_by.len();
    let new_agg = LogicalPlan::aggregate(a.input.clone(), a.group_by.clone(), aggs)?;
    let ns = new_agg.schema().clone();
    let mut exprs: Vec<Expr> = (0..k).map(|i| Expr::Column(ns.column(i))).collect();
    for (i, o) in outs.iter().enumerate() {
        let field = a.schema.qualified_field(k + i);
        let e = match o {
            Out::Kept(j) => Expr::Column(ns.column(k + j)),
            Out::Shifted { sum, count, c, negate } => {
                let shift = Expr::Binary { left: Box::new(Expr::Literal(c.clone())), op: Operator::Multiply, right: Box::new(Expr::Column(ns.column(k + count))) };
                let op = if *negate { Operator::Minus } else { Operator::Plus };
                let v = Expr::Binary { left: Box::new(Expr::Column(ns.column(k + sum))), op, right: Box::new(shift) };
                Expr::Cast { expr: Box::new(v), to: field.field.data_type().clone(), try_cast: false }
            }
        };
        exprs.push(e.alias(field.field.name().clone()));
    }
    let plan = LogicalPlan::project(Arc::new(new_agg), exprs)?;
    // the aggregation's columns, as its consumers know them
    let same = plan.schema().fields().len() == a.schema.fields().len()
        && plan.schema().fields().iter().zip(a.schema.fields()).all(|(x, y)| x.column() == y.column() && x.field.data_type() == y.field.data_type());
    Ok(same.then_some(plan))
}
