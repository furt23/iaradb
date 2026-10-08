//! The parallel Parquet scan: one morsel per surviving row group (split into
//! row ranges when there are too few for the threads), with the column
//! chunks of remote files prefetched ahead of the workers.

use std::sync::Arc;

use arrow::datatypes::SchemaRef;
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use parquet::arrow::ProjectionMask;
use rayon::prelude::*;

use super::batch_size;
use super::decode::{Part, chunk_ranges, decode};
use super::file::ParquetFile;
use super::prune::keep_row_groups;
use crate::error::Result;
use crate::exec::pipeline::{Emit, Source};
use crate::exec::query::QueryHandle;
use crate::expr::Expr;
use crate::io::object::prefetch::{self, FetchJob, Prefetcher};

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
}

pub struct ScanRequest<'a> {
    pub files: &'a [Arc<ParquetFile>],
    pub table_schema: &'a SchemaRef,
    pub projection: Vec<usize>,
    pub filters: &'a [Expr],
    pub fetch: Option<usize>,
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
        };
        if remote && !src.projection.is_empty() {
            src.prefetch = src.prefetcher();
        }
        Ok(src)
    }

    fn mask(&self, file: &ParquetFile) -> ProjectionMask {
        ProjectionMask::roots(file.meta.parquet_schema(), self.projection.iter().copied())
    }

    fn prefetcher(&self) -> Option<Prefetcher> {
        let window = match self.fetch {
            Some(_) => 2, // a LIMIT rarely needs much
            None => prefetch::window(),
        };
        if window == 0 {
            return None;
        }
        let jobs = self.morsels.iter().map(|m| {
            let f = &self.files[m.file];
            let ranges = chunk_ranges(&f.meta, m.row_group, &self.mask(f));
            f.blob.object().map(|o| FetchJob { file: o.clone(), ranges })
        });
        Some(Prefetcher::new(jobs.collect::<Option<Vec<_>>>()?, window))
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
        let mask = self.mask(f);
        let cancel = self.cancel.as_deref();
        let input = match &self.prefetch {
            Some(p) => p.take(morsel, cancel)?.chunks,
            None => f.blob.read(&chunk_ranges(&f.meta, m.row_group, &mask), cancel)?,
        };
        let part = Part { meta: &f.meta, row_group: m.row_group, rows: m.range, limit: self.fetch, schema: &self.schema };
        decode(input, mask, &part, emit)
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
