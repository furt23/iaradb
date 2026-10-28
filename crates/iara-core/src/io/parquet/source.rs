//! The parallel Parquet scan: one morsel per surviving row group (split into
//! row ranges when there are too few for the threads), with the column
//! chunks of remote files prefetched ahead of the workers, several row
//! groups of a file per fetch to keep the number of requests down.

use std::sync::Arc;

use arrow::array::Array;
use arrow::datatypes::{DataType, Field, FieldRef, Schema, SchemaRef};
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use parquet::arrow::arrow_reader::statistics::StatisticsConverter;
use parquet::arrow::arrow_reader::{ArrowReaderMetadata, ArrowReaderOptions};
use parquet::arrow::{ProjectionMask, RowNumber};
use parquet::column::page::PageReader;
use parquet::file::serialized_reader::SerializedPageReader;
use rayon::prelude::*;

use super::batch_size;
use super::conform::FileColumns;
use super::decode::{Part, chunk_ranges, decode};
use super::file::ParquetFile;
use super::late_filter::LateFilter;
use super::prune::keep_row_groups;
use crate::error::Result;
use crate::exec::pipeline::{Emit, Source};
use crate::exec::query::QueryHandle;
use crate::exec::topk_bound::{TopKBound, ordinal_at};
use crate::expr::Expr;
use crate::io::{ScanBound, ScanJoinKeys};
use crate::io::object::config;
use crate::io::object::prefetch::{self, FetchGroups, Prefetcher};

#[derive(Debug, Clone)]
struct Morsel {
    file: usize,
    row_group: usize,
    /// (first row, row count) inside the row group
    range: Option<(usize, usize)>,
    rows: usize,
}

pub struct ParquetSource {
    files: Vec<Arc<ParquetFile>>,
    projection: Vec<usize>,
    schema: SchemaRef,
    morsels: Vec<Morsel>,
    fetch: Option<usize>,
    row_groups_total: usize,
    row_groups_kept: usize,
    prefetch: Option<Prefetcher>,
    cancel: Option<Arc<QueryHandle>>,
    /// per file, how its columns make up the scan's (files that differ from the table)
    columns: Option<Vec<FileColumns>>,
    /// filters applied while decoding (files laid out like the table only)
    late_filter: Option<LateFilter>,
    /// per file, the metadata that also decodes each row's number in the
    /// file (a last Int64 column), when asked for
    numbered: Option<Vec<ArrowReaderMetadata>>,
    /// a top k's bound, and per morsel the ordinal range (and NULLs) of the
    /// bound column's statistics: morsels past the bound are skipped
    bound: Option<(Arc<TopKBound>, Vec<Option<(i64, i64, bool)>>)>,
}

pub struct ScanRequest<'a> {
    pub files: &'a [Arc<ParquetFile>],
    pub table_schema: &'a SchemaRef,
    pub projection: Vec<usize>,
    pub filters: &'a [Expr],
    pub fetch: Option<usize>,
    /// the files' columns are matched to the table's by name
    pub conform: bool,
    /// emit each row's number in its file as a last Int64 column
    pub row_numbers: bool,
    /// a top k's running bound (files laid out like the table only)
    pub bound: Option<&'a ScanBound>,
    /// hash joins' build keys, tested while decoding (files laid out like the table only)
    pub joins: &'a [ScanJoinKeys],
}

impl ParquetSource {
    pub fn try_new(req: ScanRequest<'_>) -> Result<Self> {
        let mut schema = Arc::new(req.table_schema.project(&req.projection)?);
        let numbered = if req.row_numbers {
            let mut fields = schema.fields().to_vec();
            fields.push(row_number_field());
            schema = Arc::new(Schema::new(fields));
            Some(numbered_metas(req.files)?)
        } else {
            None
        };
        let mut morsels = surviving_row_groups(req.files, req.table_schema, req.filters);
        let row_groups_kept = morsels.len();
        let row_groups_total = req.files.iter().map(|f| f.meta.metadata().num_row_groups()).sum();
        let remote = req.files.iter().any(|f| f.blob.object().is_some());
        // remote row groups are fetched whole: splitting them would fetch twice
        if !remote && req.fetch.is_none() && !req.projection.is_empty() {
            let parts = if req.conform { usize::MAX } else { max_parts(req.files, morsels.first(), &req.projection) };
            morsels = split_for_parallelism(morsels, parts);
        }
        // a LIMIT reads the first row groups that hold enough rows, not one per worker
        if let (true, Some(rows)) = (remote, req.fetch) {
            morsels = enough_rows(morsels, rows);
        }
        let mut src = ParquetSource {
            files: req.files.to_vec(),
            projection: req.projection,
            schema,
            morsels,
            fetch: req.fetch,
            row_groups_total,
            row_groups_kept,
            prefetch: None,
            cancel: crate::exec::query::current(),
            columns: None,
            late_filter: None,
            numbered,
            bound: None,
        };
        let bound = req.bound.filter(|_| !req.conform);
        if !req.conform && req.fetch.is_none() {
            src.late_filter = LateFilter::new(req.table_schema, &src.projection, req.filters, bound, req.joins);
        }
        if let Some(b) = bound {
            let ranges = morsel_ranges(&src.files, &src.morsels, req.table_schema.field(b.column).name());
            src.bound = Some((b.bound.clone(), ranges));
        }
        if req.conform {
            src.columns = Some(src.files.iter().map(|f| FileColumns::new(f, req.table_schema, &src.projection)).collect());
        }
        if remote && !src.projection.is_empty() {
            src.prefetch = src.prefetcher();
        }
        Ok(src)
    }

