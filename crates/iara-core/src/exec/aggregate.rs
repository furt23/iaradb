//! Parallel, adaptive hash aggregation.
//!
//! Phase 1 (streaming, per worker thread): every worker starts by
//! pre-aggregating its morsels into a thread-local table (dense group ids +
//! accumulator states). That is ideal for low/medium cardinality.
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
use arrow::datatypes::{DataType, SchemaRef};
use arrow::record_batch::RecordBatch;
use parking_lot::Mutex;
use rayon::prelude::*;

use crate::error::{Result, WhError};
use crate::exec::acc_list::{ListAcc, ListSpec};
use crate::exec::acc_rows::{AccInput, AccPart, AccSet};
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
    /// radix mode: the hash partitions, shared by all workers
    parts: Vec<Part>,
    /// set once a partition table could not grow: radix rows go to `spill`
    spilling: AtomicBool,
    spill: AggSpill,
    /// workers created so far (spreads their first partition)
    workers: AtomicUsize,
    /// the key columns rows are partitioned by, fixed by the first worker to
    /// switch to radix mode
    part_cols: OnceLock<Vec<usize>>,
    /// bytes of waiting rows that make a partition fold them
    fold_bytes: usize,
}

/// Evaluated input columns of one partition chunk:
/// `[keys..., agg0 args..., agg0 filter?, agg1 args..., ...]`.
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
    /// the partition this worker visits first
    start: usize,
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
        }
        let at = ((morsel as u64) << 40) + self.seq.1;
        self.seq.1 += n as u64;
        at
    }
}

/// Up to this many groups in total, thread-local tables are merged sequentially.
const SEQUENTIAL_MERGE_LIMIT: usize = 1 << 15;
/// A local table switches to radix mode beyond this many groups ...
const RADIX_MIN_GROUPS: usize = 1 << 15;
/// ... when it holds fewer than this many input rows per group.
const RADIX_MAX_ROWS_PER_GROUP: usize = 16;
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

