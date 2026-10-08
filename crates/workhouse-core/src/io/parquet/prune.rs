//! Row-group pruning with min/max statistics of pushed-down predicates.

use arrow::array::{Array, BooleanArray};
use arrow::compute::kernels::cmp;
use arrow::compute::{and, or};
use arrow::datatypes::Schema;
use parquet::arrow::arrow_reader::statistics::StatisticsConverter;
use parquet::file::metadata::RowGroupMetaData;

use super::file::ParquetFile;
use crate::expr::{Expr, Operator};
use crate::scalar::Scalar;

/// Which row groups of `file` may hold rows passing all `filters`.
pub fn keep_row_groups(filters: &[Expr], schema: &Schema, file: &ParquetFile) -> Vec<bool> {
    let rgs = file.meta.metadata().row_groups();
    let mut keep = vec![true; rgs.len()];
    for flt in filters {
        if let Some(mask) = prune_one(flt, schema, file, rgs) {
            for (i, k) in keep.iter_mut().enumerate() {
                // null => statistics unknown => keep
                if mask.is_valid(i) && !mask.value(i) {
                    *k = false;
                }
            }
        }
    }
    keep
}

/// Evaluate one pruning predicate against row-group statistics.
/// Returns `None` when the predicate cannot be used for pruning.
fn prune_one(e: &Expr, schema: &Schema, file: &ParquetFile, rgs: &[RowGroupMetaData]) -> Option<BooleanArray> {
    match e {
        Expr::Binary { left, op: Operator::Or, right } => {
            let l = prune_one(left, schema, file, rgs)?;
            let r = prune_one(right, schema, file, rgs)?;
            or(&l, &r).ok()
        }
        Expr::Binary { left, op: Operator::And, right } => {
            match (prune_one(left, schema, file, rgs), prune_one(right, schema, file, rgs)) {
                (Some(l), Some(r)) => and(&l, &r).ok(),
                (Some(x), None) | (None, Some(x)) => Some(x),
                _ => None,
            }
        }
        Expr::Binary { left, op, right } if op.is_comparison() => {
            let (col, lit, op) = match (left.as_ref(), right.as_ref()) {
                (Expr::Column(c), Expr::Literal(s)) => (c, s, *op),
                (Expr::Literal(s), Expr::Column(c)) => (c, s, op.swap()),
                (Expr::Cast { expr, to, .. }, Expr::Literal(s)) => match expr.as_ref() {
                    // numeric -> numeric casts preserve order (the literal is cast back exactly)
                    Expr::Column(c) => {
                        let ft = schema.field_with_name(&c.name).ok()?.data_type();
                        if !(crate::types::is_numeric(ft) && crate::types::is_numeric(to)) {
                            return None;
                        }
                        (c, s, *op)
                    }
                    _ => return None,
                },
                _ => return None,
            };
            let conv = StatisticsConverter::try_new(&col.name, schema, file.meta.parquet_schema()).ok()?;
            let mins = conv.row_group_mins(rgs.iter()).ok()?;
            let maxs = conv.row_group_maxes(rgs.iter()).ok()?;
            let lit: Scalar = lit.cast_exact(mins.data_type())?;
            if lit.is_null() {
                return None;
            }
            let r = match op {
                Operator::Eq => and(&cmp::lt_eq(&mins, &lit).ok()?, &cmp::gt_eq(&maxs, &lit).ok()?).ok()?,
                Operator::Lt => cmp::lt(&mins, &lit).ok()?,
                Operator::LtEq => cmp::lt_eq(&mins, &lit).ok()?,
                Operator::Gt => cmp::gt(&maxs, &lit).ok()?,
                Operator::GtEq => cmp::gt_eq(&maxs, &lit).ok()?,
                Operator::NotEq => {
                    let all_eq = and(&cmp::eq(&mins, &lit).ok()?, &cmp::eq(&maxs, &lit).ok()?).ok()?;
                    arrow::compute::not(&all_eq).ok()?
                }
                _ => return None,
            };
            Some(r)
        }
        Expr::InList { expr, list, negated: false } => {
            let mut acc: Option<BooleanArray> = None;
            for item in list {
                let m = prune_one(&expr.as_ref().clone().eq(item.clone()), schema, file, rgs)?;
                acc = Some(match acc {
                    None => m,
                    Some(a) => or(&a, &m).ok()?,
                });
            }
            acc
        }
        _ => None,
    }
}
