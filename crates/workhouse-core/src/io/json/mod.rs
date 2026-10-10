//! JSON scanning and writing. A file is NDJSON (one object per line, read in
//! parallel by byte ranges like CSV) or one JSON array of objects (read whole,
//! one morsel per file). Columns are boolean, Int64, Float64 or Utf8; objects
//! and arrays are `Struct` and `List` columns (inferred from the sample), or
//! with `nested = "text"` their JSON text (Utf8).

mod args;
mod build;
mod build_nested;
mod decode;
mod infer;
mod list;
pub mod parse;
mod session;
mod source;
mod write;

use std::sync::Arc;

use arrow::datatypes::SchemaRef;

pub use session::{read_json, register_json, sink_json};
pub use source::JsonSource;
pub use decode::decode_json;
pub use write::{JsonSink, escape_into, json_text, write_json, write_json_with};

use crate::error::{Result, WhError};
use crate::exec::pipeline::Source;
use crate::expr::Expr;
use crate::io::blob::Blob;
use crate::io::csv::ranges::{self, ByteRange, RangedLines};
use crate::io::options::StorageOptions;
use crate::io::TableProvider;

/// How the records of a file are laid out.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum JsonFormat {
    /// By the first byte of each file: `[` is an array, else NDJSON.
    #[default]
    Auto,
    Ndjson,
    Array,
}

/// What objects and arrays become.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum JsonNested {
    /// `Struct` and `List` columns of the inferred types.
    #[default]
    Auto,
    /// Their JSON text.
    Text,
}

#[derive(Debug, Clone)]
pub struct JsonOptions {
    /// Records looked at to infer the schema (of the first file).
    pub infer_rows: usize,
    pub format: JsonFormat,
    /// Split NDJSON files into byte ranges.
    pub parallel: bool,
    pub chunk_bytes: Option<usize>,
    pub nested: JsonNested,
}

impl Default for JsonOptions {
    fn default() -> Self {
        Self { infer_rows: 1000, format: JsonFormat::Auto, parallel: true, chunk_bytes: None, nested: JsonNested::Auto }
    }
}

/// Bytes of a remote file read to infer the schema.
const REMOTE_SAMPLE: u64 = 4 << 20;

pub struct JsonTable {
    names: Vec<String>,
    files: Arc<Vec<Blob>>,
    /// Per file: a JSON array rather than NDJSON.
    arrays: Vec<bool>,
    schema: SchemaRef,
    options: JsonOptions,
    est_rows: Option<usize>,
}

impl std::fmt::Debug for JsonTable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "JsonTable({:?})", self.names)
    }
}

impl JsonTable {
    pub fn try_new(pattern: &str, options: JsonOptions) -> Result<Self> {
        Self::try_new_with(pattern, options, &StorageOptions::default())
    }

    pub fn try_new_with(pattern: &str, options: JsonOptions, storage: &StorageOptions) -> Result<Self> {
        let listed = list::list_json_files(pattern, storage)?;
        let names = listed.iter().map(|f| f.name()).collect();
        let files = listed.into_iter().map(Blob::open).collect::<Result<Vec<_>>>()?;
        let mut arrays = vec![];
        for f in &files {
            arrays.push(is_array(&ranges::sample(f, 1 << 16)?, options.format)?);
        }
        let sample = ranges::sample(&files[0], REMOTE_SAMPLE)?;
        let truncated = (sample.len() as u64) < files[0].len();
        let schema = source::infer_file(&sample, arrays[0], truncated, options.infer_rows, options.nested)?;
        let est_rows = estimate_rows(&files, &arrays, &sample);
        Ok(Self { names, files: Arc::new(files), arrays, schema: Arc::new(schema), options, est_rows })
    }

    fn byte_ranges(&self) -> Vec<ByteRange> {
        let starts = vec![0; self.files.len()];
        let mut r: Vec<ByteRange> =
            ranges::plan(&self.files, self.options.parallel, self.options.chunk_bytes, &starts).into_iter().filter(|r| !self.arrays[r.file]).collect();
        // an array is read whole: one morsel per file
        r.extend(self.arrays.iter().enumerate().filter(|(_, a)| **a).map(|(file, _)| ByteRange { file, start: 0, end: self.files[file].len() as usize }));
        r
    }
}

/// Whether a file (its first bytes) is a JSON array.
fn is_array(head: &[u8], format: JsonFormat) -> Result<bool> {
    match format {
        JsonFormat::Ndjson => Ok(false),
        JsonFormat::Array => Ok(true),
        JsonFormat::Auto => {
            let head = head.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(head);
            match head.iter().find(|b| !b.is_ascii_whitespace()) {
                Some(b'[') => Ok(true),
                Some(b'{') | None => Ok(false),
                Some(&b) => Err(WhError::Plan(format!("not a JSON file: it starts with '{}' (expected NDJSON objects or an array)", b as char))),
            }
        }
    }
}

/// Rows from the average length of a line (NDJSON files only).
fn estimate_rows(files: &[Blob], arrays: &[bool], sample: &[u8]) -> Option<usize> {
    if arrays.iter().any(|a| *a) {
        return None;
    }
    let head = &sample[..sample.len().min(1 << 20)];
    let lines = head.iter().filter(|&&b| b == b'\n').count().max(1);
    let total: u64 = files.iter().map(|f| f.len()).sum();
    Some((total as usize) * lines / head.len().max(1))
}

impl TableProvider for JsonTable {
    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }
    fn num_rows(&self) -> Option<usize> {
        self.est_rows
    }
    fn kind(&self) -> &'static str {
        "json"
    }
    fn create_source(&self, projection: Option<&[usize]>, _filters: &[Expr], _fetch: Option<usize>) -> Result<Arc<dyn Source>> {
        let out = match projection {
            Some(p) => Arc::new(self.schema.project(p)?),
            None => self.schema.clone(),
        };
        let lines = RangedLines::new(self.files.clone(), self.byte_ranges(), vec![0; self.files.len()]);
        Ok(Arc::new(JsonSource::new(out, lines, self.arrays.clone())))
    }
}
