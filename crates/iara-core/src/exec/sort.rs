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
use crate::exec::topk_bound::TopKBound;
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

fn gather_byte_view<T: arrow::datatypes::ByteViewType>(arrays: &[&dyn Array], at: &[(usize, usize)], has_nulls: bool) -> ArrayRef {
    use arrow::buffer::{Buffer, NullBuffer, ScalarBuffer};
    let mut views = Vec::with_capacity(at.len());
    let mut data: Vec<u8> = Vec::new();
    let mut buffers: Vec<Buffer> = Vec::new();
    let nulls = if has_nulls {
        let mut b = BooleanBufferBuilder::new(at.len());
        for &(bi, row) in at {
            let a = arrays[bi].as_byte_view::<T>();
            if a.is_null(row) {
                b.append(false);
                views.push(0);
            } else {
                b.append(true);
                let v = a.views()[row];
                if (v as u32) <= 12 {
                    views.push(v);
                } else {
                    let bytes: &[u8] = a.value(row).as_ref();
                    if data.len() + bytes.len() > u32::MAX as usize {
                        buffers.push(Buffer::from_vec(std::mem::take(&mut data)));
                    }
                    let buf_idx = buffers.len() as u128;
                    let offset = data.len() as u128;
                    data.extend_from_slice(bytes);
                    views.push((v & 0xFFFF_FFFF_FFFF_FFFF) | (buf_idx << 64) | (offset << 96));
                }
            }
        }
        Some(NullBuffer::new(b.finish())).filter(|n| n.null_count() > 0)
    } else {
        for &(bi, row) in at {
            let a = arrays[bi].as_byte_view::<T>();
            let v = a.views()[row];
            if (v as u32) <= 12 {
                views.push(v);
            } else {
                let bytes: &[u8] = a.value(row).as_ref();
                if data.len() + bytes.len() > u32::MAX as usize {
                    buffers.push(Buffer::from_vec(std::mem::take(&mut data)));
                }
                let buf_idx = buffers.len() as u128;
                let offset = data.len() as u128;
                data.extend_from_slice(bytes);
                views.push((v & 0xFFFF_FFFF_FFFF_FFFF) | (buf_idx << 64) | (offset << 96));
            }
        }
        None
    };
    if !data.is_empty() {
        buffers.push(Buffer::from_vec(data));
    }
    // SAFETY: views and buffers are constructed from valid GenericByteViewArray<T> values
    Arc::new(unsafe { GenericByteViewArray::<T>::new_unchecked(ScalarBuffer::from(views), Arc::from(buffers), nulls) })
}

