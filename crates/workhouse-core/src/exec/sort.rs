//! Parallel sort and top-k.
//!
//! Under a memory limit ([`crate::exec::memory`]) a sort that does not fit
//! sorts what it holds into a run, spills it, and goes on; the output is a
//! k-way merge of the runs ([`crate::exec::merge`]). Runs carry each row's
//! original position (morsel, batch, row), so ties come out in the same
//! order as from an in-memory sort.

use std::cmp::Ordering;
use std::sync::Arc;

use arrow::array::*;
use arrow::compute::{SortOptions, take};
use arrow::datatypes::*;
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use arrow::row::{RowConverter, SortField};
use rayon::prelude::*;

use crate::error::Result;
use crate::exec::join::concat_parallel;
use crate::exec::memory::{self, Reservation};
use crate::exec::merge::{Merge, Run};
use crate::exec::pipeline::{Sink, rechunk, MORSEL_ROWS};
use crate::exec::spill::{SpillFile, SpillWriter};
use crate::physical::expr::PhysSortExpr;

fn sort_by_cmp<F>(idx: &mut Vec<u32>, limit: Option<usize>, cmp: F)
where
    F: Fn(usize, usize) -> Ordering + Sync,
{
    let c = |a: &u32, b: &u32| cmp(*a as usize, *b as usize).then(a.cmp(b));
    match limit {
        Some(0) => idx.clear(),
        Some(k) if k < idx.len() => {
            idx.select_nth_unstable_by(k - 1, c);
            idx.truncate(k);
            idx.sort_unstable_by(c);
        }
        _ => {
            if idx.len() > 1 << 15 {
                idx.par_sort_unstable_by(c);
            } else {
                idx.sort_unstable_by(c);
            }
        }
    }
}

pub fn sort_indices(keys: &[ArrayRef], opts: &[SortOptions], limit: Option<usize>) -> Result<Vec<u32>> {
    if limit.is_none() {
        if let Some(p) = crate::exec::packed_sort::sort(keys, opts) {
            return Ok(p.perm);
        }
    }
    let n = keys.first().map(|k| k.len()).unwrap_or(0);
    let mut idx: Vec<u32> = (0..n as u32).collect();
    if keys.len() == 1 && keys[0].null_count() == 0 {
        let desc = opts[0].descending;
        macro_rules! prim {
            ($t:ty) => {{
                let v = keys[0].as_primitive::<$t>().values();
                sort_by_cmp(&mut idx, limit, |a, b| {
                    let o = v[a].compare(v[b]);
                    if desc { o.reverse() } else { o }
                });
                return Ok(idx);
            }};
        }
        match keys[0].data_type() {
            DataType::Int8 => prim!(Int8Type),
            DataType::Int16 => prim!(Int16Type),
            DataType::Int32 => prim!(Int32Type),
            DataType::Int64 => prim!(Int64Type),
            DataType::UInt8 => prim!(UInt8Type),
            DataType::UInt16 => prim!(UInt16Type),
            DataType::UInt32 => prim!(UInt32Type),
            DataType::UInt64 => prim!(UInt64Type),
            DataType::Float32 => prim!(Float32Type),
            DataType::Float64 => prim!(Float64Type),
            DataType::Date32 => prim!(Date32Type),
            DataType::Decimal128(_, _) => prim!(Decimal128Type),
            DataType::Timestamp(TimeUnit::Microsecond, _) => prim!(TimestampMicrosecondType),
            DataType::Timestamp(TimeUnit::Nanosecond, _) => prim!(TimestampNanosecondType),
            _ => {}
        }
    }
    let fields = keys
        .iter()
        .zip(opts)
        .map(|(k, o)| SortField::new_with_options(k.data_type().clone(), *o))
        .collect();
    let conv = RowConverter::new(fields)?;
    let rows = conv.convert_columns(keys)?;
    sort_by_cmp(&mut idx, limit, |a, b| rows.row(a).cmp(&rows.row(b)));
    Ok(idx)
}

pub fn take_batch(batch: &RecordBatch, idx: &[u32]) -> Result<RecordBatch> {
    let indices = UInt32Array::from(idx.to_vec());
    let cols = batch
        .columns()
        .par_iter()
        .map(|c| take(c, &indices, None))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(RecordBatch::try_new_with_options(
        batch.schema(),
        cols,
        &RecordBatchOptions::new().with_row_count(Some(idx.len())),
    )?)
}

pub struct SortSink {
    pub keys: Vec<PhysSortExpr>,
    pub fetch: Option<usize>,
    pub schema: SchemaRef,
}

