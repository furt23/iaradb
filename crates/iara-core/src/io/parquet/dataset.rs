//! Writing a result as Parquet: one file, or a Hive-partitioned folder.

use parking_lot::Mutex;

use arrow::datatypes::SchemaRef;
use arrow::record_batch::RecordBatch;

use super::hive_write::HiveSink;
use super::write::ParquetSink;
use crate::error::Result;
use crate::io::options::StorageOptions;
use crate::io::output::WrittenFile;
use crate::session::LazyFrame;

/// How a result is written as Parquet.
#[derive(Debug, Clone)]
pub struct ParquetOptions {
    pub compression: String,
    /// rows per row group (default 128K)
    pub row_group_size: Option<usize>,
    /// columns whose values name the folders (`year=2024/...`); none writes one file
    pub partition_by: Vec<String>,
}

impl Default for ParquetOptions {
    fn default() -> Self {
        Self { compression: "zstd".into(), row_group_size: None, partition_by: vec![] }
    }
}

/// A Parquet result being written: one file, or a Hive-partitioned folder.
/// Files appear when [`DatasetSink::finish`] succeeds; a sink dropped before
/// that leaves none of them.
pub enum DatasetSink {
    File(ParquetSink),
    Partitioned(HiveSink),
}

impl DatasetSink {
    pub fn create(path: &str, schema: SchemaRef, opts: &ParquetOptions, storage: &StorageOptions) -> Result<Self> {
        Ok(if opts.partition_by.is_empty() {
            DatasetSink::File(ParquetSink::create(path, schema, &opts.compression, opts.row_group_size, storage)?)
        } else {
            DatasetSink::Partitioned(HiveSink::create(path, schema, &opts.partition_by, &opts.compression, opts.row_group_size, storage)?)
        })
    }

    pub fn write(&mut self, batch: &RecordBatch) -> Result<()> {
        match self {
            DatasetSink::File(s) => s.write(batch),
            DatasetSink::Partitioned(s) => s.write(batch),
        }
    }

    /// Complete the write; returns the files written.
    pub fn finish(self) -> Result<Vec<WrittenFile>> {
        match self {
            DatasetSink::File(s) => Ok(vec![s.finish()?]),
            DatasetSink::Partitioned(s) => s.finish(),
        }
    }
}

/// Write a query's result as Parquet while it is produced (see
/// [`LazyFrame::sink_parquet`]); returns the files written. If the query or the
/// write fails, nothing is left behind.
pub fn sink_parquet_files(lf: &LazyFrame, path: &str, opts: &ParquetOptions, storage: &StorageOptions) -> Result<Vec<WrittenFile>> {
    let sink = Mutex::new(None::<DatasetSink>);
    lf.stream(
        &mut |schema| {
            *sink.lock() = Some(DatasetSink::create(path, schema.clone(), opts, storage)?);
            Ok(())
        },
        &mut |b| sink.lock().as_mut().expect("writer").write(&b),
    )?;
    sink.into_inner().expect("writer").finish()
}