    fn mask(&self, file: usize) -> ProjectionMask {
        let schema = self.files[file].meta.parquet_schema();
        match &self.columns {
            Some(c) => ProjectionMask::roots(schema, c[file].read.iter().copied()),
            None => ProjectionMask::roots(schema, self.projection.iter().copied()),
        }
    }

    fn prefetcher(&self) -> Option<Prefetcher> {
        let window = match self.fetch {
            Some(_) => 2, // a LIMIT rarely needs much
            None => prefetch::window(),
        };
        if window == 0 {
            return None;
        }
        // consecutive row groups of a file are fetched together (fewer requests);
        // a LIMIT fetches them one by one
        let target = if self.fetch.is_some() { 0 } else { config::fetch_target() };
        let mut groups = FetchGroups::new(target);
        for m in &self.morsels {
            let f = &self.files[m.file];
            groups.push(m.file, f.blob.object()?, chunk_ranges(&f.meta, m.row_group, &self.mask(m.file)));
        }
        let prefetcher = Prefetcher::grouped(groups.finish(), window);
        Some(if self.fetch.is_some() { prefetcher.with_lookahead(window) } else { prefetcher })
    }

    /// Emit row counts only (no columns): answered from metadata.
    fn emit_counts(&self, rows: usize, emit: Emit<'_>) -> Result<()> {
        let bs = batch_size();
        let mut left = rows;
        while left > 0 {
            let n = left.min(bs);
            let opts = RecordBatchOptions::new().with_row_count(Some(n));
            emit(RecordBatch::try_new_with_options(self.schema.clone(), vec![], &opts)?)?;
            left -= n;
        }
        Ok(())
    }
}

fn surviving_row_groups(files: &[Arc<ParquetFile>], schema: &SchemaRef, filters: &[Expr]) -> Vec<Morsel> {
    let per_file: Vec<Vec<Morsel>> = files
        .par_iter()
        .enumerate()
        .map(|(fi, f)| {
            let keep = keep_row_groups(filters, schema, f);
            f.meta
                .metadata()
                .row_groups()
                .iter()
                .enumerate()
                .filter(|(i, _)| keep[*i])
                .map(|(i, rg)| Morsel { file: fi, row_group: i, range: None, rows: rg.num_rows() as usize })
                .collect()
        })
        .collect();
    per_file.into_iter().flatten().collect()
}

/// The virtual column of a row's number in its file.
fn row_number_field() -> FieldRef {
    Arc::new(Field::new("__row_number", DataType::Int64, false).with_extension_type(RowNumber))
}

/// Per file, its metadata with a virtual row-number column added.
fn numbered_metas(files: &[Arc<ParquetFile>]) -> Result<Vec<ArrowReaderMetadata>> {
    let field = row_number_field();
    files
        .iter()
        .map(|f| {
            let opts = ArrowReaderOptions::new().with_schema(f.meta.schema().clone()).with_virtual_columns(vec![field.clone()])?;
            Ok(ArrowReaderMetadata::try_new(f.meta.metadata().clone(), opts)?)
        })
        .collect()
}

/// Per morsel, the ordinal range of a column's row-group statistics and
/// whether it has NULLs (None: unknown).
/// What a scan reads, as its description names it: the file without its
/// extension, or the folder of several files.
fn scanned(files: &[Arc<ParquetFile>]) -> &str {
    let Some(first) = files.first() else { return "" };
    let mut parts = first.name.trim_end_matches(['/', '\\']).rsplit(['/', '\\']);
    let file = parts.next().unwrap_or("");
    if files.len() == 1 { file.split('.').next().unwrap_or(file) } else { parts.next().unwrap_or(file) }
}

