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
//!   whole files,
//! * a table can also be an explicit list of files with their partition
//!   values and statistics (a Delta table, see [`ParquetTable::from_files`]):
//!   files are opened as scans need them, filters skip files by their
//!   statistics, and each file is read onto the table's columns by name.

mod conform;
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

use arrow::datatypes::{DataType, Schema, SchemaRef};
use parking_lot::Mutex;

pub use file::ParquetFile;
pub use source::ParquetSource;
pub use dataset::{DatasetSink, ParquetOptions, sink_parquet_files};
pub use hive_write::{HiveSink, MAX_PARTITIONS, new_file_name};
pub use write::{ParquetSink, parse_compression, write_parquet, write_parquet_with};

use crate::delta::stats::FileStats;
use crate::error::{Result, WhError};
use crate::exec::pipeline::Source;
use crate::expr::Expr;
use crate::io::options::StorageOptions;
use crate::io::partition::{self, Partitions};
use crate::io::{ColumnStats, DataFile, Location, TableProvider, list_files};
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
    /// statistics of each file, when the table has an explicit file list (else empty)
    file_stats: Vec<Option<FileStats>>,
    /// files may lack columns or order them differently: scans match columns by name
    conform: bool,
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
        let schema = crate::nested::canonical_schema(&schema).unwrap_or(schema);
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
            file_stats: vec![],
            conform: false,
            storage: options.clone(),
            ndv_cache: Default::default(),
            range_cache: Default::default(),
        })
    }

    /// A table of exactly these files. `schema` holds every column; the
    /// `partition_columns` among them are not in the files but come from the
    /// files' `partition_values` (text, aligned to `partition_columns`) and are
    /// placed after the others. Files may lack columns of the schema (read as
    /// NULL) or order them differently; only the first is opened now.
    pub fn from_files(files: Vec<TableFile>, schema: &Schema, partition_columns: &[String], storage: &StorageOptions) -> Result<Self> {
        if files.is_empty() {
            return Err(WhError::Plan("a table of files needs at least one file".into()));
        }
        let schema = file::engine_schema(schema);
        let by_name = |n: &String| schema.field_with_name(n).cloned().map_err(|_| WhError::Plan(format!("partition column '{n}' is not in the table schema")));
        let part_fields = partition_columns.iter().map(by_name).collect::<Result<Vec<_>>>()?;
        let data_fields: Vec<_> = schema.fields().iter().filter(|f| !partition_columns.contains(f.name())).map(|f| f.as_ref().clone()).collect();
        let file_schema: SchemaRef = Arc::new(Schema::new(data_fields));
        let partitions = if part_fields.is_empty() {
            None
        } else {
            let values: Vec<_> = files.iter().map(|f| f.partition_values.clone()).collect();
            Some(Partitions::from_values(Arc::new(Schema::new(part_fields)), &values)?)
        };
        let schema = match &partitions {
            Some(p) => Arc::new(Schema::new([file_schema.fields().to_vec(), p.schema().fields().to_vec()].concat())),
            None => file_schema.clone(),
        };
        let file_stats = files.iter().map(|f| f.stats.clone()).collect();
        let mut listed = Vec::with_capacity(files.len());
        for f in &files {
            listed.push((data_file(&f.path, f.size, storage)?, f.size));
        }
        Ok(Self {
            pattern: files[0].path.clone(),
            files: TableFiles::listed(listed)?,
            schema,
            file_schema,
            partitions,
            file_stats,
            conform: true,
            storage: storage.clone(),
            ndv_cache: Default::default(),
            range_cache: Default::default(),
        })
    }

    /// Hive-style partition columns (after the files' own columns), if any.
    pub fn partitions(&self) -> Option<&Partitions> {
        self.partitions.as_ref()
    }

    /// Which files may hold rows passing `filters` by the statistics in the
    /// log, among those `keep` leaves.
    fn keep_by_stats(&self, filters: &[Expr], keep: Option<Vec<bool>>) -> Vec<bool> {
        let mut keep = keep.unwrap_or_else(|| vec![true; self.files.len()]);
        for (k, by_stats) in keep.iter_mut().zip(prune::keep_files(filters, &self.file_schema, &self.file_stats)) {
            *k &= by_stats;
        }
        keep
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

/// A file of a table given as a list (see [`ParquetTable::from_files`]).
#[derive(Debug, Clone)]
pub struct TableFile {
    /// a local path or an object URL
    pub path: String,
    pub size: u64,
    /// the text of the table's partition columns, in their order (`None`: null)
    pub partition_values: Vec<Option<String>>,
    /// bounds of the columns' values, for skipping the file
    pub stats: Option<FileStats>,
}

/// The file at `path` without listing it: its size is known.
fn data_file(path: &str, size: u64, storage: &StorageOptions) -> Result<DataFile> {
    match Location::parse(path)? {
        Location::Local(p) => Ok(DataFile::Local(p)),
        Location::Object(url) => {
            let store = crate::io::object::registry::open(&url, storage)?;
            let meta = object_store::ObjectMeta {
                location: crate::io::object::object_path(&url.key),
                last_modified: chrono::DateTime::UNIX_EPOCH,
                size,
                e_tag: None,
                version: None,
            };
            Ok(DataFile::Object(crate::io::object::ObjectFile::from_meta(url, meta, store.store, store.id)))
        }
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
        // strings are sampled by position in the first file, which may order columns differently
        if self.conform && matches!(self.file_schema.field(column).data_type(), DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View | DataType::Binary | DataType::BinaryView) {
            return None;
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
        let conform = self.conform;
        let Some(parts) = &self.partitions else {
            let files = if self.file_stats.is_empty() { self.files.all()? } else { self.files.select(&self.keep_by_stats(filters, None))? };
            let req = source::ScanRequest { files: &files, table_schema: &self.schema, projection, filters, fetch, conform };
            return Ok(Arc::new(ParquetSource::try_new(req)?));
        };
        // whole files are skipped by filters on partition columns (their footers are not even read)
        let mut keep = parts.keep(filters);
        if !self.file_stats.is_empty() {
            keep = self.keep_by_stats(filters, Some(keep));
        }
        let files = self.files.select(&keep)?;
        let (file_projection, layout) = split_projection(&projection, self.file_schema.fields().len());
        let req = source::ScanRequest { files: &files, table_schema: &self.file_schema, projection: file_projection, filters, fetch, conform };
        Ok(Arc::new(PartitionedSource {
            inner: ParquetSource::try_new(req)?,
            partitions: parts.select(&keep)?,
            layout,
            schema: Arc::new(self.schema.project(&projection)?),
            files: (files.len(), self.files.len()),
        }))
    }
}
