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
//!   filters skip files by their statistics, the optimizer's estimates come
//!   from them too, and each file is read onto the table's columns by name.
//!   Planning opens no file of a table of many: the scan opens each as it
//!   reads it (see [`split_scan`]).

mod conform;
mod dataset;
mod decode;
pub mod file;
mod footer;
mod hive_write;
pub mod late;
mod late_filter;
mod log_stats;
pub mod meta_cache;
mod partitioned;
mod prune;
mod sample_cache;
pub mod source;
mod split_fetch;
pub mod split_scan;
mod stats;
mod table_files;
mod write;

use std::collections::HashMap;
use std::sync::Arc;

use arrow::datatypes::{Schema, SchemaRef};
use parking_lot::Mutex;

pub use file::ParquetFile;
pub use source::ParquetSource;
pub use dataset::{DatasetSink, ParquetOptions, sink_parquet_files};
pub use hive_write::{HiveSink, MAX_PARTITIONS, new_file_name};
pub use log_stats::LogStats;
pub use write::{ParquetSink, parse_compression, write_parquet, write_parquet_with};

use crate::error::{Result, WhError};
use crate::exec::pipeline::Source;
use crate::expr::Expr;
use crate::io::options::StorageOptions;
use crate::io::partition::{self, Partitions};
use crate::io::{ColumnStats, DataFile, Location, TableProvider, list_files};
use log_stats::Answer;
use partitioned::{FileScan, PartitionedSource, split_projection};
use split_scan::{SplitRequest, SplitSource};
use table_files::TableFiles;

/// The most files opened while a query is planned, for a table that opens its files as
/// scans read them: to answer an aggregate from their footers.
const PLANNED_FILES: usize = 64;

