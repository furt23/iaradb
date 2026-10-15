//! Parallel, adaptive hash aggregation.
//!
//! Phase 1 (streaming, per worker thread): every worker starts by
//! pre-aggregating its morsels into a thread-local table (dense group ids +
//! columnar accumulator state). That is ideal for low/medium cardinality.
//! If the local table grows large while reducing the input poorly (few rows
//! per group, typical for `GROUP BY <id>`), the worker switches to *radix
//! mode*: it stops pre-aggregating and instead scatters the evaluated input
//! rows into P hash partitions (one `take` per column + zero-copy slices).
//!
//! Phase 2 (finalize): small results are merged sequentially. Otherwise each
//! hash partition is aggregated by one task: it folds in the raw rows of
//! that partition from all workers, then merges the matching groups of the
//! pre-aggregated tables. Every partition table is small enough to stay in
//! cache and no locks are taken anywhere.
//!
//! Under a memory limit ([`crate::exec::memory`]) workers reserve what their
//! tables and partition buffers hold. A table that cannot grow switches its
//! worker to radix mode; partition buffers that cannot grow are spilled to
//! one file per partition ([`crate::exec::agg_spill`]), read back by the
//! finalize partition by partition.

use std::sync::Arc;

use arrow::array::*;
use arrow::compute::{SortOptions, filter, take};
use arrow::datatypes::{DataType, SchemaRef};
use arrow::record_batch::RecordBatch;
use rayon::prelude::*;

use crate::error::{Result, WhError};
use crate::exec::acc_list::{ListAcc, ListSpec};
use crate::exec::accumulators::{Accumulator, create_accumulator};
use crate::exec::agg_spill::{AggSpill, arrays_bytes, group_bytes};
use crate::exec::memory::{self, Reservation};
use crate::exec::groupby::GroupKeys;
use crate::exec::ops::make_batch;
use crate::exec::pipeline::Sink;
use crate::expr::AggFunc;
use crate::hash::hash_columns;
use crate::physical::expr::{PhysExpr, null_as_false};

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
    pub fn create_accumulator(&self) -> Result<Box<dyn Accumulator>> {
        if self.collects() {
            return Ok(Box::new(ListAcc::new(self.list_spec())));
        }
        create_accumulator(self.func, self.input_type.as_ref(), self.distinct, self.filter.is_some())
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
    spill: AggSpill,
}

/// Evaluated input columns of one partition chunk:
/// `[keys..., agg0 args..., agg0 filter?, agg1 args..., ...]`.
type Chunk = Vec<ArrayRef>;

pub struct AggLocal {
    keys: Option<GroupKeys>,
    accs: Vec<Box<dyn Accumulator>>,
    gids: Vec<u32>,
    rows: usize,
    /// radix mode: partition -> chunks of raw (evaluated) rows
    parts: Option<Vec<Vec<Chunk>>>,
    hashes: Vec<u64>,
    /// radix mode: small evaluated batches waiting to be scattered together
    pending: Vec<Chunk>,
    pending_rows: usize,
    /// memory held by the table and the in-memory partition buffers
    reservation: Reservation,
    table_bytes: usize,
    parts_bytes: usize,
    /// scan position of the next row: (morsel, rows of it seen so far)
    seq: (usize, u64),
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

impl AggregateSink {
    pub fn new(group_exprs: Vec<PhysExpr>, aggs: Vec<AggregateExpr>, schema: SchemaRef) -> Self {
        let group_types: Vec<DataType> = group_exprs.iter().map(|e| e.data_type()).collect();
        let per_group = group_bytes(&group_types, &aggs);
        Self { group_exprs, group_types, aggs, schema, per_group, spill: AggSpill::new(num_partitions()) }
    }

    fn new_local(&self) -> Result<AggLocal> {
        Ok(AggLocal {
            keys: if self.group_exprs.is_empty() { None } else { Some(GroupKeys::try_new(&self.group_types)?) },
            accs: self.aggs.iter().map(|a| a.create_accumulator()).collect::<Result<_>>()?,
            gids: vec![],
            rows: 0,
            parts: None,
            hashes: vec![],
            pending: vec![],
            pending_rows: 0,
            reservation: memory::pool().reservation(),
            table_bytes: 0,
            parts_bytes: 0,
            seq: (usize::MAX, 0),
        })
    }