fn morsel_ranges(files: &[Arc<ParquetFile>], morsels: &[Morsel], column: &str) -> Vec<Option<(i64, i64, bool)>> {
    let per_file: Vec<Vec<Option<(i64, i64, bool)>>> = files
        .iter()
        .map(|f| {
            let rgs = f.meta.metadata().row_groups();
            let stats = || -> Option<Vec<Option<(i64, i64, bool)>>> {
                let conv = StatisticsConverter::try_new(column, f.meta.schema(), f.meta.parquet_schema()).ok()?.with_missing_null_counts_as_zero(false);
                let mins = conv.row_group_mins(rgs.iter()).ok()?;
                let maxs = conv.row_group_maxes(rgs.iter()).ok()?;
                let nulls = conv.row_group_null_counts(rgs.iter()).ok()?;
                Some(
                    (0..rgs.len())
                        .map(|i| {
                            let (lo, hi) = (ordinal_at(mins.as_ref(), i)?, ordinal_at(maxs.as_ref(), i)?);
                            Some((lo, hi, !nulls.is_valid(i) || nulls.value(i) > 0))
                        })
                        .collect(),
                )
            };
            stats().unwrap_or_else(|| vec![None; rgs.len()])
        })
        .collect();
    morsels.iter().map(|m| per_file[m.file][m.row_group]).collect()
}

/// The first morsels that hold `rows` rows between them.
fn enough_rows(mut morsels: Vec<Morsel>, rows: usize) -> Vec<Morsel> {
    let mut have = 0;
    let keep = if rows == 0 {
        0
    } else {
        morsels.iter().position(|m| {
            have += m.rows;
            have >= rows
        }).map_or(morsels.len(), |i| i + 1)
    };
    morsels.truncate(keep);
    morsels
}

/// Data pages per part a row group can be split into before the parts mostly
/// decompress the same pages again.
const PAGES_PER_PART: usize = 4;

/// How many parts a row group can be split into, from the data pages of the
/// biggest column chunk the scan reads in the first row group (counted from
/// the page headers, nothing is decompressed). A page is decompressed whole
/// by every part that reads a row of it: a writer that makes one page of a
/// column chunk (DuckDB does) leaves two parts decompressing the whole row
/// group each, which doubled the page memory of a wide scan and read nothing
/// faster. No limit when the pages cannot be counted.
fn max_parts(files: &[Arc<ParquetFile>], first: Option<&Morsel>, projection: &[usize]) -> usize {
    let pages = || -> Option<usize> {
        let m = first?;
        let f = &files[m.file];
        let crate::io::blob::Blob::Mapped(bytes) = &f.blob else { return None };
        let mask = ProjectionMask::roots(f.meta.parquet_schema(), projection.iter().copied());
        let rg = f.meta.metadata().row_group(m.row_group);
        let biggest = (0..rg.num_columns()).filter(|&c| mask.leaf_included(c)).max_by_key(|&c| rg.column(c).uncompressed_size())?;
        let mut reader = SerializedPageReader::new(Arc::new(bytes.clone()), rg.column(biggest), rg.num_rows() as usize, None).ok()?;
        let mut data_pages = 0;
        while let Some(page) = reader.peek_next_page().ok()? {
            data_pages += usize::from(!page.is_dict);
            reader.skip_next_page().ok()?;
        }
        Some(data_pages)
    };
    pages().map_or(usize::MAX, |p| 1 + p / PAGES_PER_PART)
}

/// Split row groups into row ranges (at most `max_parts` each) if there is
/// not enough parallelism.
fn split_for_parallelism(morsels: Vec<Morsel>, max_parts: usize) -> Vec<Morsel> {
    let target = rayon::current_num_threads() * 3;
    if morsels.is_empty() || morsels.len() >= target || max_parts <= 1 {
        return morsels;
    }
    let total_rows: usize = morsels.iter().map(|m| m.rows).sum();
    let per = (total_rows / target).max(1 << 16);
    let mut split = vec![];
    for m in morsels {
        let parts = m.rows.div_ceil(per).clamp(1, max_parts);
        if parts == 1 {
            split.push(m);
            continue;
        }
        let chunk = m.rows.div_ceil(parts);
        let mut start = 0;
        while start < m.rows {
            let len = chunk.min(m.rows - start);
            split.push(Morsel { range: Some((start, len)), rows: len, ..m.clone() });
            start += len;
        }
    }
    split
}

