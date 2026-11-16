//! A scan of a table's listed files that opens each file when it reads it.
//!
//! A table of thousands of files (a Delta table loaded bit by bit) cannot
//! read every footer before it plans a query: the plan would take longer
//! than the scan. Here a morsel is a *split*: the row groups that start in a
//! range of a file's bytes, [`split_bytes`] long. The sizes of the files give
//! the splits, so planning opens nothing. A file is opened by the first of
//! its splits to run, and its footer then says which row groups the filters
//! skip. Remote splits are opened and fetched ahead of the workers (see
//! [`SplitFetcher`]).
//!
//! Files are read onto the table's columns by name, as [`FileColumns`] does.
//! A scan of no columns counts the rows the table's log gives each file and
//! opens none.

use std::ops::Range;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use arrow::datatypes::SchemaRef;
use parking_lot::Mutex;
use parquet::arrow::ProjectionMask;

use super::conform::FileColumns;
use super::decode::{Part, chunk_ranges, decode};
use super::file::{self, ParquetFile};
use super::prune::keep_row_groups;
use super::source::emit_counts;
use super::split_fetch::SplitFetcher;
use super::table_files::FileList;
use crate::error::Result;
use crate::exec::pipeline::{Emit, Source};
use crate::exec::query::QueryHandle;
use crate::expr::Expr;
use crate::io::DataFile;
use crate::io::blob::RangeChunks;

/// `IARA_SPLIT_MB` (default 128): bytes of a file read as one morsel.
pub fn split_bytes() -> u64 {
    std::env::var("IARA_SPLIT_MB").ok().and_then(|v| v.trim().parse::<u64>().ok()).filter(|&mb| mb > 0).unwrap_or(128) << 20
}

/// How many splits files of these sizes are read as.
pub fn split_count(sizes: impl Iterator<Item = u64>) -> usize {
    let per = split_bytes();
    sizes.map(|size| parts(size, per)).sum()
}

fn parts(size: u64, per: u64) -> usize {
    // a file a little over the size is not worth a small second split
    (((size + per / 2) / per) as usize).max(1)
}

pub struct SplitRequest<'a> {
    /// the table's files
    pub list: FileList,
    /// the files to scan, in order (indexes into `list`)
    pub kept: Vec<usize>,
    /// the rows of each file to scan, when the table's log gives them
    pub rows: Vec<Option<u64>>,
    /// the columns the files are read onto (by name)
    pub table_schema: &'a SchemaRef,
    pub projection: Vec<usize>,
    pub filters: &'a [Expr],
    pub fetch: Option<usize>,
}

/// The row groups of a file that start in a range of its bytes.
#[derive(Debug, Clone)]
pub(super) struct Split {
    pub file: usize,
    pub bytes: Range<u64>,
}

/// What a scan reads of every file.
pub(super) struct Scan {
    table_schema: SchemaRef,
    projection: Vec<usize>,
    /// the scan's output
    schema: SchemaRef,
    filters: Vec<Expr>,
    fetch: Option<usize>,
}

/// What a split reads of its file, once the file is open.
pub struct SplitPlan {
    pub file: Arc<ParquetFile>,
    columns: FileColumns,
    mask: ProjectionMask,
    /// the row groups the filters keep (and a LIMIT needs)
    row_groups: Vec<usize>,
    /// row groups of the split
    total: usize,
}

impl Scan {
    pub(super) fn plan(&self, file: Arc<ParquetFile>, bytes: &Range<u64>) -> SplitPlan {
        let keep = keep_row_groups(&self.filters, &self.table_schema, &file);
        let (mut row_groups, mut total, mut rows) = (vec![], 0, 0usize);
        for (i, rg) in file.meta.metadata().row_groups().iter().enumerate() {
            let start = rg.columns().iter().map(|c| c.byte_range().0).min().unwrap_or(0);
            if !bytes.contains(&start) {
                continue;
            }
            total += 1;
            // a LIMIT reads the first row groups that hold enough rows
            if keep[i] && self.fetch.is_none_or(|n| rows < n) {
                rows += rg.num_rows() as usize;
                row_groups.push(i);
            }
        }
        let columns = FileColumns::new(&file, &self.table_schema, &self.projection);
        let mask = ProjectionMask::roots(file.meta.parquet_schema(), columns.read.iter().copied());
        SplitPlan { file, columns, mask, row_groups, total }
    }
}

