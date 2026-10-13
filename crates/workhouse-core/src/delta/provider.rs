//! A Delta table as a table provider: the files of a snapshot, read as a
//! Parquet table of explicit files (see `ParquetTable::from_files`).
//!
//! Partition columns come from the log's partition values, not from the
//! files; filters skip files by partition value and by the statistics of
//! the log. A file may lack columns the schema gained since (they read as
//! NULL) or order them differently.

use std::path::Path;
use std::sync::Arc;

use arrow::datatypes::SchemaRef;

use super::snapshot::{Snapshot, latest_version};
use super::stats::FileStats;
use super::LogStore;
use crate::error::Result;
use crate::exec::pipeline::Source;
use crate::expr::Expr;
use crate::io::location::url_scheme;
use crate::io::memory::MemTable;
use crate::io::options::StorageOptions;
use crate::io::parquet::{ParquetTable, TableFile, file::engine_schema};
use crate::io::{ColumnStats, TableProvider};

/// Which version of a table to read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionSpec {
    Version(u64),
    /// the newest version committed at or before this time (milliseconds since the epoch)
    Timestamp(i64),
}

#[derive(Debug)]
pub struct DeltaTable {
    root: String,
    storage: StorageOptions,
    snapshot: Snapshot,
    inner: Arc<dyn TableProvider>,
    /// the table's columns in the schema's order
    schema: SchemaRef,
    /// column `i` of the table is column `to_inner[i]` of `inner` (which puts partition columns last)
    to_inner: Vec<usize>,
    /// from the files' statistics, when every file has a count
    rows: Option<usize>,
    /// opened at the newest version (not time travel): a later registration of the table in
    /// the session becomes its successor and plans made on this one scan that newer version
    follow: bool,
    successor: parking_lot::Mutex<Option<Arc<dyn TableProvider>>>,
}

/// Whether `location` holds a Delta table: its `_delta_log` has a commit or a checkpoint.
pub fn is_delta_table(location: &str, storage: &StorageOptions) -> bool {
    LogStore::open(location, storage).and_then(|log| latest_version(&log)).is_ok()
}

impl DeltaTable {
    /// The table at `location` (a directory or an object URL) at a version, or its newest.
    pub fn open(location: &str, storage: &StorageOptions, version: Option<VersionSpec>) -> Result<DeltaTable> {
        let log = LogStore::open(location, storage)?;
        let snapshot = match version {
            None => Snapshot::load(&log, None)?,
            Some(VersionSpec::Version(v)) => Snapshot::load(&log, Some(v))?,
            Some(VersionSpec::Timestamp(ts)) => Snapshot::at_timestamp(&log, ts)?,
        };
        let mut table = Self::from_snapshot(location, storage, snapshot)?;
        table.follow = version.is_none();
        Ok(table)
    }

    /// The table that replaces this one in the session (after a write through it): scans planned
    /// on this table read `next` instead, if it is the same table with the same columns. Views
    /// and frames made before a write so see it. Only for tables opened at their newest version.
    pub(crate) fn set_successor(&self, next: Arc<dyn TableProvider>) {
        if self.follow && next.as_delta().is_some_and(|n| n.root == self.root) {
            *self.successor.lock() = Some(next);
        }
    }

    pub fn from_snapshot(location: &str, storage: &StorageOptions, snapshot: Snapshot) -> Result<DeltaTable> {
        let schema = Arc::new(engine_schema(&snapshot.schema));
        let (files, rows) = table_files(location, &snapshot);
        let (inner, to_inner): (Arc<dyn TableProvider>, Vec<usize>) = if files.is_empty() {
            (Arc::new(MemTable::new(schema.clone(), vec![])), (0..schema.fields().len()).collect())
        } else {
            let table = ParquetTable::from_files(files, &snapshot.schema, &snapshot.partition_columns, storage)?;
            let placed = table.schema();
            let to_inner = schema.fields().iter().map(|f| Ok(placed.index_of(f.name())?)).collect::<Result<Vec<_>>>()?;
            (Arc::new(table), to_inner)
        };
        Ok(DeltaTable { root: location.to_string(), storage: storage.clone(), snapshot, inner, schema, to_inner, rows, follow: false, successor: parking_lot::Mutex::new(None) })
    }

