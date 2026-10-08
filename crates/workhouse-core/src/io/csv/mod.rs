//! CSV scanning (parallel over byte ranges, local or remote) and writing.

mod lines;
pub mod source;
mod write;

use std::io::Cursor;
use std::sync::Arc;

use arrow::csv::reader::Format;
use arrow::datatypes::SchemaRef;
use bytes::Bytes;

pub use source::CsvSource;
pub use write::{CsvSink, write_csv, write_csv_with};

use crate::error::Result;
use crate::exec::pipeline::Source;
use crate::expr::Expr;
use crate::io::blob::Blob;
use crate::io::options::StorageOptions;
use crate::io::{TableProvider, list_files};
use source::ByteRange;

#[derive(Debug, Clone)]
pub struct CsvOptions {
    pub has_header: bool,
    pub delimiter: u8,
    pub infer_rows: usize,
    /// Split files into byte ranges (assumes no newlines inside quoted fields).
    pub parallel: bool,
    /// Bytes per range (default: enough ranges for every thread, at least
    /// 4 MiB locally and 8 MiB remotely).
    pub chunk_bytes: Option<usize>,
}

impl Default for CsvOptions {
    fn default() -> Self {
        Self { has_header: true, delimiter: b',', infer_rows: 10_000, parallel: true, chunk_bytes: None }
    }
}

/// Bytes of a remote file read to infer the schema.
const REMOTE_SAMPLE: u64 = 4 << 20;

pub struct CsvTable {
    names: Vec<String>,
    files: Arc<Vec<Blob>>,
    schema: SchemaRef,
    options: CsvOptions,
    est_rows: usize,
}

impl std::fmt::Debug for CsvTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "CsvTable({:?})", self.names)
    }
}

impl CsvTable {
    pub fn try_new(pattern: &str, options: CsvOptions) -> Result<Self> {
        Self::try_new_with(pattern, options, &StorageOptions::default())
    }

    pub fn try_new_with(pattern: &str, options: CsvOptions, storage: &StorageOptions) -> Result<Self> {
        let listed = list_files(pattern, "csv", storage)?;
        let names = listed.iter().map(|f| f.name()).collect();
        let files = listed.into_iter().map(Blob::open).collect::<Result<Vec<_>>>()?;
        let sample = sample(&files[0])?;
        let fmt = Format::default().with_header(options.has_header).with_delimiter(options.delimiter);
        let (schema, _) = fmt.infer_schema(Cursor::new(&sample[..]), Some(options.infer_rows))?;
        // estimate the number of rows from the average length of the first lines
        let head = &sample[..sample.len().min(1 << 20)];
        let lines = head.iter().filter(|&&b| b == b'\n').count().max(1);
        let total: u64 = files.iter().map(|f| f.len()).sum();
        let est_rows = (total as usize) * lines / head.len().max(1);
        Ok(Self { names, files: Arc::new(files), schema: Arc::new(schema), options, est_rows })
    }

    fn byte_ranges(&self) -> Vec<ByteRange> {
        let threads = rayon::current_num_threads();
        let total: u64 = self.files.iter().map(|f| f.len()).sum();
        let remote = self.files.iter().any(|f| f.object().is_some());
        // remote ranges are larger: fewer requests, each worth its latency
        let min = if remote { 8 << 20 } else { 4 << 20 };
        let chunk = self.options.chunk_bytes.unwrap_or((total as usize / (threads * 4)).max(min)).max(1);
        let mut ranges = vec![];
        for (fi, f) in self.files.iter().enumerate() {
            let len = f.len() as usize;
            if !self.options.parallel {
                ranges.push(ByteRange { file: fi, start: 0, end: len });
                continue;
            }
            let mut start = 0;
            while start < len {
                let end = (start + chunk).min(len);
                ranges.push(ByteRange { file: fi, start, end });
                start = end;
            }
        }
        ranges
    }
}

/// The first lines of a file: all of a mapped file, a prefix cut at a line
/// end for a remote one.
fn sample(file: &Blob) -> Result<Bytes> {
    let len = file.len();
    if let Blob::Mapped(b) = file {
        return Ok(b.clone());
    }
    let s = file.read_range(0..len.min(REMOTE_SAMPLE), None)?;
    if s.len() as u64 == len {
        return Ok(s);
    }
    let end = memchr::memrchr(b'\n', &s).map_or(s.len(), |i| i + 1);
    Ok(s.slice(..end))
}

impl TableProvider for CsvTable {
    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }
    fn num_rows(&self) -> Option<usize> {
        Some(self.est_rows)
    }
    fn kind(&self) -> &'static str {
        "csv"
    }
    fn create_source(&self, projection: Option<&[usize]>, _filters: &[Expr], _fetch: Option<usize>) -> Result<Arc<dyn Source>> {
        let projection = projection.map(|p| p.to_vec());
        let src = CsvSource::new(self.files.clone(), self.schema.clone(), projection, self.byte_ranges(), self.options.clone())?;
        Ok(Arc::new(src))
    }
}
