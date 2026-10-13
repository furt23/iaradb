//! Writing Parquet to a local file or an object (multipart upload), all at
//! once or batch by batch as a query produces them.

use std::sync::Arc;

use arrow::datatypes::SchemaRef;
use arrow::record_batch::RecordBatch;
use parquet::arrow::ArrowWriter;
use parquet::basic::{BrotliLevel, Compression, GzipLevel, ZstdLevel};
use parquet::file::properties::WriterProperties;

use crate::error::{Result, WhError};
use crate::io::options::StorageOptions;
use crate::io::output::{Output, WrittenFile};

pub fn parse_compression(s: &str) -> Result<Compression> {
    Ok(match s.to_ascii_lowercase().as_str() {
        "snappy" => Compression::SNAPPY,
        "zstd" => Compression::ZSTD(ZstdLevel::default()),
        "lz4" | "lz4_raw" => Compression::LZ4_RAW,
        "gzip" => Compression::GZIP(GzipLevel::default()),
        "brotli" => Compression::BROTLI(BrotliLevel::default()),
        "none" | "uncompressed" => Compression::UNCOMPRESSED,
        o => return Err(WhError::Plan(format!("unknown compression '{o}'"))),
    })
}

/// A Parquet file being written. It appears under its name when
/// [`ParquetSink::finish`] succeeds; dropped before, it leaves nothing.
pub struct ParquetSink {
    writer: ArrowWriter<Output>,
    path: String,
}

impl ParquetSink {
    pub fn create(path: &str, schema: SchemaRef, compression: &str, row_group_size: Option<usize>, storage: &StorageOptions) -> Result<Self> {
        let props = WriterProperties::builder()
            .set_compression(parse_compression(compression)?)
            .set_max_row_group_row_count(Some(row_group_size.unwrap_or(1 << 17)))
            .build();
        Ok(Self { writer: ArrowWriter::try_new(Output::create(path, storage)?, schema, Some(props))?, path: path.to_string() })
    }

    pub fn write(&mut self, batch: &RecordBatch) -> Result<()> {
        Ok(self.writer.write(batch)?)
    }

    /// Write the footer and close the file (complete the upload); returns
    /// the file as written, with its footer.
    pub fn finish(mut self) -> Result<WrittenFile> {
        let metadata = self.writer.finish()?;
        let size = self.writer.inner_mut().commit()?;
        Ok(WrittenFile {
            path: self.path,
            size,
            rows: metadata.file_metadata().num_rows().max(0) as u64,
            partition_values: vec![],
            metadata: Some(Arc::new(metadata)),
        })
    }
}

pub fn write_parquet(path: &str, schema: SchemaRef, batches: &[RecordBatch], compression: &str, row_group_size: Option<usize>) -> Result<()> {
    write_parquet_with(path, schema, batches, compression, row_group_size, &StorageOptions::default())
}

pub fn write_parquet_with(
    path: &str,
    schema: SchemaRef,
    batches: &[RecordBatch],
    compression: &str,
    row_group_size: Option<usize>,
    options: &StorageOptions,
) -> Result<()> {
    let mut sink = ParquetSink::create(path, schema, compression, row_group_size, options)?;
    for b in batches {
        sink.write(b)?;
    }
    sink.finish().map(|_| ())
}