pub struct SortLocal {
    batches: Vec<(usize, usize, RecordBatch)>,
    rows: usize,
    seq: usize,
    reservation: Reservation,
    /// sorted runs spilled by this worker
    runs: Vec<SpillFile>,
}

/// Rows per batch of a spilled run.
const RUN_BATCH: usize = 1 << 16;

impl SortSink {
    fn opts(&self) -> Vec<SortOptions> {
        self.keys
            .iter()
            .map(|k| SortOptions { descending: k.descending, nulls_first: k.nulls_first })
            .collect()
    }

    fn sort_batch(&self, batch: &RecordBatch, limit: Option<usize>) -> Result<RecordBatch> {
        let keys = self.keys.iter().map(|k| k.expr.evaluate_array(batch)).collect::<Result<Vec<_>>>()?;
        let idx = sort_indices(&keys, &self.opts(), limit)?;
        take_batch(batch, &idx)
    }

    // -- external sort ---------------------------------------------------------

    /// The input's columns plus the position columns of runs.
    fn run_schema(&self) -> SchemaRef {
        let mut fields: Vec<Field> = self.schema.fields().iter().map(|f| f.as_ref().clone()).collect();
        fields.push(Field::new("__morsel", DataType::UInt32, false));
        fields.push(Field::new("__row", DataType::UInt64, false));
        Arc::new(Schema::new(fields))
    }

    /// A batch with its rows' original positions appended.
    fn with_position(&self, schema: &SchemaRef, morsel: usize, seq: usize, b: &RecordBatch) -> Result<RecordBatch> {
        let n = b.num_rows();
        let mut cols = b.columns().to_vec();
        cols.push(Arc::new(UInt32Array::from(vec![morsel as u32; n])));
        cols.push(Arc::new(UInt64Array::from_iter_values((0..n as u64).map(|r| ((seq as u64) << 32) | r))));
        Ok(RecordBatch::try_new_with_options(schema.clone(), cols, &RecordBatchOptions::new().with_row_count(Some(n)))?)
    }


    /// Sort a worker's buffered batches into one run (in memory).
    fn sorted_run(&self, batches: Vec<(usize, usize, RecordBatch)>) -> Result<Vec<RecordBatch>> {
        if batches.is_empty() {
            return Ok(vec![]);
        }
        let schema = self.run_schema();
        let with_pos = batches.iter().map(|(m, s, b)| self.with_position(&schema, *m, *s, b)).collect::<Result<Vec<_>>>()?;
        let all = concat_parallel(&schema, &with_pos)?;
        let mut opts = self.opts();
        opts.extend([SortOptions::default(), SortOptions::default()]);
        let idx = sort_indices(&run_keys(&self.keys, &all)?, &opts, None)?;
        Ok(idx.chunks(RUN_BATCH).map(|c| take_batch(&all, c)).collect::<Result<Vec<_>>>()?)
    }

    /// Spill the worker's buffered rows as a sorted run.
    fn spill_run(&self, l: &mut SortLocal) -> Result<()> {
        let run = self.sorted_run(std::mem::take(&mut l.batches))?;
        let mut w = SpillWriter::try_new(self.run_schema())?;
        for b in &run {
            w.write(b)?;
        }
        l.runs.push(w.finish()?);
        l.rows = 0;
        l.reservation.free();
        Ok(())
    }

    /// Spilled and in-memory runs, ready to be merged.
    fn runs(&self, locals: Vec<SortLocal>) -> Result<RunMerge> {
        let mut files = vec![];
        let mut runs: Vec<Run> = vec![];
        for mut l in locals {
            let in_memory = self.sorted_run(std::mem::take(&mut l.batches))?;
            runs.push(Box::new(in_memory.into_iter().map(Ok)));
            for f in &l.runs {
                runs.push(Box::new(f.read()?));
            }
            files.extend(l.runs.drain(..)); // deleted once merged
        }
        if crate::exec::pipeline::profiling() {
            let bytes: u64 = files.iter().map(|f| f.bytes()).sum();
            eprintln!("[workhouse]   sort: {} runs to merge ({:.1} MB spilled)", runs.len(), bytes as f64 / 1e6);
        }
        Ok(RunMerge { keys: self.keys.clone(), schema: self.schema.clone(), run_schema: self.run_schema(), runs, _files: files })
    }
}

/// Sort keys of a run batch: the query's keys, then the position (ties).
fn run_keys(keys: &[PhysSortExpr], b: &RecordBatch) -> Result<Vec<ArrayRef>> {
    let mut out = keys.iter().map(|k| k.expr.evaluate_array(b)).collect::<Result<Vec<_>>>()?;
    let n = b.num_columns();
    out.push(b.column(n - 2).clone());
    out.push(b.column(n - 1).clone());
    Ok(out)
}