impl SplitPlan {
    /// The bytes of the column chunks to read.
    pub(super) fn ranges(&self) -> Vec<Range<u64>> {
        self.row_groups.iter().flat_map(|&rg| chunk_ranges(&self.file.meta, rg, &self.mask)).collect()
    }

    pub(super) fn bytes(&self) -> u64 {
        self.ranges().iter().map(|r| r.end - r.start).sum()
    }
}

pub struct SplitSource {
    list: FileList,
    /// the scanned files (indexes into `list`): a split's `file` is a position here
    kept: Arc<Vec<usize>>,
    rows: Vec<Option<u64>>,
    scan: Arc<Scan>,
    splits: Arc<Vec<Split>>,
    /// every file's rows are known and no column is read: no file is opened
    counted: bool,
    /// local files, open from their first split to their last
    opened: Vec<Mutex<Option<Arc<ParquetFile>>>>,
    /// splits of each file not read yet
    left: Vec<AtomicUsize>,
    /// remote files are opened and fetched ahead of the workers
    fetcher: Option<SplitFetcher>,
    cancel: Option<Arc<QueryHandle>>,
    /// row groups read / in the splits read so far
    row_groups: (AtomicUsize, AtomicUsize),
}

impl SplitSource {
    pub fn try_new(req: SplitRequest<'_>) -> Result<Self> {
        let schema = Arc::new(req.table_schema.project(&req.projection)?);
        // filters on the files' columns choose row groups by their statistics
        let on_files = req.filters.iter().flat_map(|f| f.column_refs()).any(|c| req.table_schema.field_with_name(&c.name).is_ok());
        let counted = req.projection.is_empty() && !on_files && req.rows.iter().all(|r| r.is_some());
        let per = split_bytes();
        let (list, kept) = (req.list, Arc::new(req.kept));
        let mut splits = vec![];
        let mut left = Vec::with_capacity(kept.len());
        for (i, &file) in kept.iter().enumerate() {
            let size = list.size(file);
            // a count needs the file once; a LIMIT reads files from their start
            let n = if req.projection.is_empty() || req.fetch.is_some() { 1 } else { parts(size, per) };
            let step = size / n as u64;
            // the last split takes what the listed size leaves out
            splits.extend((0..n as u64).map(|k| Split { file: i, bytes: k * step..if k + 1 == n as u64 { u64::MAX } else { (k + 1) * step } }));
            left.push(AtomicUsize::new(n));
        }
        let splits = Arc::new(splits);
        let scan = Arc::new(Scan { table_schema: req.table_schema.clone(), projection: req.projection, schema, filters: req.filters.to_vec(), fetch: req.fetch });
        let remote = !kept.is_empty() && kept.iter().all(|&file| matches!(list.source(file), DataFile::Object(_)));
        // a LIMIT rarely needs much
        let fetcher = (remote && !counted).then(|| SplitFetcher::new(list.clone(), kept.clone(), splits.clone(), scan.clone(), req.fetch.map(|_| 2)));
        Ok(SplitSource {
            opened: kept.iter().map(|_| Mutex::new(None)).collect(),
            list,
            kept,
            rows: req.rows,
            scan,
            splits,
            counted,
            left,
            fetcher,
            cancel: crate::exec::query::current(),
            row_groups: Default::default(),
        })
    }

    /// The file (index into the scanned files) a morsel reads.
    pub fn morsel_file(&self, morsel: usize) -> usize {
        self.splits[morsel].file
    }

