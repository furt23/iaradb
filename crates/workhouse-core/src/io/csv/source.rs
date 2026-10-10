//! The parallel CSV scan over byte ranges: each morsel parses the lines
//! that start inside its range.

use std::sync::Arc;

use arrow::datatypes::SchemaRef;
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use bytes::Bytes;

use super::CsvOptions;
use super::ranges::RangedLines;
use crate::error::Result;
use crate::exec::pipeline::{Emit, Source};
use crate::io::parquet::batch_size;

pub struct CsvSource {
    pub schema: SchemaRef,
    pub out_schema: SchemaRef,
    pub projection: Option<Vec<usize>>,
    pub options: CsvOptions,
    ranges: RangedLines,
}

impl CsvSource {
    pub fn new(schema: SchemaRef, projection: Option<Vec<usize>>, ranges: RangedLines, options: CsvOptions) -> Result<Self> {
        let out_schema = match &projection {
            Some(p) => Arc::new(schema.project(p)?),
            None => schema.clone(),
        };
        Ok(Self { schema, out_schema, projection, options, ranges })
    }

    fn emit_batches(&self, slice: Bytes, at_start: bool, emit: Emit<'_>) -> Result<()> {
        let slice = self.options.decode(slice);
        for batch in self.options.reader(self.schema.clone(), self.projection.as_deref(), slice, at_start, batch_size())? {
            let batch = batch?;
            if batch.num_columns() == 0 {
                let opts = RecordBatchOptions::new().with_row_count(Some(batch.num_rows()));
                emit(RecordBatch::try_new_with_options(self.out_schema.clone(), vec![], &opts)?)?;
            } else {
                emit(batch)?;
            }
        }
        Ok(())
    }
}

impl Source for CsvSource {
    fn num_morsels(&self) -> usize {
        self.ranges.len()
    }
    fn run_morsel(&self, morsel: usize, emit: Emit<'_>) -> Result<()> {
        let (slice, begin) = self.ranges.lines(morsel)?;
        if slice.is_empty() {
            return Ok(());
        }
        self.emit_batches(slice, self.ranges.at_data_start(morsel, begin), emit)
    }
    fn schema(&self) -> SchemaRef {
        self.out_schema.clone()
    }
    fn describe(&self) -> String {
        format!("CsvScan[files={}, morsels={}]", self.ranges.file_count(), self.ranges.len())
    }
}