fn num_partitions() -> usize {
    if let Some(p) = std::env::var("IARA_AGG_PARTITIONS").ok().and_then(|v| v.parse::<usize>().ok()) {
        return p.next_power_of_two();
    }
    let p = (rayon::current_num_threads() * 4).next_power_of_two().clamp(8, 256);
    // under a memory limit partitions may be spilled and read back one by one: smaller ones
    if memory::pool().limited() { p.max(64) } else { p }
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
    pub fn new(group_exprs: Vec<PhysExpr>, aggs: Vec<AggregateExpr>, schema: SchemaRef) -> Self {
        let group_types: Vec<DataType> = group_exprs.iter().map(|e| e.data_type()).collect();
        let per_group = group_bytes(&group_types, &aggs);
        let parts = num_partitions();
        Self {
            group_exprs,
            group_types,
            aggs,
            schema,
            per_group,
            parts: (0..parts)
                .map(|_| Part { waiting: Mutex::new(Waiting::new()), table: Mutex::new(None) })
                .collect(),
            spilling: AtomicBool::new(false),
            spill: AggSpill::new(parts),
            workers: AtomicUsize::new(0),
            part_cols: OnceLock::new(),
            fold_bytes: fold_bytes(parts),
        }
    }

    fn new_local(&self) -> Result<AggLocal> {
        let parts = self.parts.len();
        let worker = self.workers.fetch_add(1, Ordering::Relaxed);
        Ok(AggLocal {
            keys: if self.group_exprs.is_empty() { None } else { Some(GroupKeys::try_new(&self.group_types)?) },
            accs: self.new_accs()?,
            gids: vec![],
            rows: 0,
            radix: false,
            buffered: vec![],
            hashes: vec![],
            pending: vec![],
            pending_rows: 0,
            reservation: memory::pool().reservation(),
            table_bytes: 0,
            buffered_bytes: 0,
            seq: (usize::MAX, 0),
            start: worker * parts / rayon::current_num_threads().max(1) % parts,
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
        t.keys.intern(&kcols, &mut t.gids)?;
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
        let (chunks, _reservation) = {
            let mut w = self.parts[p].waiting.lock();
            let fits = w.reservation.try_grow(bytes);
            w.chunks.push(chunk);
            if fits && w.reservation.size() < self.fold_bytes {
                return Ok(());
            }
            (std::mem::take(&mut w.chunks), std::mem::replace(&mut w.reservation, memory::pool().reservation()))
        };
        let mut table = self.parts[p].table.lock();
        if table.is_none() {
            *table = Some(self.new_table()?);
        }
        let t = table.as_mut().expect("table");
        for chunk in &chunks {
            self.fold(t, chunk)?;
        }
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
                self.spill.write(p, &chunk)?;
            }
        }
        local.reservation.shrink(local.buffered_bytes);
        local.buffered_bytes = 0;
        Ok(())
    }

    fn new_accs(&self) -> Result<AccSet> {
        Ok(AccSet::new(self.aggs.iter().map(|a| a.acc_part()).collect::<Result<_>>()?))
    }

    fn output(&self, keys: Vec<ArrayRef>, accs: &mut AccSet, n: usize) -> Result<RecordBatch> {
        let mut cols = keys;
        cols.extend(accs.finish(n)?);
        make_batch(&self.schema, cols, n)
    }

    /// Evaluate group keys and aggregate inputs: `(keys, [(args, filter)])`.
    #[allow(clippy::type_complexity)]
    fn evaluate(&self, batch: &RecordBatch, seq: u64) -> Result<(Vec<ArrayRef>, Vec<AccInput>)> {
        let keys = self.group_exprs.iter().map(|e| e.evaluate_array(batch)).collect::<Result<Vec<_>>>()?;
        let mut inputs = Vec::with_capacity(self.aggs.len());
        for a in &self.aggs {
            let mut args = a.args.iter().map(|x| x.evaluate_array(batch)).collect::<Result<Vec<_>>>()?;
            if a.collects() {
                let n = batch.num_rows() as u64;
                args.push(Arc::new(UInt64Array::from_iter_values(seq..seq + n)));
            }
            let f = match &a.filter {
                Some(f) => Some(f.evaluate_array(batch)?),
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
        let min_rows = (self.parts.len() * SLICE_ROWS).max(crate::io::parquet::batch_size());
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
        let p = self.parts.len();
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
            let sorted = cols.iter().map(|c| take(c, &perm, None)).collect::<Result<Vec<_>, _>>()?;
            for i in 0..p {
                let part = (local.start + i) % p;
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
}

impl Sink for AggregateSink {
    type Local = Result<AggLocal>;
    type Output = Vec<RecordBatch>;

    fn make_local(&self) -> Result<AggLocal> {
        self.new_local()
    }

    fn push(&self, local: &mut Result<AggLocal>, morsel: usize, batch: RecordBatch) -> Result<()> {
        let local = match local {
            Ok(l) => l,
            Err(e) => return Err(WhError::Execution(e.to_string())),
        };
        let n = batch.num_rows();
        if n == 0 {
            return Ok(());
        }
        local.rows += n;
        let (keys, inputs) = self.evaluate(&batch, local.next_seq(morsel, n))?;
        if local.keys.is_none() {
            // global aggregation
            return local.accs.update_single(&inputs, n);
        }
        if local.radix {
            return self.buffer_scatter(local, keys, inputs);
        }
        let table = local.keys.as_mut().unwrap();
        table.intern(&keys, &mut local.gids)?;
        let ng = table.len();
        local.accs.update(&inputs, &local.gids, ng)?;
        let fits = self.account_table(local);
        if !fits || (ng > RADIX_MIN_GROUPS && ng * RADIX_MAX_ROWS_PER_GROUP > local.rows) {
            // keys made of a column the others depend on (an id with its
            // attributes) are partitioned by that column alone: any subset of
            // the key keeps equal keys together, and this one has as many
            // values as there are groups
            let lead = local.keys.as_ref().and_then(|k| k.lead());
            self.part_cols.get_or_init(|| lead.map_or_else(|| (0..self.group_exprs.len()).collect(), |l| vec![l]));
            local.radix = true;
        }
        Ok(())
    }

    fn finalize(&self, locals: Vec<Result<AggLocal>>) -> Result<Vec<RecordBatch>> {
        let t0 = std::time::Instant::now();
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
        let spilled = self.spill.finish()?;
        if crate::exec::pipeline::profiling() && spilled.iter().any(|f| f.is_some()) {
            let bytes: u64 = spilled.iter().flatten().map(|f| f.bytes()).sum();
            eprintln!("[iara]   aggregate spilled {:.1} MB to {} partition files", bytes as f64 / 1e6, spilled.iter().flatten().count());
        }
        if locals.is_empty() {
            locals.push(self.new_local()?);
        }
        let mut parts: Vec<(Option<PartTable>, Waiting)> = self
            .parts
            .iter()
            .map(|p| (p.table.lock().take(), std::mem::replace(&mut *p.waiting.lock(), Waiting::new())))
            .collect();
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
        if !any_radix && (locals.len() == 1 || total <= SEQUENTIAL_MERGE_LIMIT) {
            let mut first = locals.remove(0);
            for other in &locals {
                let other_keys = other.keys.as_ref().unwrap().emit()?;
                let mut gids = vec![];
                first.keys.as_mut().unwrap().intern(&other_keys, &mut gids)?;
                let ng = first.num_groups();
                let src: Vec<u32> = (0..other.num_groups() as u32).collect();
                first.accs.merge(&other.accs, &src, &gids, ng)?;
            }
            let n = first.num_groups();
            let keys = first.keys.as_ref().unwrap().emit()?;
            return Ok(vec![self.output(keys, &mut first.accs, n)?]);
        }
        // ---------------- partitioned parallel finalize ----------------
        let nparts = parts.len();
        let shift = 64 - nparts.trailing_zeros();
        // pre-aggregated tables: emit keys once and bucket their groups by partition
        let prepared: Vec<Option<(Vec<ArrayRef>, Vec<Vec<u32>>)>> = locals
            .par_iter()
            .map(|l| -> Result<_> {
                if l.num_groups() == 0 {
                    return Ok(None);
                }
                let keys = l.keys.as_ref().unwrap().emit()?;
                let mut hashes = vec![];
                self.partition_hashes(&keys, &mut hashes)?;
                let mut idx: Vec<Vec<u32>> = vec![vec![]; nparts];
                for (g, &h) in hashes.iter().enumerate() {
                    idx[partition_of(h, shift)].push(g as u32);
                }
                Ok(Some((keys, idx)))
            })
            .collect::<Result<_>>()?;
        let batches: Vec<RecordBatch> = parts
            .par_iter_mut()
            .enumerate()
            .map(|(p, (table, waiting))| -> Result<Option<RecordBatch>> {
                let buffered = locals.iter().filter(|l| !l.buffered.is_empty()).map(|l| &l.buffered[p]);
                let mut t = match table.take() {
                    Some(t) => t,
                    None => {
                        // a few rows per group is typical when rows are aggregated here
                        let mut t = self.new_table()?;
                        let rows = |cs: &[Chunk]| cs.iter().map(|c| chunk_rows(c)).sum::<usize>();
                        let raw_rows = rows(&waiting.chunks)
                            + buffered.clone().map(|b| rows(b)).sum::<usize>()
                            + spilled[p].as_ref().map_or(0, |f| f.rows());
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
                if let Some(file) = &spilled[p] {
                    for batch in file.read()? {
                        self.fold(&mut t, batch?.columns())?;
                    }
                }
                // partial states of pre-aggregated tables
                for (li, l) in locals.iter().enumerate() {
                    let Some((lkeys, idx)) = &prepared[li] else { continue };
                    let src = &idx[p];
                    if src.is_empty() {
                        continue;
                    }
                    let sel = UInt32Array::from(src.clone());
                    let part_keys = lkeys.iter().map(|k| take(k, &sel, None)).collect::<Result<Vec<_>, _>>()?;
                    t.keys.intern(&part_keys, &mut t.gids)?;
                    let ng = t.keys.len();
                    t.accs.merge(&l.accs, src, &t.gids, ng)?;
                }
                let n = t.keys.len();
                if n == 0 {
                    return Ok(None);
                }
                let key_cols = t.keys.emit()?;
                Ok(Some(self.output(key_cols, &mut t.accs, n)?))
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect();
        coalesce(&self.schema, batches)
    }
}

/// Join runs of small partition outputs into batches of about the scan batch size.
fn coalesce(schema: &SchemaRef, batches: Vec<RecordBatch>) -> Result<Vec<RecordBatch>> {
    let target = crate::io::parquet::batch_size();
    let mut out = Vec::with_capacity(batches.len());
    let mut run: Vec<RecordBatch> = vec![];
    let mut rows = 0;
    for b in batches {
        if b.num_rows() >= target {
            out.push(b);
            continue;
        }
        rows += b.num_rows();
        run.push(b);
        if rows >= target {
            out.push(arrow::compute::concat_batches(schema, &std::mem::take(&mut run))?);
            rows = 0;
        }
    }
    match run.len() {
        0 => {}
        1 => out.extend(run),
        _ => out.push(arrow::compute::concat_batches(schema, &run)?),
    }
    Ok(out)
}