    /// The local file `i`, opened once for all its splits.
    fn open(&self, i: usize) -> Result<Arc<ParquetFile>> {
        let mut cell = self.opened[i].lock();
        if let Some(f) = &*cell {
            return Ok(f.clone());
        }
        let f = file::open_files(vec![self.list.source(self.kept[i]).clone()])?.remove(0);
        *cell = Some(f.clone());
        Ok(f)
    }

    /// A split is read: its file closes with the last of them.
    fn done(&self, file: usize) {
        if self.left[file].fetch_sub(1, Ordering::AcqRel) == 1 {
            *self.opened[file].lock() = None;
        }
    }

    fn decode(&self, plan: &SplitPlan, chunks: RangeChunks, emit: Emit<'_>) -> Result<()> {
        self.row_groups.0.fetch_add(plan.row_groups.len(), Ordering::Relaxed);
        self.row_groups.1.fetch_add(plan.total, Ordering::Relaxed);
        let rows_of = |rg: usize| plan.file.meta.metadata().row_group(rg).num_rows() as usize;
        if self.scan.projection.is_empty() {
            let rows: usize = plan.row_groups.iter().map(|&rg| rows_of(rg)).sum();
            return emit_counts(&self.scan.schema, self.scan.fetch.map_or(rows, |n| rows.min(n)), emit);
        }
        let mut limit = self.scan.fetch;
        for &row_group in &plan.row_groups {
            if limit == Some(0) {
                break;
            }
            let part = Part { meta: &plan.file.meta, row_group, rows: None, limit, schema: &plan.columns.decoded };
            decode(chunks.clone(), plan.mask.clone(), &part, None, &mut |b| emit(plan.columns.adapt(b, &self.scan.schema)?))?;
            limit = limit.map(|n| n.saturating_sub(rows_of(row_group)));
        }
        Ok(())
    }
}

impl Source for SplitSource {
    fn num_morsels(&self) -> usize {
        self.splits.len()
    }

    fn run_morsel(&self, morsel: usize, emit: Emit<'_>) -> Result<()> {
        let split = &self.splits[morsel];
        if self.counted {
            let rows = self.rows[split.file].unwrap_or(0) as usize;
            return emit_counts(&self.scan.schema, self.scan.fetch.map_or(rows, |n| rows.min(n)), emit);
        }
        let cancel = self.cancel.as_deref();
        if let Some(fetcher) = &self.fetcher {
            let fetched = fetcher.take(morsel, cancel)?;
            return self.decode(&fetched.plan, fetched.chunks.clone(), emit);
        }
        let plan = self.scan.plan(self.open(split.file)?, &split.bytes);
        let read = plan.file.blob.read(&plan.ranges(), cancel).and_then(|chunks| self.decode(&plan, chunks, emit));
        self.done(split.file);
        read
    }

    fn schema(&self) -> SchemaRef {
        self.scan.schema.clone()
    }

    fn describe(&self) -> String {
        let first = self.kept.first().map_or("", |&file| self.list.name(file));
        let mut parts = first.trim_end_matches(['/', '\\']).rsplit(['/', '\\']);
        let file = parts.next().unwrap_or("");
        let scanned = if self.kept.len() == 1 { file.split('.').next().unwrap_or(file) } else { parts.next().unwrap_or(file) };
        let (kept, total) = (self.row_groups.0.load(Ordering::Relaxed), self.row_groups.1.load(Ordering::Relaxed));
        // row groups are known as the files are read
        let row_groups = if total > 0 { format!(", row_groups={kept}/{total}") } else { String::new() };
        format!("ParquetScan[{scanned}, files={}{row_groups}, morsels={}, columns={}]", self.kept.len(), self.splits.len(), self.scan.projection.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn files_split_by_size() {
        let mb = 1u64 << 20;
        assert_eq!(parts(0, 128 * mb), 1);
        assert_eq!(parts(100 * mb, 128 * mb), 1);
        // a little over one split's size stays one split
        assert_eq!(parts(150 * mb, 128 * mb), 1);
        assert_eq!(parts(200 * mb, 128 * mb), 2);
        assert_eq!(parts(1024 * mb, 128 * mb), 8);
    }
}
