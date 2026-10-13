//! Writing CSV to a local file or an object, all at once or batch by batch.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use arrow::csv::{Writer, WriterBuilder};
use arrow::datatypes::{DataType, Schema};
use arrow::record_batch::RecordBatch;
use parking_lot::Mutex;

use crate::error::Result;
use crate::io::options::StorageOptions;
use crate::io::output::{Output, WrittenFile};
use crate::session::LazyFrame;

/// How CSV is written (COPY's HEADER, DELIMITER, QUOTE, ESCAPE, NULL).
#[derive(Debug, Clone)]
pub struct CsvWriteOptions {
    pub header: bool,
    pub delimiter: u8,
    pub quote: u8,
    pub escape: u8,
    /// The text written for null (empty by default).
    pub null: Option<String>,
}

impl Default for CsvWriteOptions {
    fn default() -> Self {
        Self { header: true, delimiter: b',', quote: b'"', escape: b'"', null: None }
    }
}

/// A CSV file being written.
pub struct CsvSink {
    writer: Writer<Output>,
    path: String,
    rows: u64,
}

impl CsvSink {
    pub fn create(path: &str, has_header: bool, delimiter: u8, storage: &StorageOptions) -> Result<Self> {
        Self::create_with(path, &CsvWriteOptions { header: has_header, delimiter, ..Default::default() }, storage)
    }

    pub fn create_with(path: &str, o: &CsvWriteOptions, storage: &StorageOptions) -> Result<Self> {
        let mut b = WriterBuilder::new().with_header(o.header).with_delimiter(o.delimiter).with_quote(o.quote).with_escape(o.escape);
        if let Some(n) = &o.null {
            b = b.with_null(n.clone());
        }
        Ok(Self { writer: b.build(Output::create(path, storage)?), path: path.to_string(), rows: 0 })
    }

    pub fn write(&mut self, batch: &RecordBatch) -> Result<()> {
        self.writer.write(&without_views(batch)?)?;
        self.rows += batch.num_rows() as u64;
        Ok(())
    }

    /// Flush and move the file into place; returns it as written.
    pub fn finish(self) -> Result<WrittenFile> {
        let size = self.writer.into_inner().finish()?;
        Ok(WrittenFile { path: self.path, size, rows: self.rows, partition_values: vec![], metadata: None })
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
    sink.finish().map(|_| ())
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

/// Write the result as CSV while it is produced; returns the rows written.
pub fn sink_csv_with(lf: &LazyFrame, path: &str, o: &CsvWriteOptions, storage: &StorageOptions) -> Result<usize> {
    let sink = Mutex::new(None::<CsvSink>);
    let rows = AtomicUsize::new(0);
    lf.stream(
        &mut |_| {
            *sink.lock() = Some(CsvSink::create_with(path, o, storage)?);
            Ok(())
        },
        &mut |b| {
            rows.fetch_add(b.num_rows(), Ordering::Relaxed);
            sink.lock().as_mut().expect("writer").write(&b)
        },
    )?;
    sink.into_inner().expect("writer").finish()?;
    Ok(rows.into_inner())
}
