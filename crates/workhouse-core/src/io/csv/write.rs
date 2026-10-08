//! Writing CSV to a local file or an object, all at once or batch by batch.

use std::sync::Arc;

use arrow::csv::{Writer, WriterBuilder};
use arrow::datatypes::{DataType, Schema};
use arrow::record_batch::RecordBatch;

use crate::error::Result;
use crate::io::options::StorageOptions;
use crate::io::output::Output;

/// A CSV file being written.
pub struct CsvSink {
    writer: Writer<Output>,
}

impl CsvSink {
    pub fn create(path: &str, has_header: bool, delimiter: u8, storage: &StorageOptions) -> Result<Self> {
        let writer = WriterBuilder::new().with_header(has_header).with_delimiter(delimiter).build(Output::create(path, storage)?);
        Ok(Self { writer })
    }

    pub fn write(&mut self, batch: &RecordBatch) -> Result<()> {
        Ok(self.writer.write(&without_views(batch)?)?)
    }

    pub fn finish(self) -> Result<()> {
        self.writer.into_inner().finish()
    }
}

pub fn write_csv(path: &str, batches: &[RecordBatch], has_header: bool, delimiter: u8) -> Result<()> {
    write_csv_with(path, batches, has_header, delimiter, &StorageOptions::default())
}

pub fn write_csv_with(path: &str, batches: &[RecordBatch], has_header: bool, delimiter: u8, options: &StorageOptions) -> Result<()> {
    let mut sink = CsvSink::create(path, has_header, delimiter, options)?;
    for b in batches {
        sink.write(b)?;
    }
    sink.finish()
}

/// The CSV writer does not take Utf8View columns: cast them to Utf8.
fn without_views(b: &RecordBatch) -> Result<RecordBatch> {
    if !b.columns().iter().any(|c| matches!(c.data_type(), DataType::Utf8View)) {
        return Ok(b.clone());
    }
    let unview = |t: &DataType| if matches!(t, DataType::Utf8View) { DataType::Utf8 } else { t.clone() };
    let fields: Vec<_> = b.schema().fields().iter().map(|f| f.as_ref().clone().with_data_type(unview(f.data_type()))).collect();
    let cols = b.columns().iter().map(|c| arrow::compute::cast(c, &unview(c.data_type()))).collect::<Result<Vec<_>, _>>()?;
    Ok(RecordBatch::try_new(Arc::new(Schema::new(fields)), cols)?)
}