pub fn batch_size() -> usize {
    static SIZE: std::sync::OnceLock<usize> = std::sync::OnceLock::new();
    *SIZE.get_or_init(|| {
        // 8K rows: the working set of a fused pipeline (a handful of columns)
        // stays in L2, which measured ~25% faster than 64K-row batches on TPC-H
        std::env::var("IARA_BATCH_SIZE").ok().and_then(|v| v.parse().ok()).unwrap_or(8192)
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
    log: LogStats,
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
            log: LogStats::default(),
            conform: false,
            storage: options.clone(),
            ndv_cache: Default::default(),
            range_cache: Default::default(),
        })
    }

    /// A table of exactly these files, with what the table's log says of
    /// each (`stats`, a file per file of `files`). `schema` holds every column; the
    /// `partition_columns` among them are not in the files but come from the
    /// files' `partition_values` (text, aligned to `partition_columns`) and are
    /// placed after the others. Files may lack columns of the schema (read as
    /// NULL) or order them differently; only the first is opened now. The
    /// others open when a scan reads them.
    pub fn from_files(files: Vec<TableFile>, stats: LogStats, schema: &Schema, partition_columns: &[String], storage: &StorageOptions) -> Result<Self> {
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
        let log = stats;
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
            log,
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
        for (k, by_stats) in keep.iter_mut().zip(prune::keep_files(filters, &self.file_schema, &self.log, self.files.len())) {
            *k &= by_stats;
        }
        keep
    }

    /// The scan of a table of listed files. Few files are opened now, as a
    /// table of Parquet files does, and their row groups are the morsels.
    /// Many are left to the scan, which opens each when it reads it: reading
    /// thousands of footers first would take longer than most queries.
    ///
    /// `joins` are hash joins' build keys on columns of the table: a scan that opens its
    /// files itself skips files with them. `None`: the scan cannot (it opens few files now).
    fn listed_source(&self, projection: Vec<usize>, filters: &[Expr], fetch: Option<usize>, joins: Option<&[crate::io::ScanJoinKeys]>) -> Result<Option<Arc<dyn Source>>> {
        let mut keep = self.keep_by_stats(filters, self.partitions.as_ref().map(|p| p.keep(filters)));
        if let Some(rows) = fetch {
            self.keep_for_limit(&mut keep, rows as u64);
        }
        let (file_projection, layout) = match &self.partitions {
            Some(_) => split_projection(&projection, self.file_schema.fields().len()),
            None => (projection.clone(), vec![]),
        };
        let kept: Vec<usize> = (0..keep.len()).filter(|&i| keep[i]).collect();
        let files = kept.len();
        let inner: Box<dyn FileScan> = match self.files.list().filter(|_| self.opens_in_scan(&kept, &file_projection, filters)) {
            Some(list) => {
                let rows = kept.iter().map(|&i| self.log.rows_of(i)).collect();
                let gates = joins.unwrap_or_default().iter().map(|j| self.gate(j, &kept)).collect();
                Box::new(SplitSource::try_new(SplitRequest { list, kept, rows, table_schema: &self.file_schema, projection: file_projection, filters, fetch, gates })?)
            }
            None if joins.is_some() => return Ok(None),
            None => {
                let files = self.files.select(&keep)?;
                let req = source::ScanRequest { files: &files, table_schema: &self.file_schema, projection: file_projection, filters, fetch, conform: true, row_numbers: false, bound: None, joins: &[] };
                Box::new(ParquetSource::try_new(req)?)
            }
        };
        let Some(parts) = &self.partitions else {
            let source: Box<dyn Source> = inner;
            return Ok(Some(Arc::from(source)));
        };
        Ok(Some(Arc::new(PartitionedSource {
            inner,
            partitions: parts.select(&keep)?,
            layout,
            schema: Arc::new(self.schema.project(&projection)?),
            files: (files, self.files.len()),
        })))
    }

    /// The build keys of a join on a column of the table with, for each of the files
    /// `kept`, the range of that column: a partition column's one value, or the bounds of
    /// the log (where it has none, the row groups' own statistics still skip row groups).
    fn gate(&self, join: &crate::io::ScanJoinKeys, kept: &[usize]) -> split_scan::Gate {
        use arrow::array::{Array, AsArray};
        let ranges = || -> Option<Vec<Option<(i64, i64)>>> {
            let Some((parts, j)) = self.partition_column(join.column) else {
                let all = self.log.key_ranges(self.file_schema.field(join.column))?;
                return Some(kept.iter().map(|&i| all[i]).collect());
            };
            let values = crate::exec::join::to_i64(parts.values.column(j)).ok()?;
            let values = values.as_primitive::<arrow::datatypes::Int64Type>();
            // a null partition value matches no key
            Some(kept.iter().map(|&i| Some(if values.is_valid(i) { (values.value(i), values.value(i)) } else { (1, 0) })).collect())
        };
        split_scan::Gate { keys: join.keys.clone(), ranges: ranges().unwrap_or_else(|| vec![None; kept.len()]) }
    }

    /// Whether the scan of the `kept` files opens them itself: when they make
    /// enough morsels to keep every thread busy, or when it only counts rows
    /// the log already gives.
    fn opens_in_scan(&self, kept: &[usize], file_projection: &[usize], filters: &[Expr]) -> bool {
        let morsels = split_scan::split_count(kept.iter().map(|&i| self.files.size(i)));
        if morsels >= (rayon::current_num_threads() * 3).min(PLANNED_FILES) {
            return true;
        }
        let on_files = filters.iter().flat_map(|f| f.column_refs()).any(|c| self.file_schema.field_with_name(&c.name).is_ok());
        file_projection.is_empty() && !on_files && kept.iter().all(|&i| self.log.rows_of(i).is_some())
    }

    /// A LIMIT reads the first files that hold `rows` rows between them, by the log's counts.
    fn keep_for_limit(&self, keep: &mut [bool], rows: u64) {
        let mut have = 0u64;
        for i in 0..keep.len() {
            if !keep[i] {
                continue;
            }
            if have >= rows {
                keep[i] = false;
                continue;
            }
            // a file without a count may hold no rows: every later file stays
            let Some(n) = self.log.rows_of(i) else { return };
            have += n;
        }
    }

    /// An aggregate over the whole table from the log, or from the footers
    /// of the few files the log says can hold the value.
    fn log_aggregate(&self, agg: crate::io::StatsAgg) -> Option<crate::scalar::Scalar> {
        match self.log.aggregate(&self.file_schema, agg) {
            Answer::Exact(v) => Some(v),
            Answer::Files(files) if files.len() <= PLANNED_FILES => {
                let mut keep = vec![false; self.files.len()];
                files.iter().for_each(|&i| keep[i] = true);
                stats::aggregates(&self.files.select(&keep).ok()?, &self.file_schema, &[agg])?.pop()
            }
            _ => None,
        }
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
        // a table of listed files counts by its log (its files are not open)
        Some(self.log.rows().filter(|_| self.conform).map_or_else(|| self.files.rows(), |n| n as usize))
    }
    fn kind(&self) -> &'static str {
        "parquet"
    }
    fn origin(&self) -> Option<crate::exec::query::TableRead> {
        // an explicit file list (`from_files`, the only `conform` table) is a Delta table's inner table
        (!self.conform).then(|| crate::exec::query::TableRead { location: self.pattern.clone(), version: None })
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
        if self.conform {
            // from the log: strings would be sampled by position in the first file, which
            // may order its columns differently
            return cached(&self.ndv_cache, column, || self.log.ndv(self.file_schema.field(column), self.num_rows().unwrap_or(0)));
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
        if self.conform {
            return cached(&self.range_cache, column, || self.log.range(self.file_schema.field(column)));
        }
        cached(&self.range_cache, column, || stats::range(&self.files.all().ok()?, &self.file_schema, column))
    }

    fn column_stats(&self) -> Option<Vec<ColumnStats>> {
        let mut out = if self.conform { self.log.column_stats(&self.file_schema) } else { stats::column_stats(&self.files.all().ok()?, &self.file_schema) };
        if let Some(p) = &self.partitions {
            out.extend((0..p.schema().fields().len()).map(|j| p.stats(j)));
        }
        Some(out)
    }

    fn stats_aggregates(&self, aggs: &[crate::io::StatsAgg]) -> Option<Vec<crate::scalar::Scalar>> {
        use crate::io::StatsAgg;
        // partition columns are not in the files
        let in_files = |c: usize| c < self.file_schema.fields().len();
        if !aggs.iter().all(|a| matches!(*a, StatsAgg::Rows) || matches!(*a, StatsAgg::NonNull(c) | StatsAgg::Min(c) | StatsAgg::Max(c) if in_files(c))) {
            return None;
        }
        if self.conform {
            return aggs.iter().map(|a| self.log_aggregate(*a)).collect();
        }
        stats::aggregates(&self.files.all().ok()?, &self.file_schema, aggs)
    }

    fn create_gated_source(
        &self,
        projection: Option<&[usize]>,
        filters: &[Expr],
        bound: Option<&crate::io::ScanBound>,
        joins: &[crate::io::ScanJoinKeys],
    ) -> Option<Result<Arc<dyn Source>>> {
        let projection = projection.map_or_else(|| (0..self.schema.fields().len()).collect(), |p| p.to_vec());
        if self.conform {
            // the files of a table of many are skipped by a join's keys; a top k's bound is not taken
            if bound.is_some() || joins.is_empty() {
                return None;
            }
            return self.listed_source(projection, filters, None, Some(joins)).transpose();
        }
        if self.partitions.is_some() {
            return None;
        }
        let source = || -> Result<Arc<dyn Source>> {
            let files = self.files.all()?;
            let req = source::ScanRequest { files: &files, table_schema: &self.schema, projection, filters, fetch: None, conform: false, row_numbers: false, bound, joins };
            Ok(Arc::new(ParquetSource::try_new(req)?))
        };
        Some(source())
    }

    fn late_rows(&self) -> Option<Arc<dyn crate::io::LateRows>> {
        if self.partitions.is_some() || self.conform {
            return None;
        }
        let files = self.files.all().ok()?;
        Some(Arc::new(late::ParquetRows::new(files, self.schema.clone())))
    }

    fn create_source(&self, projection: Option<&[usize]>, filters: &[Expr], fetch: Option<usize>) -> Result<Arc<dyn Source>> {
        let projection = match projection {
            Some(p) => p.to_vec(),
            None => (0..self.schema.fields().len()).collect(),
        };
        if self.conform {
            return Ok(self.listed_source(projection, filters, fetch, None)?.expect("a scan without joins"));
        }
        let Some(parts) = &self.partitions else {
            let files = self.files.all()?;
            let req = source::ScanRequest { files: &files, table_schema: &self.schema, projection, filters, fetch, conform: false, row_numbers: false, bound: None, joins: &[] };
            return Ok(Arc::new(ParquetSource::try_new(req)?));
        };
        // whole files are skipped by filters on partition columns (their footers are not even read)
        let keep = parts.keep(filters);
        let files = self.files.select(&keep)?;
        let (file_projection, layout) = split_projection(&projection, self.file_schema.fields().len());
        let req = source::ScanRequest { files: &files, table_schema: &self.file_schema, projection: file_projection, filters, fetch, conform: false, row_numbers: false, bound: None, joins: &[] };
        Ok(Arc::new(PartitionedSource {
            inner: Box::new(ParquetSource::try_new(req)?),
            partitions: parts.select(&keep)?,
            layout,
            schema: Arc::new(self.schema.project(&projection)?),
            files: (files.len(), self.files.len()),
        }))
    }
}
