//! Parallel, adaptive hash aggregation.
//!
//! Phase 1 (streaming, per worker thread): every worker starts by
//! pre-aggregating its morsels into a thread-local table (dense group ids +
//! accumulator states). That is ideal for low/medium cardinality.
//! A local table that grows large while still folding several rows into each
//! group (skewed keys: a few values on most rows, many rare ones) is handed
//! over whole, to be merged at the end, and the worker starts a new one: the
//! frequent values keep being aggregated where they are read.
//! If the local table grows large while reducing the input poorly (few rows
//! per group, typical for `GROUP BY <id>`), the worker switches to *radix
//! mode*: it stops pre-aggregating and scatters the evaluated input rows by
//! hash partition (one `take` per column + zero-copy slices). The P
//! partitions are shared by all workers. Slices wait in their partition as
//! raw rows while they fit the partition's share of the memory budget; a
//! partition whose share fills folds its rows into its table, many at once
//! (the table's pages and cache lines are reused across the run). So memory
//! stays bounded when the input has many more rows than groups, and rows
//! that fit are aggregated partition by partition at the end, in cache.
//! Adding a slice and folding take separate locks, so workers adding rows
//! never wait for a fold.
//!
//! Phase 2 (finalize): small results are merged sequentially. Otherwise each
//! partition is finished by one task: it folds the rows still waiting and
//! the partition's spilled rows into its table, then merges the matching
//! groups of the thread-local tables.
//!
//! Under a memory limit ([`crate::exec::memory`]) the tables and waiting
//! slices reserve what they hold. A thread-local table that cannot grow
//! switches its worker to radix mode. Once a partition table cannot grow,
//! radix rows stop going to the tables: workers buffer them by partition and
//! spill the buffers to one file per partition ([`crate::exec::agg_spill`]),
//! which the finalize folds into the partition's table.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, OnceLock};

use arrow::array::*;
use arrow::compute::{SortOptions, take};
use arrow::datatypes::{DataType, Float64Type, SchemaRef};
use arrow::record_batch::RecordBatch;
use parking_lot::Mutex;
use rayon::prelude::*;

use crate::error::{Result, WhError};
use crate::exec::acc_list::{ListAcc, ListSpec};
use crate::exec::acc_rows::{AccInput, AccPart, AccSet, DecimalMeanRow, MeanRow, RowAcc};
use crate::exec::accumulators::{create_accumulator, create_row_accumulator};
use crate::exec::agg_spill::{AggSpill, arrays_bytes, group_bytes};
use crate::exec::groupby::GroupKeys;
use crate::exec::memory::{self, Reservation};
use crate::exec::ops::make_batch;
use crate::exec::pipeline::Sink;
use crate::expr::AggFunc;
use crate::hash::hash_columns;
use crate::physical::expr::PhysExpr;

#[derive(Debug, Clone)]
pub struct AggregateExpr {
    pub func: AggFunc,
    pub args: Vec<PhysExpr>,
    pub distinct: bool,
    pub filter: Option<PhysExpr>,
    pub input_type: Option<DataType>,
    pub name: String,
    /// `ORDER BY` inside the call: the keys are `args[1..]`
    pub order: Vec<SortOptions>,
}

impl AggregateExpr {
    /// The aggregate's part of a group table's accumulators.
    fn acc_part(&self) -> Result<AccPart> {
        if self.collects() {
            return Ok(AccPart::Own(Box::new(ListAcc::new(self.list_spec()))));
        }
        if let Some(acc) = create_row_accumulator(self.func, self.input_type.as_ref(), self.distinct) {
            return Ok(AccPart::Row(acc));
        }
        Ok(AccPart::Own(create_accumulator(self.func, self.input_type.as_ref(), self.distinct)?))
    }

    /// `array_agg` and friends: they keep rows and need the scan position of each.
    pub fn collects(&self) -> bool {
        matches!(self.func, AggFunc::ArrayAgg | AggFunc::CollectList | AggFunc::CollectSet)
    }

    fn list_spec(&self) -> ListSpec {
        ListSpec {
            elem: self.input_type.clone().unwrap_or(DataType::Null),
            keys: self.args[1..].iter().map(|k| k.data_type()).zip(self.order.iter().copied()).collect(),
            skip_nulls: self.func != AggFunc::ArrayAgg,
            distinct: self.distinct || self.func == AggFunc::CollectSet,
            null_if_empty: self.func == AggFunc::ArrayAgg,
        }
    }

    /// Columns of one input row of this aggregate in a chunk: the arguments
    /// and the scan position when the aggregate collects.
    pub fn input_arity(&self) -> usize {
        self.args.len() + usize::from(self.collects())
    }
}