/// The rows `idx` (positions in the concatenation of `batches`) as batches
/// of `chunk` rows, gathered in parallel; strings are copied into each
/// chunk's own buffers.
pub fn gather(schema: &SchemaRef, batches: &[RecordBatch], idx: &[u32], chunk: usize) -> Result<Vec<RecordBatch>> {
    if idx.is_empty() {
        return Ok(vec![]);
    }
    let uniform = batches.first().map(|b| b.num_rows() as u32).filter(|&b0| {
        b0 > 0
            && batches[..batches.len().saturating_sub(1)].iter().all(|b| b.num_rows() as u32 == b0)
            && batches.last().is_some_and(|b| b.num_rows() as u32 <= b0)
    });
    let starts = if uniform.is_none() {
        let mut s = Vec::with_capacity(batches.len() + 1);
        let mut total = 0u32;
        for b in batches {
            s.push(total);
            total += b.num_rows() as u32;
        }
        s.push(total);
        s
    } else {
        Vec::new()
    };
    let locate = |i: u32| match uniform {
        Some(b0) => ((i / b0) as usize, (i % b0) as usize),
        None => {
            let b = starts.partition_point(|&s| s <= i) - 1;
            (b, (i - starts[b]) as usize)
        }
    };
    let col_arrays: Vec<Vec<&dyn Array>> = (0..schema.fields().len())
        .map(|c| batches.iter().map(|b| b.column(c).as_ref()).collect())
        .collect();
    let col_has_nulls: Vec<bool> = col_arrays.iter().map(|arrays| arrays.iter().any(|a| a.null_count() > 0)).collect();
    idx.par_chunks(chunk.max(1))
        .map(|part| {
            let at: Vec<(usize, usize)> = part.iter().map(|&i| locate(i)).collect();
            let cols = (0..schema.fields().len())
                .map(|c| {
                    let arrays = &col_arrays[c];
                    match schema.field(c).data_type() {
                        DataType::Utf8View => Ok(gather_byte_view::<arrow::datatypes::StringViewType>(arrays, &at, col_has_nulls[c])),
                        DataType::BinaryView => Ok(gather_byte_view::<arrow::datatypes::BinaryViewType>(arrays, &at, col_has_nulls[c])),
                        _ => Ok(arrow::compute::interleave(arrays, &at)?),
                    }
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(RecordBatch::try_new_with_options(schema.clone(), cols, &RecordBatchOptions::new().with_row_count(Some(part.len())))?)
        })
        .collect()
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
    /// a top k's running bound on its first key, shared with the scan below
    pub bound: Option<Arc<TopKBound>>,
    /// the input batches are resident (see [`crate::exec::pipeline::Source::resident`]):
    /// only the sort's own keys and positions take memory
    pub resident: bool,
}

pub struct SortLocal {
    batches: Vec<(usize, usize, RecordBatch)>,
    rows: usize,
    seq: usize,
    reservation: Reservation,
    /// sorted runs spilled by this worker
    runs: Vec<SpillFile>,
    /// this worker has offered a top k's bound
    offered: bool,
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
    /// A worker's buffered batches as one sorted run, gathered `RUN_BATCH`
    /// rows at a time as it is read: only the keys are put together.
    fn sorted_run(&self, batches: Vec<(usize, usize, RecordBatch)>) -> Result<Gather> {
        let schema = self.run_schema();
        if batches.is_empty() {
            return Ok(Gather { schema, batches: vec![], idx: vec![], _held: vec![] });
        }
        let with_pos = batches.iter().map(|(m, s, b)| self.with_position(&schema, *m, *s, b)).collect::<Result<Vec<_>>>()?;
        drop(batches);
        let mut opts = self.opts();
        opts.extend([SortOptions::default(), SortOptions::default()]);
        let keys = with_pos.par_iter().map(|b| run_keys(&self.keys, b)).collect::<Result<Vec<_>>>()?;
        let keys = (0..opts.len())
            .map(|k| {
                let parts: Vec<&dyn Array> = keys.iter().map(|b| b[k].as_ref()).collect();
                Ok(arrow::compute::concat(&parts)?)
            })
            .collect::<Result<Vec<_>>>()?;
        let idx = sort_indices(&keys, &opts, None)?;
        Ok(Gather { schema, batches: with_pos, idx, _held: vec![] })
    }

    /// Spill the worker's buffered rows as a sorted run.
    fn spill_run(&self, l: &mut SortLocal) -> Result<()> {
        let run = self.sorted_run(std::mem::take(&mut l.batches))?;
        let mut w = SpillWriter::try_new(self.run_schema())?;
        for b in run.chunks(RUN_BATCH) {
            w.write(&b?)?;
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
            let mut in_memory = self.sorted_run(std::mem::take(&mut l.batches))?;
            in_memory._held.push(std::mem::replace(&mut l.reservation, memory::pool().reservation()));
            runs.push(Box::new(in_memory.chunks(RUN_BATCH)));
            for f in &l.runs {
                runs.push(Box::new(f.read()?));
            }
            files.extend(l.runs.drain(..)); // deleted once merged
        }
        if crate::exec::pipeline::profiling() {
            let bytes: u64 = files.iter().map(|f| f.bytes()).sum();
            eprintln!("[iara]   sort: {} runs to merge ({:.1} MB spilled)", runs.len(), bytes as f64 / 1e6);
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
    /// input batches and the sorted order, gathered as they are read
    Gather(Gather),
    Runs(RunMerge),
}

/// An in-memory sort's result: the rows `idx` of `batches`. Streamed, it is
/// gathered a few chunks at a time, so the sorted copy does not exist in
/// full next to the input.
pub struct Gather {
    schema: SchemaRef,
    batches: Vec<RecordBatch>,
    idx: Vec<u32>,
    /// the sort's reservations: the input stays held until it is gathered
    _held: Vec<Reservation>,
}

impl Gather {
    pub fn into_parts(self) -> (SchemaRef, Vec<RecordBatch>, Vec<u32>) {
        (self.schema, self.batches, self.idx)
    }

    /// The sorted rows, `chunk` at a time, gathered one batch per call.
    fn chunks(self, chunk: usize) -> impl Iterator<Item = Result<RecordBatch>> + Send {
        let n = self.idx.len();
        (0..n.div_ceil(chunk.max(1))).map(move |i| {
            let part = &self.idx[i * chunk..((i + 1) * chunk).min(n)];
            Ok(gather(&self.schema, &self.batches, part, chunk)?.pop().expect("one chunk"))
        })
    }

    fn emit(self, emit: &mut dyn FnMut(RecordBatch) -> Result<()>) -> Result<()> {
        let window = MORSEL_ROWS * rayon::current_num_threads();
        for part in self.idx.chunks(window) {
            for b in gather(&self.schema, &self.batches, part, MORSEL_ROWS)? {
                emit(b)?;
            }
        }
        Ok(())
    }
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
    /// Rows and batches the result is read as (None: a merge of runs, whose
    /// rows are only known once merged).
    pub fn output(&self) -> Option<(u64, u64)> {
        match self {
            Sorted::Batches(b) => Some((crate::exec::metrics::rows_of(b), b.len() as u64)),
            Sorted::Gather(g) => Some((g.idx.len() as u64, g.idx.len().div_ceil(MORSEL_ROWS) as u64)),
            Sorted::Runs(_) => None,
        }
    }

    pub fn into_batches(self) -> Result<Vec<RecordBatch>> {
        match self {
            Sorted::Batches(b) => Ok(b),
            Sorted::Gather(g) => gather(&g.schema, &g.batches, &g.idx, MORSEL_ROWS),
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
            Sorted::Gather(g) => g.emit(emit),
            Sorted::Runs(m) => m.emit(emit),
        }
    }
}

impl Sink for SortSink {
    type Local = Result<SortLocal>;
    type Output = Sorted;

    fn make_local(&self) -> Self::Local {
        Ok(SortLocal { batches: vec![], rows: 0, seq: 0, reservation: memory::pool().reservation(), runs: vec![], offered: false })
    }

    fn push(&self, local: &mut Self::Local, morsel: usize, batch: RecordBatch) -> Result<()> {
        let l = match local {
            Ok(l) => l,
            Err(e) => return Err(crate::error::WhError::Execution(e.to_string())),
        };
        if batch.num_rows() == 0 {
            return Ok(());
        }
        let batch = if self.fetch.is_none() && !self.resident { crate::exec::batch_mem::compact(batch)? } else { batch };
        if self.fetch.is_none() {
            // the rows, plus their keys and sorted positions; the sorted rows
            // are gathered from them a few chunks at a time
            let held = if self.resident { 0 } else { crate::exec::batch_mem::batch_bytes(&batch) };
            let bytes = held + batch.num_rows() * 24;
            if !l.reservation.try_grow(bytes) {
                if !l.batches.is_empty() {
                    self.spill_run(l)?;
                }
                if !l.reservation.try_grow(bytes) {
                    l.reservation.grow(bytes);
                }
            }
        }
        // rows past the top k's bound cannot make it
        let batch = match &self.bound {
            Some(bound) => match bound.mask(&self.keys[0].expr.evaluate_array(&batch)?) {
                Some(keep) if keep.true_count() < batch.num_rows() => arrow::compute::filter_record_batch(&batch, &keep)?,
                _ => batch,
            },
            None => batch,
        };
        if batch.num_rows() == 0 {
            return Ok(());
        }
        l.rows += batch.num_rows();
        l.batches.push((morsel, l.seq, batch));
        l.seq += 1;
        if let Some(k) = self.fetch {
            let due = match &self.bound {
                // the first k rows set the bound (a selective filter may pass few
                // rows per worker), and each compaction tightens it
                Some(_) if !l.offered => l.rows >= k.max(1),
                Some(_) => l.rows > (2 * k).max(1 << 12),
                None => l.rows > (2 * k).max(1 << 16),
            };
            if due {
                let batches: Vec<RecordBatch> = l.batches.drain(..).map(|(_, _, b)| b).collect();
                let all = concat_parallel(&self.schema, &batches)?;
                let top = self.sort_batch(&all, Some(k))?;
                if let (Some(bound), true) = (&self.bound, k > 0 && top.num_rows() == k) {
                    bound.offer(self.keys[0].expr.evaluate_array(&top)?.as_ref(), k - 1);
                    l.offered = true;
                }
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
        let mut held = vec![];
        for l in locals {
            all.extend(l.batches);
            held.push(l.reservation);
        }
        all.sort_unstable_by_key(|(m, s, _)| (*m, *s));
        let batches: Vec<RecordBatch> = all.into_iter().map(|(_, _, b)| b).collect();
        if batches.is_empty() {
            return Ok(Sorted::Batches(vec![]));
        }
        if self.fetch.is_some() {
            let batch = concat_parallel(&self.schema, &batches)?;
            let sorted = self.sort_batch(&batch, self.fetch)?;
            return Ok(Sorted::Batches(rechunk(vec![sorted], MORSEL_ROWS)));
        }
        // only the keys are concatenated; the rows are gathered from the
        // input batches straight into the output chunks
        let keys = batches
            .par_iter()
            .map(|b| self.keys.iter().map(|k| k.expr.evaluate_array(b)).collect::<Result<Vec<_>>>())
            .collect::<Result<Vec<_>>>()?;
        let keys = (0..self.keys.len())
            .map(|k| {
                let parts: Vec<&dyn Array> = keys.iter().map(|b| b[k].as_ref()).collect();
                Ok(arrow::compute::concat(&parts)?)
            })
            .collect::<Result<Vec<_>>>()?;
        let idx = sort_indices(&keys, &self.opts(), None)?;
        drop(keys);
        Ok(Sorted::Gather(Gather { schema: self.schema.clone(), batches, idx, _held: held }))
    }
}
