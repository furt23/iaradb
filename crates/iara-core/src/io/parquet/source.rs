//! The parallel Parquet scan: one morsel per surviving row group (split into
//! row ranges when there are too few for the threads), with the column
//! chunks of remote files prefetched ahead of the workers, several row
//! groups of a file per fetch to keep the number of requests down.

use std::sync::Arc;

use arrow::datatypes::SchemaRef;
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use parquet::arrow::ProjectionMask;
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
use crate::expr::Expr;
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
}

pub struct ScanRequest<'a> {
    pub files: &'a [Arc<ParquetFile>],
    pub table_schema: &'a SchemaRef,
    pub projection: Vec<usize>,
    pub filters: &'a [Expr],
    pub fetch: Option<usize>,
    /// the files' columns are matched to the table's by name
    pub conform: bool,
}

impl ParquetSource {
    pub fn try_new(req: ScanRequest<'_>) -> Result<Self> {
        let schema = Arc::new(req.table_schema.project(&req.projection)?);
        let mut morsels = surviving_row_groups(req.files, req.table_schema, req.filters);
        let row_groups_kept = morsels.len();
        let row_groups_total = req.files.iter().map(|f| f.meta.metadata().num_row_groups()).sum();
        let remote = req.files.iter().any(|f| f.blob.object().is_some());
        // remote row groups are fetched whole: splitting them would fetch twice
        if !remote && req.fetch.is_none() && !req.projection.is_empty() {
            morsels = split_for_parallelism(morsels);
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
        };
        if !req.conform && req.fetch.is_none() {
            src.late_filter = LateFilter::new(req.table_schema, &src.projection, req.filters);
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

/// Split row groups into row ranges if there is not enough parallelism.
fn split_for_parallelism(morsels: Vec<Morsel>) -> Vec<Morsel> {
    let target = rayon::current_num_threads() * 3;
    if morsels.is_empty() || morsels.len() >= target {
        return morsels;
    }
    let total_rows: usize = morsels.iter().map(|m| m.rows).sum();
    let per = (total_rows / target).max(1 << 16);
    let mut split = vec![];
    for m in morsels {
        let parts = m.rows.div_ceil(per).max(1);
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
        let f = &self.files[m.file];
        let mask = self.mask(m.file);
        let cancel = self.cancel.as_deref();
        let input = match &self.prefetch {
            Some(p) => p.take(morsel, cancel)?.chunks,
            None => f.blob.read(&chunk_ranges(&f.meta, m.row_group, &mask), cancel)?,
        };
        let Some(columns) = &self.columns else {
            let part = Part { meta: &f.meta, row_group: m.row_group, rows: m.range, limit: self.fetch, schema: &self.schema };
            return decode(input, mask, &part, self.late_filter.as_ref(), emit);
        };
        let c = &columns[m.file];
        let part = Part { meta: &f.meta, row_group: m.row_group, rows: m.range, limit: self.fetch, schema: &c.decoded };
        decode(input, mask, &part, None, &mut |b| emit(c.adapt(b, &self.schema)?))
    }

    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }

    fn describe(&self) -> String {
        format!(
            "ParquetScan[files={}, row_groups={}/{}, morsels={}, columns={}]",
            self.files.len(),
            self.row_groups_kept,
            self.row_groups_total,
            self.morsels.len(),
            self.projection.len()
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