pub struct AggregateSink {
    pub group_exprs: Vec<PhysExpr>,
    pub group_types: Vec<DataType>,
    pub aggs: Vec<AggregateExpr>,
    pub schema: SchemaRef,
    /// estimated bytes of one group in a pre-aggregation table
    per_group: usize,
    /// the planner's estimate of the input rows
    est_rows: Option<f64>,
    /// the morsels of the input pipeline's source: with the rows a worker
    /// got from the morsels it ran, an estimate of the input rows that
    /// accounts for the filters (the planner's often does not)
    pub morsels: Option<usize>,
    /// radix mode: the hash partitions, shared by all workers, made when the
    /// first worker switches to it (or for a partitioned finalize)
    radix: OnceLock<Radix>,
    /// set once a partition table could not grow: radix rows go to the spill
    spilling: AtomicBool,
    /// workers created so far (spreads their first partition)
    workers: AtomicUsize,
    /// the key columns rows are partitioned by, fixed by the first worker to
    /// switch to radix mode
    part_cols: OnceLock<Vec<usize>>,
    /// full thread-local tables handed over, merged in the finalize
    flushed: Mutex<Vec<AggLocal>>,
    /// a LIMIT above with no ORDER BY between: this many groups will do, and
    /// the partitioned finalize stops once it has them (each partition holds
    /// complete groups)
    pub fetch: Option<usize>,
    /// a key column's values are each in one morsel of the input (see
    /// [`crate::exec::pipeline::Source::morsel_confined`]), so no group
    /// spans two: a worker's table is final at the end of each morsel and
    /// is emitted there, with no radix mode and nothing to merge
    pub confined: bool,
}

/// The hash partitions of radix mode: as many as keep about
/// [`GROUPS_PER_PARTITION`] groups each, so a partition's table stays in cache.
struct Radix {
    parts: Vec<Part>,
    spill: AggSpill,
    /// bytes of waiting rows that make a partition fold them
    fold_bytes: usize,
}

impl Radix {
    fn new(groups: f64) -> Self {
        let n = num_partitions(groups);
        Self {
            parts: (0..n).map(|_| Part { waiting: Mutex::new(Waiting::new()), table: Mutex::new(None) }).collect(),
            spill: AggSpill::new(n),
            fold_bytes: fold_bytes(n),
        }
    }
}

/// Evaluated input columns of one partition chunk:
/// `[keys..., agg0 args..., agg0 filter?, agg1 args..., ...]`, then (one key
/// column, not spilling) the rows' partition hashes as a `UInt64` column.
type Chunk = Vec<ArrayRef>;

/// The groups of one hash partition.
struct PartTable {
    keys: GroupKeys,
    accs: AccSet,
    gids: Vec<u32>,
    reservation: Reservation,
    bytes: usize,
}

/// One hash partition of radix mode: rows are added to `waiting` under a
/// short lock; folding them into `table` takes another, so adding rows
/// never waits for a fold.
struct Part {
    waiting: Mutex<Waiting>,
    table: Mutex<Option<PartTable>>,
}

/// Slices waiting to be folded together, and the memory they hold.
struct Waiting {
    chunks: Vec<Chunk>,
    reservation: Reservation,
}

impl Waiting {
    fn new() -> Self {
        Self { chunks: vec![], reservation: memory::pool().reservation() }
    }
}

pub struct AggLocal {
    keys: Option<GroupKeys>,
    accs: AccSet,
    gids: Vec<u32>,
    rows: usize,
    /// rows folded into the current table
    table_rows: usize,
    /// rows go to the shared partitions
    radix: bool,
    /// radix mode while spilling: partition -> chunks waiting for the spill files
    buffered: Vec<Vec<Chunk>>,
    hashes: Vec<u64>,
    /// radix mode: small evaluated batches waiting to be scattered together
    pending: Vec<Chunk>,
    pending_rows: usize,
    /// memory held by the table and the in-memory buffers
    reservation: Reservation,
    table_bytes: usize,
    buffered_bytes: usize,
    /// scan position of the next row: (morsel, rows of it seen so far)
    seq: (usize, u64),
    /// morsels the worker took rows from, and its rows before the current one
    morsels_seen: usize,
    finished_rows: usize,
    /// the worker's number (spreads the partition it visits first)
    worker: usize,
    /// confined keys: the finished groups of the morsels run so far
    done: Vec<RecordBatch>,
}

impl AggLocal {
    fn num_groups(&self) -> usize {
        match &self.keys {
            Some(k) => k.len(),
            None => 1,
        }
    }

    /// The scan position of the next `n` rows of `morsel`: the morsel in the
    /// high bits, the rows of it already seen below.
    fn next_seq(&mut self, morsel: usize, n: usize) -> u64 {
        if self.seq.0 != morsel {
            self.seq = (morsel, 0);
            self.morsels_seen += 1;
        }
        let at = ((morsel as u64) << 40) + self.seq.1;
        self.seq.1 += n as u64;
        at
    }
}

/// Up to this many groups in total, thread-local tables are merged sequentially.
const SEQUENTIAL_MERGE_LIMIT: usize = 1 << 15;
/// ... and up to this many when an accumulator merges its whole state at once.
const WHOLE_MERGE_LIMIT: usize = 1 << 22;
/// A local table switches to radix mode beyond this many groups ...
const RADIX_MIN_GROUPS: usize = 1 << 15;
/// ... when it holds fewer than this many input rows per group.
const RADIX_MAX_ROWS_PER_GROUP: usize = 16;
/// A table of at least this many rows per group is handed over instead (see
/// [`AggregateSink::flush_table`]).
const FLUSH_MIN_ROWS_PER_GROUP: usize = 4;
/// Radix mode scatters at least this many rows per partition at once.
const SLICE_ROWS: usize = 128;

/// Share of the memory limit (or of the machine's memory) that rows waiting
/// in the radix partitions may hold before a partition folds its rows.
const WAITING_SHARE: usize = 4;

/// Bytes of waiting rows one partition holds before folding them.
fn fold_bytes(parts: usize) -> usize {
    let pool = memory::pool();
    let budget = if pool.limited() { pool.limit() } else { memory::total_memory().unwrap_or(16 << 30) };
    (budget / WAITING_SHARE / parts).max(1 << 20)
}

