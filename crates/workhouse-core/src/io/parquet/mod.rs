//! Parquet scanning and writing, local or on an object store.
//!
//! * local files are memory mapped and handed to the decoder as `Bytes`
//!   (zero copy); remote files keep their footer and are read by ranges,
//! * metadata of all files is loaded once, in parallel (remote footers
//!   concurrently),
//! * row groups are pruned with min/max statistics of pushed-down predicates,
//! * each surviving row group is a morsel; when there are fewer row groups
//!   than worker threads, local row groups are split into row ranges so every
//!   core gets work,
//! * only projected columns are decoded (and fetched, for remote files,
//!   ahead of the workers); `count(*)`-style scans with no columns are
//!   answered from metadata without decoding anything.

mod decode;
pub mod file;
mod footer;
mod prune;
pub mod source;
mod stats;
mod write;

use std::collections::HashMap;
use std::sync::Arc;

use arrow::datatypes::SchemaRef;
use parking_lot::Mutex;

pub use file::ParquetFile;
pub use source::ParquetSource;
pub use write::{ParquetSink, parse_compression, write_parquet, write_parquet_with};

use crate::error::{Result, WhError};
use crate::exec::pipeline::Source;
use crate::expr::Expr;
use crate::io::options::StorageOptions;
use crate::io::{ColumnStats, TableProvider, list_files};

pub fn batch_size() -> usize {
    static SIZE: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *SIZE.get_or_init(|| {
        // 8K rows: the working set of a fused pipeline (a handful of columns)
        // stays in L2, which measured ~25% faster than 64K-row batches on TPC-H
        std::env::var("WORKHOUSE_BATCH_SIZE").ok().and_then(|v| v.parse().ok()).unwrap_or(8192)
    })
}

#[derive(Debug)]
pub struct ParquetTable {
    pattern: String,
    files: Vec<Arc<ParquetFile>>,
    schema: SchemaRef,
    rows: usize,
    ndv_cache: Mutex<HashMap<usize, Option<f64>>>,
    range_cache: Mutex<HashMap<usize, Option<(f64, f64)>>>,
}

impl ParquetTable {
    pub fn try_new(pattern: &str) -> Result<Self> {
        Self::try_new_with(pattern, &StorageOptions::default())
    }

    pub fn try_new_with(pattern: &str, options: &StorageOptions) -> Result<Self> {
        let files = file::open_files(list_files(pattern, "parquet", options)?)?;
        let schema = files[0].meta.schema().clone();
        for f in &files[1..] {
            let s = f.meta.schema();
            let same = s.fields().len() == schema.fields().len()
                && s.fields().iter().zip(schema.fields()).all(|(a, b)| a.name() == b.name() && a.data_type() == b.data_type());
            if !same {
                return Err(WhError::Plan(format!("schema of {} differs from {}", f.name, files[0].name)));
            }
        }
        let rows = files.iter().map(|f| f.meta.metadata().file_metadata().num_rows() as usize).sum();
        Ok(Self { pattern: pattern.to_string(), files, schema, rows, ndv_cache: Default::default(), range_cache: Default::default() })
    }

    pub fn num_files(&self) -> usize {
        self.files.len()
    }

    pub fn pattern(&self) -> &str {
        &self.pattern
    }

    pub fn files(&self) -> &[Arc<ParquetFile>] {
        &self.files
    }

    /// Compressed bytes of all row groups.
    pub fn total_bytes(&self) -> u64 {
        let rgs = self.files.iter().flat_map(|f| f.meta.metadata().row_groups().iter());
        rgs.map(|rg| rg.compressed_size() as u64).sum()
    }
}

fn cached<T: Copy>(cache: &Mutex<HashMap<usize, T>>, key: usize, compute: impl FnOnce() -> T) -> T {
    if let Some(v) = cache.lock().get(&key) {
        return *v;
    }
    let v = compute();
    cache.lock().insert(key, v);
    v
}

impl TableProvider for ParquetTable {
    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }
    fn num_rows(&self) -> Option<usize> {
        Some(self.rows)
    }
    fn kind(&self) -> &'static str {
        "parquet"
    }
    fn column_ndv(&self, column: usize) -> Option<f64> {
        cached(&self.ndv_cache, column, || stats::ndv(&self.files, &self.schema, column, self.rows))
    }

    fn column_range(&self, column: usize) -> Option<(f64, f64)> {
        cached(&self.range_cache, column, || stats::range(&self.files, &self.schema, column))
    }

    fn column_stats(&self) -> Option<Vec<ColumnStats>> {
        Some(stats::column_stats(&self.files, &self.schema))
    }

    fn create_source(&self, projection: Option<&[usize]>, filters: &[Expr], fetch: Option<usize>) -> Result<Arc<dyn Source>> {
        let projection = match projection {
            Some(p) => p.to_vec(),
            None => (0..self.schema.fields().len()).collect(),
        };
        let req = source::ScanRequest { files: &self.files, table_schema: &self.schema, projection, filters, fetch };
        Ok(Arc::new(ParquetSource::try_new(req)?))
    }
}
