//! Streaming (non-blocking) operators: filter and projection.

use std::sync::Arc;

use arrow::array::{Array, ArrayRef, AsArray};
use arrow::compute::{cast, filter_record_batch};
use arrow::datatypes::{Field, Schema, SchemaRef};
use arrow::record_batch::{RecordBatch, RecordBatchOptions};

use crate::error::Result;
use crate::exec::pipeline::{Emit, Operator};
use crate::physical::expr::PhysExpr;

/// Make every field nullable: physical operators never rely on declared
/// nullability, and this keeps RecordBatch validation cheap and robust.
pub fn nullable_schema(schema: &Schema) -> SchemaRef {
    Arc::new(Schema::new(
        schema
            .fields()
            .iter()
            .map(|f| Arc::new(f.as_ref().clone().with_nullable(true)))
            .collect::<Vec<Arc<Field>>>(),
    ))
}

/// View arrays (`Utf8View` / `BinaryView`) keep references to every data
/// buffer of the arrays they were taken/concatenated from. Across several
/// materialisation points (join builds, sorts) the buffer lists multiply, so
/// views are compacted into fresh buffers once they reference too many.
pub fn compact_views(a: ArrayRef) -> ArrayRef {
    match a.data_type() {
        arrow::datatypes::DataType::Utf8View => {
            let v = a.as_string_view();
            if v.data_buffers().len() > 4 { Arc::new(v.gc()) } else { a }
        }
        arrow::datatypes::DataType::BinaryView => {
            let v = a.as_binary_view();
            if v.data_buffers().len() > 4 { Arc::new(v.gc()) } else { a }
        }
        _ => a,
    }
}

pub fn compact_batch_views(b: RecordBatch) -> Result<RecordBatch> {
    if !b.columns().iter().any(|c| matches!(c.data_type(), arrow::datatypes::DataType::Utf8View | arrow::datatypes::DataType::BinaryView)) {
        return Ok(b);
    }
    let cols = b.columns().iter().cloned().map(compact_views).collect();
    Ok(RecordBatch::try_new_with_options(b.schema(), cols, &RecordBatchOptions::new().with_row_count(Some(b.num_rows())))?)
}

/// Build a batch, casting columns whose runtime type differs from the schema.
pub fn make_batch(schema: &SchemaRef, mut cols: Vec<arrow::array::ArrayRef>, rows: usize) -> Result<RecordBatch> {
    for (c, f) in cols.iter_mut().zip(schema.fields()) {
        if c.data_type() != f.data_type() {
            *c = cast(c, f.data_type())?;
        }
    }
    Ok(RecordBatch::try_new_with_options(
        schema.clone(),
        cols,
        &RecordBatchOptions::new().with_row_count(Some(rows)),
    )?)
}

thread_local! {
    static DEFERRED_MASK: std::cell::RefCell<Option<(arrow::array::BooleanArray, usize)>> = const { std::cell::RefCell::new(None) };
}

/// Take the deferred filter mask attached to the current batch on this thread, if any.
pub fn take_deferred_mask() -> Option<(arrow::array::BooleanArray, usize)> {
    DEFERRED_MASK.with(|c| c.borrow_mut().take())
}

/// Number of selected rows in the current batch on this thread if a filter mask is deferred.
pub fn deferred_selected_rows() -> Option<usize> {
    DEFERRED_MASK.with(|c| c.borrow().as_ref().map(|(_, s)| *s))
}

pub struct FilterOp {
    pub predicate: PhysExpr,
    /// Columns to keep after filtering (fused projection).
    pub projection: Option<Vec<usize>>,
    /// Defer physical batch compaction on high-selectivity batches for a downstream AggregateSink.
    pub defer_mask: bool,
}

impl Operator for FilterOp {
    fn execute(&self, batch: RecordBatch, emit: Emit<'_>) -> Result<()> {
        let n = batch.num_rows();
        let mask = self.predicate.evaluate(&batch)?.into_array(n)?;
        let mask = mask.as_boolean();
        let batch = match &self.projection {
            Some(p) => batch.project(p)?,
            None => batch,
        };
        let selected = mask.true_count();
        if selected == 0 {
            return Ok(());
        }
        if selected == n && mask.null_count() == 0 {
            return emit(batch);
        }
        if self.defer_mask && selected * 2 > n {
            let mask = crate::physical::expr::null_as_false(mask);
            DEFERRED_MASK.with(|c| *c.borrow_mut() = Some((mask, selected)));
            let res = emit(batch);
            DEFERRED_MASK.with(|c| *c.borrow_mut() = None);
            return res;
        }
        emit(filter_record_batch(&batch, mask)?)
    }

    fn describe(&self) -> String {
        format!("Filter({})", self.predicate)
    }
}

pub struct ProjectOp {
    pub exprs: Vec<PhysExpr>,
    pub schema: SchemaRef,
}

impl Operator for ProjectOp {
    fn execute(&self, batch: RecordBatch, emit: Emit<'_>) -> Result<()> {
        let n = batch.num_rows();
        let mut cache = Vec::new();
        let cols = self
            .exprs
            .iter()
            .map(|e| e.evaluate_cached(&batch, &mut cache)?.into_array(n))
            .collect::<Result<Vec<_>>>()?;
        emit(make_batch(&self.schema, cols, n)?)
    }

    fn describe(&self) -> String {
        format!(
            "Project({})",
            self.exprs.iter().map(|e| e.to_string()).collect::<Vec<_>>().join(", ")
        )
    }
}