/// Groups a partition is sized for: its table stays in a core's cache
/// (more, smaller partitions cost more slices and folds per row).
const GROUPS_PER_PARTITION: f64 = 65536.0;

/// Partitions for about `groups` groups in all: as many as keep each table in cache,
/// and at least a couple per thread (up to 64), so that every thread has one to work
/// on. Not more for few groups: a partition makes a table of its own and gets its rows
/// in slices, and 64 partitions of a hundred thousand groups spend more on tables and
/// slices of a hundred rows than on the groups.
fn num_partitions(groups: f64) -> usize {
    if let Some(p) = std::env::var("IARA_AGG_PARTITIONS").ok().and_then(|v| v.parse::<usize>().ok()) {
        return p.next_power_of_two();
    }
    let per_thread = (rayon::current_num_threads() * 2).next_power_of_two().clamp(2, 64);
    ((groups / GROUPS_PER_PARTITION).ceil().min(1e6) as usize).next_power_of_two().clamp(per_thread, 1024)
}

#[inline(always)]
fn partition_of(h: u64, shift: u32) -> usize {
    // high bits (after a rotation): the partition tables index with the low ones
    (h.rotate_left(17) >> shift) as usize
}

fn chunk_rows(chunk: &[ArrayRef]) -> usize {
    chunk.first().map_or(0, |a| a.len())
}

impl AggregateSink {
    /// `est_rows`: the planner's estimate of the input rows (sizes the radix
    /// partitions with the share of new groups the first rows show).
    pub fn new(group_exprs: Vec<PhysExpr>, aggs: Vec<AggregateExpr>, schema: SchemaRef, est_rows: Option<f64>) -> Self {
        let group_types: Vec<DataType> = group_exprs.iter().map(|e| e.data_type()).collect();
        let per_group = group_bytes(&group_types, &aggs);
        Self {
            group_exprs,
            group_types,
            aggs,
            schema,
            per_group,
            est_rows,
            morsels: None,
            radix: OnceLock::new(),
            spilling: AtomicBool::new(false),
            workers: AtomicUsize::new(0),
            part_cols: OnceLock::new(),
            flushed: Mutex::new(vec![]),
            fetch: None,
            confined: false,
        }
    }

    /// The radix partitions (made by the first switch to radix mode).
    fn radix(&self) -> &Radix {
        self.radix.get().expect("radix partitions are made before rows go to them")
    }

    fn new_local(&self) -> Result<AggLocal> {
        let worker = self.workers.fetch_add(1, Ordering::Relaxed);
        Ok(AggLocal {
            keys: if self.group_exprs.is_empty() { None } else { Some(GroupKeys::try_new(&self.group_types)?) },
            accs: self.new_accs()?,
            gids: vec![],
            rows: 0,
            table_rows: 0,
            radix: false,
            buffered: vec![],
            hashes: vec![],
            pending: vec![],
            pending_rows: 0,
            reservation: memory::pool().reservation(),
            table_bytes: 0,
            buffered_bytes: 0,
            seq: (usize::MAX, 0),
            morsels_seen: 0,
            finished_rows: 0,
            worker,
            done: vec![],
        })
    }

    fn new_table(&self) -> Result<PartTable> {
        Ok(PartTable {
            keys: GroupKeys::try_new(&self.group_types)?,
            accs: self.new_accs()?,
            gids: vec![],
            reservation: memory::pool().reservation(),
            bytes: 0,
        })
    }

    /// Fold evaluated rows into a partition table and account its growth;
    /// a table that cannot grow under the limit turns spilling on.
    fn fold(&self, t: &mut PartTable, chunk: &[ArrayRef]) -> Result<()> {
        let (kcols, inputs) = self.split_chunk(chunk);
        match chunk.get(self.chunk_width()) {
            Some(h) => t.keys.intern_hashed(&kcols, h.as_primitive::<arrow::datatypes::UInt64Type>().values(), &mut t.gids)?,
            None => t.keys.intern(&kcols, &mut t.gids)?,
        }
        let ng = t.keys.len();
        t.accs.update(&inputs, &t.gids, ng)?;
        let want = ng * self.per_group + t.accs.state_bytes();
        if want > t.bytes {
            let delta = want - t.bytes;
            t.bytes = want;
            if !t.reservation.try_grow(delta) {
                t.reservation.grow(delta); // it is in memory either way
                self.spilling.store(true, Ordering::Relaxed);
            }
        }
        Ok(())
    }

    /// Add a slice to its partition; once the partition's waiting rows fill
    /// its share of memory (or the pool is full) they are folded together.
    fn offer(&self, p: usize, chunk: Chunk) -> Result<()> {
        let bytes = arrays_bytes(&chunk);
        let radix = self.radix();
        let (chunks, _reservation) = {
            let mut w = radix.parts[p].waiting.lock();
            let fits = w.reservation.try_grow(bytes);
            w.chunks.push(chunk);
            if fits && w.reservation.size() < radix.fold_bytes {
                return Ok(());
            }
            (std::mem::take(&mut w.chunks), std::mem::replace(&mut w.reservation, memory::pool().reservation()))
        };
        let mut table = radix.parts[p].table.lock();
        if table.is_none() {
            *table = Some(self.new_table()?);
        }
        let t = table.as_mut().expect("table");
        for chunk in &chunks {
            self.fold(t, chunk)?;
        }
        Ok(())
    }

