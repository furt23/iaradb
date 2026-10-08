//! In-memory tables.

use std::sync::Arc;

use arrow::datatypes::SchemaRef;
use arrow::record_batch::RecordBatch;

use crate::error::Result;
use crate::exec::pipeline::{MemorySource, Source, apply_limit};
use crate::expr::Expr;
use crate::io::TableProvider;

#[derive(Debug)]
pub struct MemTable {
    schema: SchemaRef,
    batches: Vec<RecordBatch>,
    rows: usize,
    ndv_cache: parking_lot::Mutex<std::collections::HashMap<usize, Option<f64>>>,
}

impl MemTable {
    pub fn new(schema: SchemaRef, batches: Vec<RecordBatch>) -> Self {
        let rows = batches.iter().map(|b| b.num_rows()).sum();
        Self { schema, batches, rows, ndv_cache: Default::default() }
    }
    pub fn batches(&self) -> &[RecordBatch] {
        &self.batches
    }
}

impl TableProvider for MemTable {
    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }
    fn num_rows(&self) -> Option<usize> {
        Some(self.rows)
    }
    fn kind(&self) -> &'static str {
        "memory"
    }
    fn column_ndv(&self, column: usize) -> Option<f64> {
        if let Some(v) = self.ndv_cache.lock().get(&column) {
            return *v;
        }
        use arrow::array::AsArray;
        use arrow::datatypes::{DataType, Int64Type};
        let dt = self.schema.field(column).data_type().clone();
        let int_like = dt.is_integer() || matches!(dt, DataType::Date32 | DataType::Date64 | DataType::Timestamp(_, _));
        let v = if !int_like || self.rows == 0 {
            None
        } else {
            let (mut mn, mut mx) = (i64::MAX, i64::MIN);
            for b in &self.batches {
                if let Ok(c) = arrow::compute::cast(b.column(column), &DataType::Int64) {
                    let p = c.as_primitive::<Int64Type>();
                    if let (Some(a), Some(z)) = (arrow::compute::min(p), arrow::compute::max(p)) {
                        mn = mn.min(a);
                        mx = mx.max(z);
                    }
                }
            }
            (mn <= mx).then(|| ((mx as i128 - mn as i128 + 1) as f64).min(self.rows as f64))
        };
        self.ndv_cache.lock().insert(column, v);
        v
    }
    fn column_range(&self, column: usize) -> Option<(f64, f64)> {
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for b in &self.batches {
            let v = crate::io::ordinal_values(b.column(column))?;
            let v = arrow::array::AsArray::as_primitive::<arrow::datatypes::Float64Type>(&v);
            if let (Some(a), Some(z)) = (arrow::compute::min(v), arrow::compute::max(v)) {
                lo = lo.min(a);
                hi = hi.max(z);
            }
        }
        (lo <= hi).then_some((lo, hi))
    }
    fn create_source(
        &self,
        projection: Option<&[usize]>,
        _filters: &[Expr],
        fetch: Option<usize>,
    ) -> Result<Arc<dyn Source>> {
        let mut batches = match projection {
            Some(p) => self.batches.iter().map(|b| b.project(p)).collect::<Result<Vec<_>, _>>()?,
            None => self.batches.clone(),
        };
        if fetch.is_some() {
            batches = apply_limit(batches, 0, fetch);
        }
        let schema = match projection {
            Some(p) => Arc::new(self.schema.project(p)?),
            None => self.schema.clone(),
        };
        Ok(Arc::new(MemorySource::new(batches, schema, "MemoryScan")))
    }
}
