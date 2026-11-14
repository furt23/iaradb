//! CSV scanning (parallel over byte ranges, local or remote) and writing.

pub mod args;
mod lines;
mod options;
pub mod ranges;
pub mod source;
mod split;
mod write;

use std::sync::Arc;

use arrow::datatypes::SchemaRef;

pub use options::{CsvEncoding, CsvOptions};
pub use source::CsvSource;
pub use write::{CsvSink, CsvWriteOptions, sink_csv_with, write_csv, write_csv_with};

use crate::error::Result;
use crate::exec::pipeline::Source;
use crate::expr::Expr;
use crate::io::blob::Blob;
use crate::io::options::StorageOptions;
use crate::io::{TableProvider, list_files};

/// Bytes of a remote file read to infer the schema.
const REMOTE_SAMPLE: u64 = 4 << 20;

pub struct CsvTable {
    names: Vec<String>,
    files: Arc<Vec<Blob>>,
    /// The columns of the files (after type overrides).
    file_schema: SchemaRef,
    /// The columns the table exposes (`CsvOptions::columns`), as indices of `file_schema`.
    selected: Option<Vec<usize>>,
    schema: SchemaRef,
    /// Where the data of each file begins (after `skip_rows`).
    starts: Vec<usize>,
    options: CsvOptions,
    est_rows: usize,
    /// Whether the schema sample holds a quote byte (decides how remote files are split).
    sample_quoted: bool,
    /// the path or pattern given
    pattern: String,
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
        let first = ranges::sample(&files[0], REMOTE_SAMPLE)?;
        let starts = data_starts(&files, &first, options.skip_rows)?;
        let sample_quoted = files.iter().any(|f| f.object().is_some()) && options.quote != 0 && memchr::memchr(options.quote, &first).is_some();
        let body = options.decode(first.slice(starts[0]..));
        let inferred = options::infer(&body, &options)?;
        let (file_schema, selected, schema) = options::shape(inferred, &options)?;
        // estimate the number of rows from the average length of the first lines
        let head = &body[..body.len().min(1 << 20)];
        let lines = head.iter().filter(|&&b| b == b'\n').count().max(1);
        let total: u64 = files.iter().map(|f| f.len()).sum();
        let est_rows = (total as usize) * lines / head.len().max(1);
        Ok(Self { names, files: Arc::new(files), file_schema, selected, schema, starts, options, est_rows, sample_quoted, pattern: pattern.to_string() })
    }

    fn byte_ranges(&self) -> Vec<ranges::ByteRange> {
        split::plan(&self.files, &self.options, &self.starts, self.sample_quoted)
    }
}

/// Where each file's data begins: past `skip_rows` lines.
fn data_starts(files: &[Blob], first: &bytes::Bytes, skip_rows: usize) -> Result<Vec<usize>> {
    if skip_rows == 0 {
        return Ok(vec![0; files.len()]);
    }
    let mut starts = vec![ranges::skip_lines(first, skip_rows)];
    for f in &files[1..] {
        starts.push(ranges::skip_lines(&ranges::sample(f, REMOTE_SAMPLE)?, skip_rows));
    }
    Ok(starts)
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
    fn origin(&self) -> Option<crate::exec::query::TableRead> {
        Some(crate::exec::query::TableRead { location: self.pattern.clone(), version: None })
    }
    fn create_source(&self, projection: Option<&[usize]>, _filters: &[Expr], _fetch: Option<usize>) -> Result<Arc<dyn Source>> {
        // table column -> file column
        let projection: Option<Vec<usize>> = match (projection, &self.selected) {
            (Some(p), Some(s)) => Some(p.iter().map(|&i| s[i]).collect()),
            (Some(p), None) => Some(p.to_vec()),
            (None, Some(s)) => Some(s.clone()),
            (None, None) => None,
        };
        let ranges = ranges::RangedLines::new(self.files.clone(), self.byte_ranges(), self.starts.clone());
        Ok(Arc::new(CsvSource::new(self.file_schema.clone(), projection, ranges, self.options.clone())?))
    }
}