    /// Thread-local tables may be handed over: their states merge per
    /// partition (a DISTINCT state would index its pairs by group for that,
    /// once per handed-over table).
    fn can_flush(&self) -> bool {
        !self.aggs.iter().any(|a| a.distinct)
    }

    /// Hand the worker's full table over (merged in the finalize, like the
    /// tables left at the end) and start a new one.
    fn flush_table(&self, local: &mut AggLocal) -> Result<()> {
        let mut full = self.new_local()?;
        std::mem::swap(&mut full.keys, &mut local.keys);
        std::mem::swap(&mut full.accs, &mut local.accs);
        std::mem::swap(&mut full.reservation, &mut local.reservation);
        full.table_bytes = local.table_bytes;
        local.table_bytes = 0;
        local.table_rows = 0;
        self.flushed.lock().push(full);
        Ok(())
    }

    /// Confined keys: the worker's table holds whole groups, emitted as
    /// output; the next morsel starts an empty table of about its size.
    fn emit_table(&self, local: &mut AggLocal) -> Result<()> {
        let n = local.num_groups();
        if local.keys.is_none() || n == 0 {
            return Ok(());
        }
        let mut keys = GroupKeys::try_new(&self.group_types)?;
        keys.reserve(n);
        let keys = local.keys.replace(keys).expect("keys").emit()?;
        let mut accs = std::mem::replace(&mut local.accs, self.new_accs()?);
        local.done.push(self.output(keys, &mut accs, n)?);
        local.reservation.shrink(local.table_bytes);
        local.table_bytes = 0;
        local.table_rows = 0;
        Ok(())
    }

    /// Account the pre-aggregation table's growth; false: no room, switch to radix mode.
    fn account_table(&self, local: &mut AggLocal) -> bool {
        let want = local.num_groups() * self.per_group + local.accs.state_bytes();
        if want <= local.table_bytes {
            return true;
        }
        let delta = want - local.table_bytes;
        local.table_bytes = want;
        if local.reservation.try_grow(delta) {
            return true;
        }
        local.reservation.grow(delta); // it is in memory either way
        false
    }

    /// Move a worker's in-memory partition buffers to the spill files.
    fn spill_buffered(&self, local: &mut AggLocal) -> Result<()> {
        for (p, chunks) in local.buffered.iter_mut().enumerate() {
            for chunk in chunks.drain(..) {
                self.radix().spill.write(p, &chunk)?;
            }
        }
        local.reservation.shrink(local.buffered_bytes);
        local.buffered_bytes = 0;
        Ok(())
    }

    fn new_accs(&self) -> Result<AccSet> {
        let same_input = |a: &AggregateExpr, b: &AggregateExpr| -> bool {
            !a.distinct
                && !b.distinct
                && !a.collects()
                && !b.collects()
                && a.input_type == b.input_type
                && a.args.len() == b.args.len()
                && a.args.iter().zip(&b.args).all(|(x, y)| x.same(y))
                && match (&a.filter, &b.filter) {
                    (None, None) => true,
                    (Some(x), Some(y)) => x.same(y),
                    _ => false,
                }
        };
        let can_pair_sum_mean = |a: &AggregateExpr, b: &AggregateExpr| -> bool {
            matches!((a.func, b.func), (AggFunc::Sum, AggFunc::Mean) | (AggFunc::Mean, AggFunc::Sum))
                && matches!(a.input_type, Some(DataType::Decimal128(_, _) | DataType::Float64))
                && same_input(a, b)
        };
        let mut parts = Vec::with_capacity(self.aggs.len());
        for (i, a) in self.aggs.iter().enumerate() {
            if let Some(owner) = (0..i).find(|&j| {
                (a.func == self.aggs[j].func && same_input(a, &self.aggs[j]))
                    || can_pair_sum_mean(a, &self.aggs[j])
            }) {
                if let Some(finisher) = create_row_accumulator(a.func, a.input_type.as_ref(), false) {
                    parts.push(AccPart::FollowerRow { finisher, owner });
                    continue;
                }
            }
            if a.func == AggFunc::Sum
                && (i + 1..self.aggs.len()).any(|j| can_pair_sum_mean(a, &self.aggs[j]))
            {
                if let Some(finisher) = create_row_accumulator(a.func, a.input_type.as_ref(), false) {
                    let updater: Box<dyn RowAcc> = match a.input_type {
                        Some(DataType::Decimal128(_, scale)) => Box::new(DecimalMeanRow::new(scale)),
                        Some(DataType::Float64) => Box::new(MeanRow::<Float64Type>::new()),
                        _ => unreachable!(),
                    };
                    parts.push(AccPart::PairedRow { updater, finisher });
                    continue;
                }
            }
            parts.push(a.acc_part()?);
        }
        Ok(AccSet::new(parts))
    }

    fn output(&self, keys: Vec<ArrayRef>, accs: &mut AccSet, n: usize) -> Result<RecordBatch> {
        let mut cols = keys;
        cols.extend(accs.finish(n)?);
        make_batch(&self.schema, cols, n)
    }

