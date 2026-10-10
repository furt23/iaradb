//! Writing a result as Parquet: one file, or a Hive-partitioned folder.

use arrow::datatypes::SchemaRef;
use arrow::record_batch::RecordBatch;

use super::hive_write::HiveSink;
use super::write::ParquetSink;
use crate::error::Result;
use crate::io::options::StorageOptions;

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

    pub fn finish(self) -> Result<()> {
        match self {
            DatasetSink::File(s) => s.finish(),
            DatasetSink::Partitioned(s) => s.finish().map(|_| ()),
        }
    }
}
