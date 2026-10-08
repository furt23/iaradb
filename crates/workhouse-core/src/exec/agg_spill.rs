//! Out-of-core hash aggregation: radix partitions that do not fit under the
//! memory limit go to disk, one spill file per partition shared by all
//! workers, and the finalize aggregates one partition at a time.

use std::sync::Arc;

use arrow::array::ArrayRef;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use parking_lot::Mutex;

use crate::error::Result;
use crate::exec::aggregate::AggregateExpr;
use crate::exec::spill::{SpillFile, SpillWriter};

/// Spilled chunks (`[keys..., agg inputs...]`) by partition.
pub struct AggSpill {
    writers: Vec<Mutex<Option<SpillWriter>>>,
}

fn as_batch(chunk: &[ArrayRef]) -> Result<RecordBatch> {
    let fields: Vec<Field> = chunk.iter().enumerate().map(|(i, a)| Field::new(format!("c{i}"), a.data_type().clone(), true)).collect();
    let rows = chunk.first().map_or(0, |a| a.len());
    let opts = RecordBatchOptions::new().with_row_count(Some(rows));
    Ok(RecordBatch::try_new_with_options(Arc::new(Schema::new(fields)), chunk.to_vec(), &opts)?)
}

impl AggSpill {
    pub fn new(partitions: usize) -> Self {
        Self { writers: (0..partitions).map(|_| Mutex::new(None)).collect() }
    }

    pub fn write(&self, part: usize, chunk: &[ArrayRef]) -> Result<()> {
        let batch = as_batch(chunk)?;
        let mut w = self.writers[part].lock();
        if w.is_none() {
            *w = Some(SpillWriter::try_new(batch.schema())?);
        }
        w.as_mut().expect("writer").write(&batch)
    }

    pub fn spilled(&self) -> bool {
        self.writers.iter().any(|w| w.lock().is_some())
    }

    /// The finished files, by partition.
    pub fn finish(&self) -> Result<Vec<Option<SpillFile>>> {
        self.writers.iter().map(|w| w.lock().take().map(|w| w.finish()).transpose()).collect()
    }
}

/// Estimated bytes of one group in a pre-aggregation table: its keys, its
/// accumulator states and the hash table entry.
pub fn group_bytes(group_types: &[DataType], aggs: &[AggregateExpr]) -> usize {
    let keys: usize = group_types
        .iter()
        .map(|t| match t {
            DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View | DataType::Binary | DataType::BinaryView => 32,
            t => t.primitive_width().unwrap_or(16),
        })
        .sum();
    let states: usize = aggs.iter().map(|a| if a.distinct { 128 } else { 24 }).sum();
    keys + states + 16
}

/// Bytes held by evaluated arrays (shared buffers counted once per array).
pub fn arrays_bytes(cols: &[ArrayRef]) -> usize {
    cols.iter().map(|c| c.get_array_memory_size()).sum()
}