    /// Evaluate group keys and aggregate inputs: `(keys, [(args, filter)])`.
    #[allow(clippy::type_complexity)]
    fn evaluate(&self, batch: &RecordBatch, seq: u64) -> Result<(Vec<ArrayRef>, Vec<AccInput>)> {
        let mut cache = Vec::new();
        let keys = self
            .group_exprs
            .iter()
            .map(|e| e.evaluate_array_cached(batch, &mut cache))
            .collect::<Result<Vec<_>>>()?;
        let mut inputs = Vec::with_capacity(self.aggs.len());
        for a in &self.aggs {
            let mut args = a
                .args
                .iter()
                .map(|x| x.evaluate_array_cached(batch, &mut cache))
                .collect::<Result<Vec<_>>>()?;
            if a.collects() {
                let n = batch.num_rows() as u64;
                args.push(Arc::new(UInt64Array::from_iter_values(seq..seq + n)));
            }
            let f = match &a.filter {
                Some(f) => Some(f.evaluate_array_cached(batch, &mut cache)?),
                None => None,
            };
            inputs.push((args, f));
        }
        Ok((keys, inputs))
    }

    /// The hashes rows are partitioned by (`cols` starts with the keys).
    fn partition_hashes(&self, cols: &[ArrayRef], out: &mut Vec<u64>) -> Result<()> {
        match self.part_cols.get() {
            Some(pc) => hash_columns(&pc.iter().map(|&j| cols[j].clone()).collect::<Vec<_>>(), out),
            None => hash_columns(&cols[..self.group_exprs.len()], out),
        }
    }

    /// Columns of a chunk before its partition hashes.
    fn chunk_width(&self) -> usize {
        self.group_exprs.len() + self.aggs.iter().map(|a| a.input_arity() + a.filter.is_some() as usize).sum::<usize>()
    }

    fn split_chunk(&self, chunk: &[ArrayRef]) -> (Vec<ArrayRef>, Vec<AccInput>) {
        let k = self.group_exprs.len();
        let keys = chunk[..k].to_vec();
        let mut pos = k;
        let mut inputs = Vec::with_capacity(self.aggs.len());
        for a in &self.aggs {
            let args = chunk[pos..pos + a.input_arity()].to_vec();
            pos += a.input_arity();
            let f = if a.filter.is_some() {
                pos += 1;
                Some(chunk[pos - 1].clone())
            } else {
                None
            };
            inputs.push((args, f));
        }
        (keys, inputs)
    }

    /// Radix mode: buffer evaluated rows until every partition gets a slice
    /// worth handing over; selective joins upstream emit tiny batches.
    fn buffer_scatter(&self, local: &mut AggLocal, keys: Vec<ArrayRef>, inputs: Vec<AccInput>) -> Result<()> {
        let n = keys.first().map(|k| k.len()).unwrap_or(0);
        let mut cols: Vec<ArrayRef> = keys;
        for (args, f) in inputs {
            cols.extend(args);
            if let Some(f) = f {
                cols.push(f);
            }
        }
        let min_rows = (self.radix().parts.len() * SLICE_ROWS).max(crate::io::parquet::batch_size());
        if n >= min_rows && local.pending.is_empty() {
            return self.scatter(local, cols);
        }
        local.pending.push(cols);
        local.pending_rows += n;
        if local.pending_rows >= min_rows {
            self.flush_pending(local)?;
        }
        Ok(())
    }

    fn flush_pending(&self, local: &mut AggLocal) -> Result<()> {
        if local.pending.is_empty() {
            return Ok(());
        }
        let pending = std::mem::take(&mut local.pending);
        local.pending_rows = 0;
        let cols = if pending.len() == 1 {
            pending.into_iter().next().unwrap()
        } else {
            (0..pending[0].len())
                .map(|c| {
                    let arrays: Vec<&dyn Array> = pending.iter().map(|p| p[c].as_ref()).collect();
                    arrow::compute::concat(&arrays)
                })
                .collect::<Result<Vec<_>, _>>()?
        };
        self.scatter(local, cols)
    }