    /// Account the pre-aggregation table's growth; false: no room, switch to radix mode.
    fn account_table(&self, local: &mut AggLocal) -> bool {
        let want = local.num_groups() * self.per_group + local.accs.iter().map(|a| a.state_bytes()).sum::<usize>();
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
    fn spill_parts(&self, local: &mut AggLocal) -> Result<()> {
        let parts = local.parts.as_mut().unwrap();
        for (p, chunks) in parts.iter_mut().enumerate() {
            for chunk in chunks.drain(..) {
                self.spill.write(p, &chunk)?;
            }
        }
        local.reservation.shrink(local.parts_bytes);
        local.parts_bytes = 0;
        Ok(())
    }

    fn new_accs(&self) -> Result<Vec<Box<dyn Accumulator>>> {
        self.aggs.iter().map(|a| a.create_accumulator()).collect()
    }

    fn output(&self, keys: Vec<ArrayRef>, accs: &mut [Box<dyn Accumulator>], n: usize) -> Result<RecordBatch> {
        let mut cols = keys;
        for acc in accs.iter_mut() {
            cols.push(acc.finish(n)?);
        }
        make_batch(&self.schema, cols, n)
    }

    /// Evaluate group keys and aggregate inputs: `(keys, [(args, filter)])`.
    #[allow(clippy::type_complexity)]
    fn evaluate(&self, batch: &RecordBatch, seq: u64) -> Result<(Vec<ArrayRef>, Vec<(Vec<ArrayRef>, Option<ArrayRef>)>)> {
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

    /// Fold evaluated rows (with group ids) into accumulators.
    fn update_accs(
        &self,
        accs: &mut [Box<dyn Accumulator>],
        inputs: &[(Vec<ArrayRef>, Option<ArrayRef>)],
        gids: &[u32],
        ng: usize,
    ) -> Result<()> {
        for (acc, (args, f)) in accs.iter_mut().zip(inputs) {
            match f {
                None => acc.update(args, gids, ng)?,
                Some(mask) => {
                    let mask = null_as_false(mask.as_boolean());
                    let vals = args.iter().map(|v| filter(v, &mask)).collect::<Result<Vec<_>, _>>()?;
                    let g: Vec<u32> =
                        gids.iter().zip(mask.values().iter()).filter_map(|(g, m)| m.then_some(*g)).collect();
                    acc.update(&vals, &g, ng)?;
                }
            }
        }
        Ok(())
    }

    fn split_chunk(&self, chunk: &[ArrayRef]) -> (Vec<ArrayRef>, Vec<(Vec<ArrayRef>, Option<ArrayRef>)>) {
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

    /// Radix mode: buffer evaluated rows; selective joins upstream emit tiny
    /// batches, and scattering each of them would create a flood of
    /// few-row partition chunks.
    fn buffer_scatter(&self, local: &mut AggLocal, keys: Vec<ArrayRef>, inputs: Vec<(Vec<ArrayRef>, Option<ArrayRef>)>) -> Result<()> {
        let n = keys.first().map(|k| k.len()).unwrap_or(0);
        let mut cols: Vec<ArrayRef> = keys;
        for (args, f) in inputs {
            cols.extend(args);
            if let Some(f) = f {
                cols.push(f);
            }
        }
        let min_rows = crate::io::parquet::batch_size();
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

    /// Radix mode: scatter evaluated rows (`[keys..., inputs...]`) into hash partitions.
    fn scatter(&self, local: &mut AggLocal, cols: Vec<ArrayRef>) -> Result<()> {
        let parts = local.parts.as_mut().unwrap();
        let p = parts.len();
        let shift = 64 - p.trailing_zeros();
        hash_columns(&cols[..self.group_exprs.len()], &mut local.hashes)?;
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
        // compact long strings in partition order while the batch is hot in
        // cache, so phase 2 reads each partition sequentially instead of
        // chasing views into the original decoded buffers
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
        for part in 0..p {
            let (start, end) = (offsets[part], offsets[part + 1]);
            if start < end {
                parts[part].push(sorted.iter().map(|c| c.slice(start, end - start)).collect());
            }
        }
        let bytes = arrays_bytes(&sorted);
        if local.reservation.try_grow(bytes) {
            local.parts_bytes += bytes;
            return Ok(());
        }
        self.spill_parts(local)
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
            for (acc, (args, f)) in local.accs.iter_mut().zip(&inputs) {
                match f {
                    None => acc.update_single(args, n)?,
                    Some(mask) => {
                        let mask = null_as_false(mask.as_boolean());
                        let vals = args.iter().map(|v| filter(v, &mask)).collect::<Result<Vec<_>, _>>()?;
                        acc.update_single(&vals, mask.true_count())?;
                    }
                }
            }
            return Ok(());
        }
        if local.parts.is_some() {
            return self.buffer_scatter(local, keys, inputs);
        }
        let table = local.keys.as_mut().unwrap();
        table.intern(&keys, &mut local.gids)?;
        let ng = table.len();
        self.update_accs(&mut local.accs, &inputs, &local.gids, ng)?;
        let fits = self.account_table(local);
        if !fits || (ng > RADIX_MIN_GROUPS && ng * RADIX_MAX_ROWS_PER_GROUP > local.rows) {
            local.parts = Some(vec![vec![]; num_partitions()]);
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
        if crate::exec::pipeline::profiling() {
            let groups: Vec<usize> = locals.iter().map(|l| l.num_groups()).collect();
            let radix = locals.iter().filter(|l| l.parts.is_some()).count();
            let rows: usize = locals.iter().map(|l| l.rows).sum();
            eprintln!("[iara]   aggregate: {rows} rows; local groups {groups:?}; {radix} workers in radix mode");
        }
        // ---------------- global aggregation ----------------
        if self.group_exprs.is_empty() {
            let mut first = locals.remove(0);
            for other in &locals {
                for (a, b) in first.accs.iter_mut().zip(other.accs.iter()) {
                    a.merge(b.as_ref(), &[0], &[0], 1)?;
                }
            }
            return Ok(vec![self.output(vec![], &mut first.accs, 1)?]);
        }
        let any_radix = locals.iter().any(|l| l.parts.is_some()) || spilled.iter().any(|f| f.is_some());
        locals.retain(|l| l.num_groups() > 0 || l.parts.is_some());
        if locals.is_empty() {
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
                for (a, b) in first.accs.iter_mut().zip(other.accs.iter()) {
                    a.merge(b.as_ref(), &src, &gids, ng)?;
                }
            }
            let n = first.num_groups();
            let keys = first.keys.as_ref().unwrap().emit()?;
            return Ok(vec![self.output(keys, &mut first.accs, n)?]);
        }
        // ---------------- partitioned parallel finalize ----------------
        let parts = num_partitions();
        let shift = 64 - parts.trailing_zeros();
        // pre-aggregated tables: emit keys once and bucket their groups by partition
        let prepared: Vec<Option<(Vec<ArrayRef>, Vec<Vec<u32>>)>> = locals
            .par_iter()
            .map(|l| -> Result<_> {
                if l.num_groups() == 0 {
                    return Ok(None);
                }
                let keys = l.keys.as_ref().unwrap().emit()?;
                let mut hashes = vec![];
                hash_columns(&keys, &mut hashes)?;
                let mut idx: Vec<Vec<u32>> = vec![vec![]; parts];
                for (g, &h) in hashes.iter().enumerate() {
                    idx[partition_of(h, shift)].push(g as u32);
                }
                Ok(Some((keys, idx)))
            })
            .collect::<Result<_>>()?;
        let batches: Vec<RecordBatch> = (0..parts)
            .into_par_iter()
            .map(|p| -> Result<Option<RecordBatch>> {
                let mut keys = GroupKeys::try_new(&self.group_types)?;
                let mut accs = self.new_accs()?;
                let mut gids = vec![];
                let raw_rows: usize = locals
                    .iter()
                    .filter_map(|l| l.parts.as_ref())
                    .map(|lp| lp[p].iter().map(|c| c.first().map(|a| a.len()).unwrap_or(0)).sum::<usize>())
                    .sum::<usize>()
                    + spilled[p].as_ref().map_or(0, |f| f.rows());
                keys.reserve((raw_rows / 2).min(1 << 20));
                // raw rows scattered by radix-mode workers
                let prof = crate::exec::pipeline::profiling();
                let (mut t_intern, mut t_update, mut nchunks) = (0u128, 0u128, 0usize);
                for l in &locals {
                    if let Some(lp) = &l.parts {
                        for chunk in &lp[p] {
                            let (kcols, inputs) = self.split_chunk(chunk);
                            let t0 = std::time::Instant::now();
                            keys.intern(&kcols, &mut gids)?;
                            let t1 = std::time::Instant::now();
                            let ng = keys.len();
                            self.update_accs(&mut accs, &inputs, &gids, ng)?;
                            if prof {
                                t_intern += (t1 - t0).as_micros();
                                t_update += t1.elapsed().as_micros();
                                nchunks += 1;
                            }
                        }
                    }
                }
                // rows of this partition that were spilled
                if let Some(file) = &spilled[p] {
                    for batch in file.read()? {
                        let chunk = batch?.columns().to_vec();
                        let (kcols, inputs) = self.split_chunk(&chunk);
                        keys.intern(&kcols, &mut gids)?;
                        let ng = keys.len();
                        self.update_accs(&mut accs, &inputs, &gids, ng)?;
                    }
                }
                if prof && p == 0 {
                    eprintln!("[iara]     partition 0: {nchunks} chunks, {raw_rows} rows, intern {t_intern}us, update {t_update}us");
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
                    keys.intern(&part_keys, &mut gids)?;
                    let ng = keys.len();
                    for (a, b) in accs.iter_mut().zip(l.accs.iter()) {
                        a.merge(b.as_ref(), src, &gids, ng)?;
                    }
                }
                let n = keys.len();
                if n == 0 {
                    return Ok(None);
                }
                let t2 = std::time::Instant::now();
                let key_cols = keys.emit()?;
                let out = self.output(key_cols, &mut accs, n)?;
                if crate::exec::pipeline::profiling() && p == 0 {
                    eprintln!("[iara]     partition 0: emit+output {}us for {n} groups", t2.elapsed().as_micros());
                }
                Ok(Some(out))
            })
            .collect::<Result<Vec<_>>>()?
            .into_iter()
            .flatten()
            .collect();
        Ok(batches)
    }
}
