//! Parquet scanning and writing, local or on an object store.
//!
//! * local files are memory mapped and handed to the decoder as `Bytes`
//!   (zero copy); remote files keep their footer and are read by ranges,
//! * metadata of all files is loaded once, in parallel (remote footers
//!   concurrently, and cached for the process; a remote table in partition
//!   folders loads the footers of the files a query keeps only),
//! * row groups are pruned with min/max statistics of pushed-down predicates,
//! * each surviving row group is a morsel; when there are fewer row groups
//!   than worker threads, local row groups are split into row ranges so every
//!   core gets work,
//! * only projected columns are decoded (and fetched, for remote files,
//!   ahead of the workers); `count(*)`-style scans with no columns are
//!   answered from metadata without decoding anything,
//! * Hive-style `key=value` folders become columns, and filters on them skip
//!   whole files.

mod dataset;
mod decode;
pub mod file;
mod footer;
mod hive_write;
pub mod meta_cache;
mod partitioned;
mod prune;
mod sample_cache;
pub mod source;
mod stats;
mod table_files;
mod write;

use std::collections::HashMap;
use std::sync::Arc;

use arrow::datatypes::{Schema, SchemaRef};
use parking_lot::Mutex;

pub use file::ParquetFile;
pub use source::ParquetSource;
pub use dataset::{DatasetSink, ParquetOptions};
pub use hive_write::{HiveSink, MAX_PARTITIONS, new_file_name};
pub use write::{ParquetSink, parse_compression, write_parquet, write_parquet_with};

use crate::error::Result;
use crate::exec::pipeline::Source;
use crate::expr::Expr;
use crate::io::options::StorageOptions;
use crate::io::partition::{self, Partitions};
use crate::io::{ColumnStats, TableProvider, list_files};
use partitioned::{PartitionedSource, split_projection};
use table_files::TableFiles;

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
    files: TableFiles,
    /// the files' columns, then the partition columns
    schema: SchemaRef,
    file_schema: SchemaRef,
    partitions: Option<Partitions>,
    storage: StorageOptions,
    ndv_cache: Mutex<HashMap<usize, Option<f64>>>,
    range_cache: Mutex<HashMap<usize, Option<(f64, f64)>>>,
}

impl ParquetTable {
    pub fn try_new(pattern: &str) -> Result<Self> {
        Self::try_new_with(pattern, &StorageOptions::default())
    }

    pub fn try_new_with(pattern: &str, options: &StorageOptions) -> Result<Self> {
        let files = TableFiles::open(pattern, list_files(pattern, "parquet", options)?)?;
        let schema = files.first().meta.schema().clone();
        let partitions = partition::detect(pattern, &files.names(), &schema)?;
        let file_schema = schema;
        let schema = match &partitions {
            Some(p) => Arc::new(Schema::new([file_schema.fields().to_vec(), p.schema().fields().to_vec()].concat())),
            None => file_schema.clone(),
        };
        Ok(Self {
            pattern: pattern.to_string(),
            files,
            schema,
            file_schema,
            partitions,
            storage: options.clone(),
            ndv_cache: Default::default(),
            range_cache: Default::default(),
        })
    }

    /// Hive-style partition columns (after the files' own columns), if any.
    pub fn partitions(&self) -> Option<&Partitions> {
        self.partitions.as_ref()
    }

    /// The partition column behind table column `column`, if it is one.
    fn partition_column(&self, column: usize) -> Option<(&Partitions, usize)> {
        let n = self.file_schema.fields().len();
        self.partitions.as_ref().filter(|_| column >= n).map(|p| (p, column - n))
    }

    pub fn num_files(&self) -> usize {
        self.files.len()
    }

    pub fn pattern(&self) -> &str {
        &self.pattern
    }

    /// The files opened so far (all of them, unless the table opens its
    /// files as scans need them).
    pub fn files(&self) -> Vec<Arc<ParquetFile>> {
        self.files.opened()
    }

    /// Compressed bytes of all row groups of the files opened so far.
    pub fn total_bytes(&self) -> u64 {
        let files = self.files.opened();
        let rgs = files.iter().flat_map(|f| f.meta.metadata().row_groups().iter());
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
        Some(self.files.rows())
    }
    fn kind(&self) -> &'static str {
        "parquet"
    }
    fn location(&self) -> Option<crate::io::dataset::TableLocation> {
        crate::io::dataset::is_folder(&self.pattern).then(|| crate::io::dataset::TableLocation {
            path: self.pattern.clone(),
            storage: self.storage.clone(),
            partition_by: self.partitions.as_ref().map(|p| p.schema().fields().iter().map(|f| f.name().clone()).collect()).unwrap_or_default(),
        })
    }
    fn column_ndv(&self, column: usize) -> Option<f64> {
        if let Some((p, j)) = self.partition_column(column) {
            return Some(p.ndv(j));
        }
        cached(&self.ndv_cache, column, || {
            // strings are sampled in the first file, numbers need every file's statistics
            let files = if stats::reads_all_files(&self.file_schema, column) { self.files.all().ok()? } else { vec![self.files.first().clone()] };
            stats::ndv(&files, &self.file_schema, column, self.files.rows())
        })
    }

    fn column_range(&self, column: usize) -> Option<(f64, f64)> {
        if let Some((p, j)) = self.partition_column(column) {
            return p.range(j);
        }
        cached(&self.range_cache, column, || stats::range(&self.files.all().ok()?, &self.file_schema, column))
    }

    fn column_stats(&self) -> Option<Vec<ColumnStats>> {
        let mut out = stats::column_stats(&self.files.all().ok()?, &self.file_schema);
        if let Some(p) = &self.partitions {
            out.extend((0..p.schema().fields().len()).map(|j| p.stats(j)));
        }
        Some(out)
    }

    fn create_source(&self, projection: Option<&[usize]>, filters: &[Expr], fetch: Option<usize>) -> Result<Arc<dyn Source>> {
        let projection = match projection {
            Some(p) => p.to_vec(),
            None => (0..self.schema.fields().len()).collect(),
        };
        let Some(parts) = &self.partitions else {
            let files = self.files.all()?;
            let req = source::ScanRequest { files: &files, table_schema: &self.schema, projection, filters, fetch };
            return Ok(Arc::new(ParquetSource::try_new(req)?));
        };
        // whole files are skipped by filters on partition columns (their footers are not even read)
        let keep = parts.keep(filters);
        let files = self.files.select(&keep)?;
        let (file_projection, layout) = split_projection(&projection, self.file_schema.fields().len());
        let req = source::ScanRequest { files: &files, table_schema: &self.file_schema, projection: file_projection, filters, fetch };
        Ok(Arc::new(PartitionedSource {
            inner: ParquetSource::try_new(req)?,
            partitions: parts.select(&keep)?,
            layout,
            schema: Arc::new(self.schema.project(&projection)?),
            files: (files.len(), self.files.len()),
        }))
    }
}