    /// Radix mode: scatter evaluated rows (`[keys..., inputs...]`) into hash
    /// partitions and hand every slice to its partition.
    fn scatter(&self, local: &mut AggLocal, cols: Vec<ArrayRef>) -> Result<()> {
        let p = self.radix().parts.len();
        let start = local.worker * p / rayon::current_num_threads().max(1) % p;
        let shift = 64 - p.trailing_zeros();
        self.partition_hashes(&cols, &mut local.hashes)?;
        let n = local.hashes.len();
        let mut counts = vec![0usize; p + 1];
        for &h in &local.hashes {
            counts[partition_of(h, shift) + 1] += 1;
        }
        for i in 1..=p {
            counts[i] += counts[i - 1];
        }
        let offsets = counts.clone();
        let mut pos = counts;
        let mut perm = vec![0u32; n];
        for (i, &h) in local.hashes.iter().enumerate() {
            let part = partition_of(h, shift);
            perm[pos[part]] = i as u32;
            pos[part] += 1;
        }
        let perm = UInt32Array::from(perm);
        let slice = |sorted: &[ArrayRef], part: usize| -> Chunk {
            let (start, end) = (offsets[part], offsets[part + 1]);
            sorted.iter().map(|c| c.slice(start, end - start)).collect()
        };
        if !self.spilling.load(Ordering::Relaxed) {
            let mut sorted = cols.iter().map(|c| take(c, &perm, None)).collect::<Result<Vec<_>, _>>()?;
            // the whole key hashed: a key column's interner, or keys kept as rows, hash it the
            // same way, and need not again
            if self.part_cols.get().is_none_or(|pc| pc.len() == self.group_exprs.len()) {
                let hashes: Vec<u64> = perm.values().iter().map(|&i| local.hashes[i as usize]).collect();
                sorted.push(Arc::new(UInt64Array::from(hashes)));
            }
            for i in 0..p {
                let part = (start + i) % p;
                if offsets[part] < offsets[part + 1] {
                    self.offer(part, slice(&sorted, part))?;
                }
            }
            return Ok(());
        }
        // buffered chunks must not pin the decoded buffers their views point into
        let sorted = cols
            .iter()
            .map(|c| {
                take(c, &perm, None).map(|t| match t.data_type() {
                    DataType::Utf8View => Arc::new(t.as_string_view().gc()) as ArrayRef,
                    DataType::BinaryView => Arc::new(t.as_binary_view().gc()) as ArrayRef,
                    _ => t,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if local.buffered.is_empty() {
            local.buffered = vec![vec![]; p];
        }
        for part in 0..p {
            if offsets[part] < offsets[part + 1] {
                local.buffered[part].push(slice(&sorted, part));
            }
        }
        let bytes = arrays_bytes(&sorted);
        if local.reservation.try_grow(bytes) {
            local.buffered_bytes += bytes;
            return Ok(());
        }
        self.spill_buffered(local)
    }
    /// Whether a preceding `Filter` operator can pass its boolean mask on
    /// high-selectivity batches without physically compacting the batch.
    pub fn can_defer_filter(&self) -> bool {
        !self.group_exprs.is_empty()
            && self.group_exprs.iter().all(|e| !e.is_fallible())
            && self.aggs.iter().all(|a| {
                !a.collects()
                    && !a.distinct
                    && create_row_accumulator(a.func, a.input_type.as_ref(), false).is_some()
                    && a.args.iter().all(|x| !x.is_fallible())
                    && a.filter.as_ref().is_none_or(|f| !f.is_fallible())
            })
    }
}

impl Sink for AggregateSink {
    type Local = Result<AggLocal>;
    type Output = Vec<RecordBatch>;

    fn make_local(&self) -> Result<AggLocal> {
        self.new_local()
    }

    fn push(&self, local: &mut Result<AggLocal>, morsel: usize, batch: RecordBatch) -> Result<()> {
        let deferred = crate::exec::ops::take_deferred_mask();
        let local = match local {
            Ok(l) => l,
            Err(e) => return Err(WhError::Execution(e.to_string())),
        };
        let (batch, mask, selected) = match deferred {
            Some((m, _)) if local.radix || local.keys.as_ref().is_some_and(|k| k.lead().is_some()) => {
                let b = arrow::compute::filter_record_batch(&batch, &m)?;
                let n = b.num_rows();
                (b, None, n)
            }
            Some((m, sel)) => (batch, Some(m), sel),
            None => {
                let n = batch.num_rows();
                (batch, None, n)
            }
        };
        let n = batch.num_rows();
        if n == 0 || selected == 0 {
            return Ok(());
        }
        if local.seq.0 != morsel {
            local.finished_rows = local.rows;
        }
        local.rows += selected;
        local.table_rows += selected;
        let (keys, inputs) = self.evaluate(&batch, local.next_seq(morsel, n))?;
        if local.keys.is_none() {
            // global aggregation
            return local.accs.update_single(&inputs, n);
        }
        if local.radix {
            return self.buffer_scatter(local, keys, inputs);
        }
        let table = local.keys.as_mut().unwrap();
        match &mask {
            Some(m) => table.intern_masked(&keys, m.values(), &mut local.gids)?,
            None => table.intern(&keys, &mut local.gids)?,
        }
        let ng = table.len();
        local.accs.update(&inputs, &local.gids, ng)?;
        let fits = self.account_table(local);
        if self.confined {
            // the table never outgrows a morsel's groups
            return Ok(());
        }
        let large = ng > RADIX_MIN_GROUPS && ng * RADIX_MAX_ROWS_PER_GROUP > local.table_rows;
        if fits && large && ng * FLUSH_MIN_ROWS_PER_GROUP <= local.table_rows && self.can_flush() {
            return self.flush_table(local);
        }
        if !fits || large {
            // keys with a column of about as many values as there are groups
            // (an id with its attributes, a user next to a search phrase) are
            // partitioned by that column alone: any subset of the key keeps
            // equal keys together, and the other columns are not hashed
            let keys = local.keys.as_ref();
            self.part_cols.get_or_init(|| keys.and_then(|k| k.partition_column()).map_or_else(|| (0..self.group_exprs.len()).collect(), |l| vec![l]));
            // the groups to expect: this worker's share of new groups over
            // all the input rows (its rows per finished morsel times the
            // morsels; the planner's estimate before a morsel is finished)
            let rows = local.table_rows.max(1) as f64;
            let finished = local.morsels_seen.saturating_sub(1);
            let input = match self.morsels {
                Some(m) if finished > 0 => Some(local.finished_rows as f64 / finished as f64 * m as f64),
                _ => self.est_rows,
            };
            let unknown = (rayon::current_num_threads() * 16) as f64 * GROUPS_PER_PARTITION;
            let groups = input.map_or(unknown, |n| (ng as f64 / rows * n.max(rows)).max(ng as f64));
            self.radix.get_or_init(|| {
                let r = Radix::new(groups);
                if crate::exec::pipeline::profiling() {
                    eprintln!(
                        "[iara]   aggregate: radix mode after {ng} groups in {} rows (input {:?} rows, planned {:?}): {} partitions",
                        local.table_rows,
                        input.map(|e| e as u64),
                        self.est_rows.map(|e| e as u64),
                        r.parts.len()
                    );
                }
                r
            });
            local.radix = true;
        }
        Ok(())
    }

    fn morsel_done(&self, local: &mut Result<AggLocal>, _morsel: usize) -> Result<()> {
        match local {
            Ok(l) if self.confined => self.emit_table(l),
            _ => Ok(()),
        }
    }

    fn finalize(&self, mut locals: Vec<Result<AggLocal>>) -> Result<Vec<RecordBatch>> {
        let t0 = std::time::Instant::now();
        if self.confined {
            let mut batches = vec![];
            for l in locals {
                let mut l = l?;
                self.emit_table(&mut l)?;
                batches.append(&mut l.done);
            }
            if crate::exec::pipeline::profiling() {
                let groups: usize = batches.iter().map(|b| b.num_rows()).sum();
                eprintln!("[iara]   aggregate: keys confined to morsels, {groups} groups emitted morsel by morsel");
            }
            return crate::exec::pipeline::coalesce_small(&self.schema, batches, crate::io::parquet::batch_size());
        }
        let flushed = std::mem::take(&mut *self.flushed.lock());
        if crate::exec::pipeline::profiling() && !flushed.is_empty() {
            let groups: usize = flushed.iter().map(|l| l.num_groups()).sum();
            eprintln!("[iara]   aggregate: {} full local tables handed over ({groups} groups)", flushed.len());
        }
        locals.extend(flushed.into_iter().map(Ok));
        let out = self.finalize_inner(locals);
        if crate::exec::pipeline::profiling() {
            eprintln!("[iara]   aggregate finalize: {:.2}ms", t0.elapsed().as_secs_f64() * 1000.0);
        }
        out
    }
}

impl AggregateSink {
    fn finalize_inner(&self, locals: Vec<Result<AggLocal>>) -> Result<Vec<RecordBatch>> {
        let mut locals = locals.into_iter().collect::<Result<Vec<_>>>()?;
        locals.par_iter_mut().try_for_each(|l| self.flush_pending(l))?;
        let spilled = match self.radix.get() {
            Some(r) => r.spill.finish()?,
            None => vec![],
        };
        if crate::exec::pipeline::profiling() && spilled.iter().any(|f| f.is_some()) {
            let bytes: u64 = spilled.iter().flatten().map(|f| f.bytes()).sum();
            eprintln!("[iara]   aggregate spilled {:.1} MB to {} partition files", bytes as f64 / 1e6, spilled.iter().flatten().count());
        }
        if locals.is_empty() {
            locals.push(self.new_local()?);
        }
        // the partitions' tables and waiting rows (none before radix mode)
        let take_parts = |r: &Radix| -> Vec<(Option<PartTable>, Waiting)> {
            r.parts.iter().map(|p| (p.table.lock().take(), std::mem::replace(&mut *p.waiting.lock(), Waiting::new()))).collect()
        };
        let mut parts = self.radix.get().map(take_parts).unwrap_or_default();
        if crate::exec::pipeline::profiling() {
            let groups: Vec<usize> = locals.iter().map(|l| l.num_groups()).collect();
            let radix = locals.iter().filter(|l| l.radix).count();
            let rows: usize = locals.iter().map(|l| l.rows).sum();
            let shared: usize = parts.iter().filter_map(|p| p.0.as_ref()).map(|t| t.keys.len()).sum();
            eprintln!(
                "[iara]   aggregate: {rows} rows; local groups {groups:?}; {radix} workers in radix mode; \
                 {shared} groups in {} partition tables",
                parts.len()
            );
        }
        // ---------------- global aggregation ----------------
        if self.group_exprs.is_empty() {
            let mut first = locals.remove(0);
            for other in &locals {
                first.accs.merge(&other.accs, &[0], &[0], 1)?;
            }
            return Ok(vec![self.output(vec![], &mut first.accs, 1)?]);
        }
        let any_radix = locals.iter().any(|l| l.radix) || spilled.iter().any(|f| f.is_some());
        locals.retain(|l| l.num_groups() > 0 || !l.buffered.is_empty());
        if locals.is_empty() && !any_radix {
            let keys = self.group_types.iter().map(new_empty_array).collect::<Vec<_>>();
            let mut accs = self.new_accs()?;
            return Ok(vec![self.output(keys, &mut accs, 0)?]);
        }
        let total: usize = locals.iter().map(|l| l.num_groups()).sum();
        // DISTINCT accumulators merge a whole table's pairs in parallel: while
        // the groups are few, thread-local tables are merged whole, one after
        // the other, not partition by partition
        let whole_merges = self.aggs.iter().any(|a| a.distinct) && total <= WHOLE_MERGE_LIMIT;
        if !any_radix && (locals.len() == 1 || total <= SEQUENTIAL_MERGE_LIMIT || whole_merges) {
            let mut first = locals.remove(0);
            for other in &locals {
                let mut gids = vec![];
                first.keys.as_mut().unwrap().intern_from(other.keys.as_ref().unwrap(), None, &mut gids)?;
                let ng = first.num_groups();
                let src: Vec<u32> = (0..other.num_groups() as u32).collect();
                first.accs.merge(&other.accs, &src, &gids, ng)?;
            }
            let n = first.num_groups();
            let keys = first.keys.as_ref().unwrap().emit()?;
            return Ok(vec![self.output(keys, &mut first.accs, n)?]);
        }
        // ---------------- partitioned parallel finalize ----------------
        if parts.is_empty() {
            parts = take_parts(self.radix.get_or_init(|| Radix::new(total as f64)));
        }
        let nparts = parts.len();
        let shift = 64 - nparts.trailing_zeros();
        // tables that keep each group's hash (see `GroupKeys::hashes`) are partitioned by it, when
        // rows are partitioned by the whole key: their groups' rows are then copied
        let k = self.group_exprs.len();
        let by_stored = self.part_cols.get().is_none_or(|pc| pc.len() == k);
        // pre-aggregated tables: the order of their groups by partition, and where each
        // partition's start. Other tables emit their keys once, in that order (one `take` per
        // column: a partition's keys are then a slice)
        let prepared: Vec<Option<(Option<Vec<ArrayRef>>, Vec<u32>, Vec<usize>)>> = locals
            .par_iter()
            .map(|l| -> Result<_> {
                if l.num_groups() == 0 {
                    return Ok(None);
                }
                let table = l.keys.as_ref().unwrap();
                let (keys, hashes) = match table.hashes().filter(|_| by_stored) {
                    Some(stored) => (None, std::borrow::Cow::Borrowed(stored)),
                    None => {
                        let keys = table.emit()?;
                        let mut hashes = vec![];
                        self.partition_hashes(&keys, &mut hashes)?;
                        (Some(keys), std::borrow::Cow::Owned(hashes))
                    }
                };
                // a counting sort of the groups by partition
                let mut starts = vec![0usize; nparts + 1];
                for &h in hashes.iter() {
                    starts[partition_of(h, shift) + 1] += 1;
                }
                for p in 0..nparts {
                    starts[p + 1] += starts[p];
                }
                let mut at = starts.clone();
                let mut order = vec![0u32; hashes.len()];
                for (g, &h) in hashes.iter().enumerate() {
                    let p = partition_of(h, shift);
                    order[at[p]] = g as u32;
                    at[p] += 1;
                }
                let keys = match keys {
                    Some(keys) => {
                        let sel = UInt32Array::from(order.clone());
                        Some(keys.iter().map(|k| take(k, &sel, None)).collect::<Result<Vec<_>, _>>()?)
                    }
                    None => None,
                };
                Ok(Some((keys, order, starts)))
            })
            .collect::<Result<_>>()?;
        let finish = |p: usize, table: &mut Option<PartTable>, waiting: &mut Waiting| -> Result<Option<RecordBatch>> {
                let buffered = locals.iter().filter(|l| !l.buffered.is_empty()).map(|l| &l.buffered[p]);
                let mut t = match table.take() {
                    Some(t) => t,
                    None => {
                        // a few rows per group is typical when rows are aggregated here
                        let mut t = self.new_table()?;
                        let rows = |cs: &[Chunk]| cs.iter().map(|c| chunk_rows(c)).sum::<usize>();
                        let raw_rows = rows(&waiting.chunks)
                            + buffered.clone().map(|b| rows(b)).sum::<usize>()
                            + spilled.get(p).and_then(|f| f.as_ref()).map_or(0, |f| f.rows());
                        t.keys.reserve((raw_rows / 4).min(1 << 20));
                        t
                    }
                };
                // rows still waiting, buffered for the spill files, and spilled
                for chunk in waiting.chunks.drain(..) {
                    self.fold(&mut t, &chunk)?;
                }
                waiting.reservation.free();
                for chunk in buffered.flatten() {
                    self.fold(&mut t, chunk)?;
                }
                if let Some(file) = spilled.get(p).and_then(|f| f.as_ref()) {
                    for batch in file.read()? {
                        self.fold(&mut t, batch?.columns())?;
                    }
                }
                // partial states of pre-aggregated tables
                for (li, l) in locals.iter().enumerate() {
                    let Some((lkeys, order, starts)) = &prepared[li] else { continue };
                    let (from, to) = (starts[p], starts[p + 1]);
                    let src = &order[from..to];
                    if src.is_empty() {
                        continue;
                    }
                    match lkeys {
                        Some(lkeys) => {
                            let part_keys: Vec<ArrayRef> = lkeys.iter().map(|k| k.slice(from, to - from)).collect();
                            t.keys.intern(&part_keys, &mut t.gids)?;
                        }
                        None => t.keys.intern_from(l.keys.as_ref().unwrap(), Some(src), &mut t.gids)?,
                    }
                    let ng = t.keys.len();
                    t.accs.merge(&l.accs, src, &t.gids, ng)?;
                }
                let n = t.keys.len();
                if n == 0 {
                    return Ok(None);
                }
                let key_cols = t.keys.emit()?;
                Ok(Some(self.output(key_cols, &mut t.accs, n)?))
        };
        // under a LIMIT, a wave of partitions at a time until there are enough groups
        let wave = if self.fetch.is_some() { rayon::current_num_threads().max(1) } else { nparts };
        let mut batches: Vec<RecordBatch> = vec![];
        for (w, chunk) in parts.chunks_mut(wave).enumerate() {
            let done = chunk
                .par_iter_mut()
                .enumerate()
                .map(|(i, (table, waiting))| finish(w * wave + i, table, waiting))
                .collect::<Result<Vec<_>>>()?;
            batches.extend(done.into_iter().flatten());
            if self.fetch.is_some_and(|f| batches.iter().map(|b| b.num_rows()).sum::<usize>() >= f) {
                break;
            }
        }
        // small partition outputs joined into batches of about the scan batch size
        crate::exec::pipeline::coalesce_small(&self.schema, batches, crate::io::parquet::batch_size())
    }
}