    /// The table as the log says at the version read.
    pub fn snapshot(&self) -> &Snapshot {
        &self.snapshot
    }

    pub fn version(&self) -> u64 {
        self.snapshot.version
    }

    /// The table root, as given.
    pub fn root(&self) -> &str {
        &self.root
    }

    pub fn storage(&self) -> &StorageOptions {
        &self.storage
    }
}

/// The path or URL of a data file: absolute ones as they are, others below the table root.
fn resolve(root: &str, path: &str) -> String {
    if let Some(local) = path.strip_prefix("file://") {
        return local.to_string();
    }
    if url_scheme(path).is_some() || Path::new(path).is_absolute() {
        return path.to_string();
    }
    if url_scheme(root).is_some() {
        return format!("{}/{path}", root.trim_end_matches('/'));
    }
    Path::new(root).join(path).display().to_string()
}

/// The files of the snapshot, and the table's row count if the log gives it.
pub(crate) fn table_files(root: &str, snapshot: &Snapshot) -> (Vec<TableFile>, Option<usize>) {
    let mut rows = Some(0usize);
    let files = snapshot
        .files
        .iter()
        .map(|add| {
            let stats = add.stats.as_deref().and_then(|s| FileStats::parse(s, &snapshot.schema).ok());
            rows = rows.zip(stats.as_ref().and_then(|s| s.num_records)).map(|(a, b)| a + b as usize);
            // an empty value is a null (Delta writers write it for nulls)
            let value = |c: &String| add.partition_values.get(c).cloned().flatten().filter(|v| !v.is_empty());
            TableFile {
                path: resolve(root, &add.file_path()),
                size: add.size.max(0) as u64,
                partition_values: snapshot.partition_columns.iter().map(value).collect(),
                stats,
            }
        })
        .collect();
    (files, rows)
}

impl TableProvider for DeltaTable {
    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }

    fn num_rows(&self) -> Option<usize> {
        self.rows.or_else(|| self.inner.num_rows())
    }

    fn kind(&self) -> &'static str {
        "delta"
    }

    fn as_delta(&self) -> Option<&DeltaTable> {
        Some(self)
    }

    fn column_ndv(&self, column: usize) -> Option<f64> {
        self.inner.column_ndv(self.to_inner[column])
    }

    fn column_range(&self, column: usize) -> Option<(f64, f64)> {
        self.inner.column_range(self.to_inner[column])
    }

    fn column_stats(&self) -> Option<Vec<ColumnStats>> {
        let stats = self.inner.column_stats()?;
        Some(self.schema.fields().iter().filter_map(|f| stats.iter().find(|s| s.column == *f.name()).cloned()).collect())
    }

    fn create_source(&self, projection: Option<&[usize]>, filters: &[Expr], fetch: Option<usize>) -> Result<Arc<dyn Source>> {
        let next = self.successor.lock().clone();
        if let Some(next) = next.filter(|n| n.schema() == self.schema) {
            return next.create_source(projection, filters, fetch);
        }
        let inner: Vec<usize> = match projection {
            Some(p) => p.iter().map(|&i| self.to_inner[i]).collect(),
            None => self.to_inner.clone(),
        };
        self.inner.create_source(Some(&inner), filters, fetch)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_file_paths_resolve_against_the_root() {
        assert_eq!(resolve("s3://b/t/", "p=1/f.parquet"), "s3://b/t/p=1/f.parquet");
        assert_eq!(resolve("s3://b/t", "s3://other/x.parquet"), "s3://other/x.parquet");
        assert_eq!(resolve("data/t", "f.parquet"), Path::new("data/t").join("f.parquet").display().to_string());
        assert_eq!(resolve("data/t", "file:///abs/f.parquet"), "/abs/f.parquet");
    }
}
