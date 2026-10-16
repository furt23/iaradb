//! Filtering while decoding: the columns a scan's filters read are decoded
//! first, and the other columns only for the rows that pass. A selective
//! filter over a wide table (`WHERE CounterID = 62` with 105 columns kept)
//! then decodes a fraction of the data.
//!
//! The filter above the scan still runs (this only drops rows early). When
//! the filters turn out to keep most rows, decoding their columns twice is
//! wasted, so the scan stops filtering early once it has seen enough rows.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use arrow::array::{AsArray, BooleanArray};
use arrow::datatypes::SchemaRef;
use arrow::error::ArrowError;
use arrow::record_batch::RecordBatch;
use parquet::arrow::ProjectionMask;
use parquet::arrow::arrow_reader::{ArrowPredicateFn, RowFilter};
use parquet::schema::types::SchemaDescriptor;

use crate::expr::{Expr, conjunction};
use crate::physical::expr::{PhysExpr, create_physical_expr, null_as_false};
use crate::schema::{Column, PlanSchema};

/// Rows to see before judging the filters' selectivity.
const PROBE_ROWS: u64 = 1 << 20;
/// Keep filtering early while the filters keep at most this share of rows.
const MAX_KEPT_SHARE: f64 = 0.25;

pub struct LateFilter {
    /// columns (of the table, = of the files) the filters read, ascending
    columns: Vec<usize>,
    predicate: Arc<PhysExpr>,
    seen: Arc<AtomicU64>,
    kept: Arc<AtomicU64>,
}

impl LateFilter {
    /// For a scan of `projection` with `filters`: None when the filters read
    /// every projected column (nothing to skip) or cannot be compiled.
    pub fn new(table_schema: &SchemaRef, projection: &[usize], filters: &[Expr]) -> Option<Self> {
        let predicate = conjunction(filters.iter().cloned())?;
        // scan filters name the table's columns; drop their qualifiers
        let predicate = predicate
            .transform_up(&mut |e| match e {
                Expr::Column(c) => Ok(Expr::Column(Column::from_name(c.name))),
                other => Ok(other),
            })
            .ok()?;
        let mut columns = vec![];
        for c in predicate.column_refs() {
            let i = table_schema.index_of(&c.name).ok()?;
            if !columns.contains(&i) {
                columns.push(i);
            }
        }
        columns.sort_unstable();
        if columns.is_empty() || projection.iter().all(|p| columns.contains(p)) {
            return None;
        }
        let schema = PlanSchema::from_arrow(None, &table_schema.project(&columns).ok()?);
        let predicate = Arc::new(create_physical_expr(&predicate, &schema).ok()?);
        Some(Self { columns, predicate, seen: Arc::default(), kept: Arc::default() })
    }

    /// Whether to filter while decoding the next row group.
    pub fn active(&self) -> bool {
        let seen = self.seen.load(Ordering::Relaxed);
        seen < PROBE_ROWS || (self.kept.load(Ordering::Relaxed) as f64) <= seen as f64 * MAX_KEPT_SHARE
    }

    pub fn row_filter(&self, schema: &SchemaDescriptor) -> RowFilter {
        let mask = ProjectionMask::roots(schema, self.columns.iter().copied());
        let (predicate, seen, kept) = (self.predicate.clone(), self.seen.clone(), self.kept.clone());
        let f = ArrowPredicateFn::new(mask, move |batch: RecordBatch| -> Result<BooleanArray, ArrowError> {
            let n = batch.num_rows();
            // an error here is left to the filter above the scan
            let out = match predicate.evaluate_array(&batch) {
                Ok(a) if a.data_type() == &arrow::datatypes::DataType::Boolean => null_as_false(a.as_boolean()),
                _ => BooleanArray::from(vec![true; n]),
            };
            seen.fetch_add(n as u64, Ordering::Relaxed);
            kept.fetch_add(out.true_count() as u64, Ordering::Relaxed);
            Ok(out)
        });
        RowFilter::new(vec![Box::new(f)])
    }
}