/// A sort's result: batches, or sorted runs merged as they are read.
pub enum Sorted {
    Batches(Vec<RecordBatch>),
    Runs(RunMerge),
}

pub struct RunMerge {
    keys: Vec<PhysSortExpr>,
    schema: SchemaRef,
    run_schema: SchemaRef,
    runs: Vec<Run>,
    /// the runs' files, deleted with the merge
    _files: Vec<SpillFile>,
}

impl RunMerge {
    /// Merge the runs, emitting the sorted rows batch by batch.
    pub fn emit(self, emit: &mut dyn FnMut(RecordBatch) -> Result<()>) -> Result<()> {
        let mut fields: Vec<SortField> = self
            .keys
            .iter()
            .map(|k| SortField::new_with_options(k.expr.data_type(), SortOptions { descending: k.descending, nulls_first: k.nulls_first }))
            .collect();
        fields.push(SortField::new(DataType::UInt32));
        fields.push(SortField::new(DataType::UInt64));
        let width = self.schema.fields().len();
        let keys = self.keys.clone();
        let merge = Merge::new(fields, move |b: &RecordBatch| run_keys(&keys, b), self.run_schema.clone(), MORSEL_ROWS)?;
        merge.run(self.runs, |b| {
            let cols = b.columns()[..width].to_vec();
            let opts = RecordBatchOptions::new().with_row_count(Some(b.num_rows()));
            emit(RecordBatch::try_new_with_options(self.schema.clone(), cols, &opts)?)
        })
    }
}

impl Sorted {
    pub fn into_batches(self) -> Result<Vec<RecordBatch>> {
        match self {
            Sorted::Batches(b) => Ok(b),
            Sorted::Runs(m) => {
                let mut out = vec![];
                m.emit(&mut |b| {
                    out.push(b);
                    Ok(())
                })?;
                Ok(out)
            }
        }
    }

    pub fn emit(self, emit: &mut dyn FnMut(RecordBatch) -> Result<()>) -> Result<()> {
        match self {
            Sorted::Batches(batches) => batches.into_iter().try_for_each(emit),
            Sorted::Runs(m) => m.emit(emit),
        }
    }
}

impl Sink for SortSink {
    type Local = Result<SortLocal>;
    type Output = Sorted;

    fn make_local(&self) -> Self::Local {
        Ok(SortLocal { batches: vec![], rows: 0, seq: 0, reservation: memory::pool().reservation(), runs: vec![] })
    }

    fn push(&self, local: &mut Self::Local, morsel: usize, batch: RecordBatch) -> Result<()> {
        let l = match local {
            Ok(l) => l,
            Err(e) => return Err(crate::error::WhError::Execution(e.to_string())),
        };
        if batch.num_rows() == 0 {
            return Ok(());
        }
        if self.fetch.is_none() {
            // sorting holds the rows about twice (concatenated, then taken in order)
            let bytes = batch.get_array_memory_size() * 2;
            if !l.reservation.try_grow(bytes) {
                if !l.batches.is_empty() {
                    self.spill_run(l)?;
                }
                if !l.reservation.try_grow(bytes) {
                    l.reservation.grow(bytes);
                }
            }
        }
        l.rows += batch.num_rows();
        l.batches.push((morsel, l.seq, batch));
        l.seq += 1;
        if let Some(k) = self.fetch {
            if l.rows > (2 * k).max(1 << 16) {
                let batches: Vec<RecordBatch> = l.batches.drain(..).map(|(_, _, b)| b).collect();
                let all = concat_parallel(&self.schema, &batches)?;
                let top = self.sort_batch(&all, Some(k))?;
                l.rows = top.num_rows();
                l.batches.push((morsel, l.seq, top));
                l.seq += 1;
            }
        }
        Ok(())
    }

    fn finalize(&self, locals: Vec<Self::Local>) -> Result<Sorted> {
        let locals = locals.into_iter().collect::<Result<Vec<_>>>()?;
        if locals.iter().any(|l| !l.runs.is_empty()) {
            return Ok(Sorted::Runs(self.runs(locals)?));
        }
        let mut all = vec![];
        for l in locals {
            all.extend(l.batches);
        }
        all.sort_unstable_by_key(|(m, s, _)| (*m, *s));
        let batches: Vec<RecordBatch> = all.into_iter().map(|(_, _, b)| b).collect();
        if batches.is_empty() {
            return Ok(Sorted::Batches(vec![]));
        }
        let batch = concat_parallel(&self.schema, &batches)?;
        let sorted = self.sort_batch(&batch, self.fetch)?;
        Ok(Sorted::Batches(rechunk(vec![sorted], MORSEL_ROWS)))
    }
}