impl ParquetSource {
    /// The file (index into the scanned files) a morsel reads.
    pub fn morsel_file(&self, morsel: usize) -> usize {
        self.morsels[morsel].file
    }

    /// Where a morsel starts: (file, row group, first row in the row group).
    pub fn morsel_start(&self, morsel: usize) -> (usize, usize, usize) {
        let m = &self.morsels[morsel];
        (m.file, m.row_group, m.range.map_or(0, |r| r.0))
    }
}

impl Source for ParquetSource {
    fn num_morsels(&self) -> usize {
        self.morsels.len()
    }

    fn run_morsel(&self, morsel: usize, emit: Emit<'_>) -> Result<()> {
        let m = &self.morsels[morsel];
        if self.projection.is_empty() {
            return self.emit_counts(self.fetch.map_or(m.rows, |f| m.rows.min(f)), emit);
        }
        if let Some((bound, ranges)) = &self.bound {
            if ranges[morsel].is_some_and(|(min, max, nulls)| !bound.may_hold(min, max, nulls)) {
                // a prefetched morsel is still taken, or the prefetch window stalls
                if let Some(p) = &self.prefetch {
                    p.take(morsel, self.cancel.as_deref())?;
                }
                return Ok(());
            }
        }
        let f = &self.files[m.file];
        let meta = self.numbered.as_ref().map_or(&f.meta, |n| &n[m.file]);
        let mask = self.mask(m.file);
        let cancel = self.cancel.as_deref();
        let input = match &self.prefetch {
            Some(p) => p.take(morsel, cancel)?.chunks,
            None => f.blob.read(&chunk_ranges(&f.meta, m.row_group, &mask), cancel)?,
        };
        let Some(columns) = &self.columns else {
            let part = Part { meta, row_group: m.row_group, rows: m.range, limit: self.fetch, schema: &self.schema };
            let Some(late) = self.late_filter.as_ref().filter(|l| !l.idle()) else { return decode(input, mask, &part, None, emit) };
            // timed with the operators above: they filter what the scan did not
            let rg = f.meta.metadata().row_group(m.row_group);
            let chunks: i64 = (0..rg.num_columns()).filter(|&c| mask.leaf_included(c)).map(|c| rg.column(c).uncompressed_size()).sum();
            let bytes = (chunks.max(0) as u64).saturating_mul(m.rows as u64) / (rg.num_rows().max(1) as u64);
            let mode = late.choose();
            let start = std::time::Instant::now();
            decode(input, mask, &part, mode.early().then_some(late), emit)?;
            late.finished(mode, bytes, start.elapsed());
            return Ok(());
        };
        let c = &columns[m.file];
        let part = Part { meta, row_group: m.row_group, rows: m.range, limit: self.fetch, schema: &c.decoded };
        decode(input, mask, &part, None, &mut |b| emit(c.adapt(b, &self.schema)?))
    }

    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }

    fn describe(&self) -> String {
        let joins = self.late_filter.as_ref().map(|l| l.join_columns()).unwrap_or_default();
        format!(
            "ParquetScan[{}, files={}, row_groups={}/{}, morsels={}, columns={}{}]",
            scanned(&self.files),
            self.files.len(),
            self.row_groups_kept,
            self.row_groups_total,
            self.morsels.len(),
            self.projection.len(),
            if joins.is_empty() { String::new() } else { format!(", join_filter=[{}]", joins.join(", ")) }
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn morsels(rows: &[usize]) -> Vec<Morsel> {
        rows.iter().enumerate().map(|(i, &rows)| Morsel { file: 0, row_group: i, range: None, rows }).collect()
    }

    #[test]
    fn a_limit_keeps_the_first_row_groups_that_cover_it() {
        let rows = |m: Vec<Morsel>| m.iter().map(|m| m.row_group).collect::<Vec<_>>();
        assert_eq!(rows(enough_rows(morsels(&[100, 100, 100]), 10)), vec![0]);
        assert_eq!(rows(enough_rows(morsels(&[100, 100, 100]), 100)), vec![0]);
        assert_eq!(rows(enough_rows(morsels(&[100, 100, 100]), 101)), vec![0, 1]);
        assert_eq!(rows(enough_rows(morsels(&[100, 100, 100]), 1000)), vec![0, 1, 2]);
        assert!(enough_rows(morsels(&[100]), 0).is_empty());
    }
}
