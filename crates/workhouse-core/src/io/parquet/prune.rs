//! Pruning with min/max statistics of pushed-down predicates: the row groups
//! of a file (its Parquet footer) and the files of a Delta table (the
//! statistics in its log). Both give per-unit bounds through [`Bounds`].

use arrow::array::{Array, ArrayRef, BooleanArray, new_null_array};
use arrow::compute::kernels::cmp;
use arrow::compute::{and, or};
use arrow::datatypes::{DataType, Schema};
use parquet::arrow::arrow_reader::statistics::StatisticsConverter;
use parquet::file::metadata::RowGroupMetaData;

use super::file::ParquetFile;
use crate::delta::stats::FileStats;
use crate::expr::{Expr, Operator};
use crate::scalar::Scalar;

/// Bounds of the values of columns in each of a number of units (row groups
/// or files). A null entry, or `None`, means the bound is unknown.
pub trait Bounds {
    /// Smallest value of the column in each unit.
    fn mins(&self, column: &str) -> Option<ArrayRef>;
    fn maxs(&self, column: &str) -> Option<ArrayRef>;
    /// Number of nulls of the column in each unit.
    fn null_counts(&self, _column: &str) -> Option<Vec<Option<u64>>> {
        None
    }
    /// Number of rows of each unit.
    fn row_counts(&self) -> Option<Vec<Option<u64>>> {
        None
    }
}

/// The row groups of a file.
struct RowGroups<'a> {
    schema: &'a Schema,
    file: &'a ParquetFile,
    rgs: &'a [RowGroupMetaData],
}

impl RowGroups<'_> {
    fn converter(&self, column: &str) -> Option<StatisticsConverter<'_>> {
        StatisticsConverter::try_new(column, self.schema, self.file.meta.parquet_schema()).ok()
    }
}

impl Bounds for RowGroups<'_> {
    fn mins(&self, column: &str) -> Option<ArrayRef> {
        self.converter(column)?.row_group_mins(self.rgs.iter()).ok()
    }

    fn maxs(&self, column: &str) -> Option<ArrayRef> {
        self.converter(column)?.row_group_maxes(self.rgs.iter()).ok()
    }
}

/// The files of a Delta table, by the statistics of their `add` actions.
struct Files<'a> {
    schema: &'a Schema,
    stats: &'a [Option<FileStats>],
}

impl Files<'_> {
    /// One value per file (null where unknown) as an array of the column's type.
    fn column(&self, name: &str, pick: impl Fn(&FileStats) -> Option<&Scalar>) -> Option<ArrayRef> {
        // statistics are keyed by dotted path; floats are left out (NaN is not part of the bounds)
        let ty = self.schema.field_with_name(name).ok()?.data_type();
        if name.contains('.') || matches!(ty, DataType::Float16 | DataType::Float32 | DataType::Float64) {
            return None;
        }
        let values: Vec<Option<&Scalar>> = self.stats.iter().map(|s| s.as_ref().and_then(&pick)).collect();
        let native = values.iter().flatten().next()?.data_type().clone();
        let parts: Vec<ArrayRef> = values.iter().map(|v| v.map_or_else(|| new_null_array(&native, 1), |v| v.array().clone())).collect();
        let parts: Vec<&dyn Array> = parts.iter().map(|a| a.as_ref()).collect();
        let all = arrow::compute::concat(&parts).ok()?;
        if &native == ty { Some(all) } else { arrow::compute::cast(&all, ty).ok() }
    }
}

impl Bounds for Files<'_> {
    fn mins(&self, column: &str) -> Option<ArrayRef> {
        self.column(column, |s| s.min.get(column))
    }

    fn maxs(&self, column: &str) -> Option<ArrayRef> {
        self.column(column, |s| s.max.get(column))
    }

    fn null_counts(&self, column: &str) -> Option<Vec<Option<u64>>> {
        (!column.contains('.')).then(|| self.stats.iter().map(|s| s.as_ref().and_then(|s| s.null_count.get(column).copied())).collect())
    }

    fn row_counts(&self) -> Option<Vec<Option<u64>>> {
        Some(self.stats.iter().map(|s| s.as_ref().and_then(|s| s.num_records)).collect())
    }
}

/// Which row groups of `file` may hold rows passing all `filters`.
pub fn keep_row_groups(filters: &[Expr], schema: &Schema, file: &ParquetFile) -> Vec<bool> {
    let rgs = file.meta.metadata().row_groups();
    keep(filters, schema, &RowGroups { schema, file, rgs }, rgs.len())
}

/// Which files (by their log statistics, `None`: unknown) may hold rows passing all `filters`.
pub fn keep_files(filters: &[Expr], schema: &Schema, stats: &[Option<FileStats>]) -> Vec<bool> {
    keep(filters, schema, &Files { schema, stats }, stats.len())
}

fn keep(filters: &[Expr], schema: &Schema, bounds: &dyn Bounds, units: usize) -> Vec<bool> {
    let mut keep = vec![true; units];
    for flt in filters {
        if let Some(mask) = prune_one(flt, schema, bounds) {
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

/// Evaluate one pruning predicate against the bounds of the units.
/// Returns `None` when the predicate cannot be used for pruning.
fn prune_one(e: &Expr, schema: &Schema, b: &dyn Bounds) -> Option<BooleanArray> {
    match e {
        Expr::Binary { left, op: Operator::Or, right } => {
            let l = prune_one(left, schema, b)?;
            let r = prune_one(right, schema, b)?;
            or(&l, &r).ok()
        }
        Expr::Binary { left, op: Operator::And, right } => {
            match (prune_one(left, schema, b), prune_one(right, schema, b)) {
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
            let mins = b.mins(&col.name)?;
            let maxs = b.maxs(&col.name)?;
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
                let m = prune_one(&expr.as_ref().clone().eq(item.clone()), schema, b)?;
                acc = Some(match acc {
                    None => m,
                    Some(a) => or(&a, &m).ok()?,
                });
            }
            acc
        }
        Expr::IsNull(e) => {
            let Expr::Column(c) = e.as_ref() else { return None };
            let nulls = b.null_counts(&c.name)?;
            Some(nulls.iter().map(|n| n.map(|n| n > 0)).collect())
        }
        Expr::IsNotNull(e) => {
            let Expr::Column(c) = e.as_ref() else { return None };
            let (nulls, rows) = (b.null_counts(&c.name)?, b.row_counts()?);
            Some(nulls.iter().zip(&rows).map(|(n, r)| Some(r.as_ref()? > n.as_ref()?)).collect())
        }
        _ => None,
    }
}
