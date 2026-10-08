//! Hash joins.
//!
//! Build: the build side is materialised, key columns are normalised (integer
//! keys - also multi-column ones - are packed into a single i64 when their
//! value ranges allow it, everything else uses the Arrow row format), hashed,
//! and inserted into a chained hash table *in parallel* using an atomic swap
//! on the bucket heads (no locks).
//! Probe: a streaming operator inside the probe-side pipeline; each morsel
//! batch is hashed and matched against the shared, read-only table.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use arrow::array::*;
use arrow::buffer::NullBuffer;
use arrow::compute::{cast, concat_batches, filter_record_batch, take};
use arrow::datatypes::{DataType, Schema, SchemaRef};
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use arrow::row::{RowConverter, Rows, SortField};
use rayon::prelude::*;

use crate::error::Result;
use crate::exec::join_spill::{PartitionedSpill, grace_partitions};
use crate::exec::memory::{self, Reservation};
use crate::exec::pipeline::{Emit, Operator, Sink};
use crate::exec::spill::SpillFile;
use crate::hash::{hash_bytes, hash_u64};
use crate::logical::JoinType;
use crate::physical::expr::PhysExpr;

const OUT_CHUNK: usize = 1 << 13;

fn int_like(dt: &DataType) -> bool {
    matches!(
        dt,
        DataType::Int8
            | DataType::Int16
            | DataType::Int32
            | DataType::Int64
            | DataType::UInt8
            | DataType::UInt16
            | DataType::UInt32
            | DataType::Date32
            | DataType::Date64
            | DataType::Timestamp(_, _)
    )
}

fn to_i64(a: &ArrayRef) -> Result<ArrayRef> {
    Ok(match a.data_type() {
        DataType::Int64 => a.clone(),
        DataType::Timestamp(_, _) | DataType::Date64 => {
            // reinterpret
            let data = a.to_data().into_builder().data_type(DataType::Int64).build()?;
            make_array(data)
        }
        _ => cast(a, &DataType::Int64)?,
    })
}

fn combined_nulls(cols: &[ArrayRef]) -> Option<NullBuffer> {
    let mut acc: Option<NullBuffer> = None;
    for c in cols {
        if let Some(n) = c.logical_nulls() {
            acc = NullBuffer::union(acc.as_ref(), Some(&n));
        }
    }
    acc.filter(|n| n.null_count() > 0)
}

#[derive(Debug, Clone)]
struct Packing {
    /// (min, max, shift) per key column
    cols: Vec<(i64, i64, u32)>,
}

enum BuildKeys {
    Int { values: Vec<i64>, packing: Option<Packing> },
    Rows { conv: RowConverter, rows: Rows, hashes: Vec<u64> },
}

pub struct JoinHashTable {
    pub batch: RecordBatch,
    keys: BuildKeys,
    heads: Vec<u32>,
    next: Vec<u32>,
    mask: usize,
    matched: Option<Vec<AtomicBool>>,
    /// memory accounted for the table (released with it)
    memory: Option<Reservation>,
}

struct SendPtr(*mut u32);
unsafe impl Send for SendPtr {}
unsafe impl Sync for SendPtr {}

/// Normalised probe/build keys: either packed i64s or row-format bytes.
enum KeyBatch {
    Int { values: Vec<i64>, valid: Vec<bool> },
    Rows { rows: Rows, hashes: Vec<u64>, valid: Option<NullBuffer> },
}

impl JoinHashTable {
    pub fn build(batch: RecordBatch, key_cols: Vec<ArrayRef>, track_matches: bool) -> Result<Self> {
        let n = batch.num_rows();
        let valid = combined_nulls(&key_cols);
        let all_int = key_cols.iter().all(|c| int_like(c.data_type()));
        let keys = if all_int {
            let ints = key_cols.iter().map(to_i64).collect::<Result<Vec<_>>>()?;
            if ints.len() == 1 {
                let v = ints[0].as_primitive::<arrow::datatypes::Int64Type>().values().to_vec();
                BuildKeys::Int { values: v, packing: None }
            } else {
                // try to pack all key columns into 64 bits
                let mut cols = vec![];
                let mut total_bits = 0u32;
                for c in &ints {
                    let p = c.as_primitive::<arrow::datatypes::Int64Type>();
                    let (mn, mx) = match (arrow::compute::min(p), arrow::compute::max(p)) {
                        (Some(a), Some(b)) => (a, b),
                        _ => (0, 0),
                    };
                    let range = (mx as i128 - mn as i128) as u128 + 1;
                    let bits = 128 - (range - 1).leading_zeros().min(128);
                    cols.push((mn, mx, bits.max(1)));
                    total_bits += bits.max(1);
                }
                if total_bits <= 63 {
                    let mut shift = 0u32;
                    let mut packing = Packing { cols: vec![] };
                    for (mn, mx, bits) in cols.iter().rev() {
                        packing.cols.push((*mn, *mx, shift));
                        shift += bits;
                    }
                    packing.cols.reverse();
                    let kb = pack(&ints, &packing, n);
                    let KeyBatch::Int { values, .. } = kb else { unreachable!() };
                    BuildKeys::Int { values, packing: Some(packing) }
                } else {
                    rows_keys(&key_cols)?
                }
            }
        } else {
            rows_keys(&key_cols)?
        };

        let buckets = (n * 2).next_power_of_two().max(16);
        let mask = buckets - 1;
        let heads: Vec<AtomicU32> = (0..buckets).map(|_| AtomicU32::new(0)).collect();
        let mut next = vec![0u32; n];
        {
            let next_ptr = SendPtr(next.as_mut_ptr());
            let valid_ref = valid.as_ref();
            let insert = |i: usize, h: u64| {
                if valid_ref.is_some_and(|v| v.is_null(i)) {
                    return;
                }
                let b = h as usize & mask;
                let old = heads[b].swap(i as u32 + 1, Ordering::Relaxed);
                let p = &next_ptr;
                // SAFETY: every row index is written by exactly one task
                unsafe { *p.0.add(i) = old };
            };
            match &keys {
                BuildKeys::Int { values, .. } => {
                    values.par_iter().enumerate().with_min_len(1 << 14).for_each(|(i, &k)| insert(i, hash_u64(k as u64)))
                }
                BuildKeys::Rows { hashes, .. } => {
                    hashes.par_iter().enumerate().with_min_len(1 << 14).for_each(|(i, &h)| insert(i, h))
                }
            }
        }
        let heads: Vec<u32> = heads.into_iter().map(|a| a.into_inner()).collect();
        if crate::exec::pipeline::profiling() {
            let (mut used, mut longest, mut total) = (0usize, 0usize, 0usize);
            for &h in &heads {
                let mut len = 0usize;
                let mut cur = h;
                while cur != 0 && len <= n {
                    len += 1;
                    cur = next[(cur - 1) as usize];
                }
                if len > 0 {
                    used += 1;
                }
                longest = longest.max(len);
                total += len;
            }
            eprintln!("[workhouse]   join table: {n} rows, {} buckets, {used} used, longest chain {longest}, chained rows {total}", heads.len());
        }
        let matched = track_matches.then(|| (0..n).map(|_| AtomicBool::new(false)).collect());
        Ok(Self { batch, keys, heads, next, mask, matched, memory: None })
    }

    /// Keep `r` (the memory the table was built in) for as long as the table lives.
    pub fn holding(mut self, r: Reservation) -> Self {
        self.memory = Some(r);
        self
    }

    pub fn num_rows(&self) -> usize {
        self.batch.num_rows()
    }

    /// Build rows whose matched flag equals `matched` (mark-mode semi/anti joins).
    pub fn rows_by_match(&self, matched: bool) -> Result<Vec<RecordBatch>> {
        let m = self.matched.as_ref().expect("match tracking");
        let idx: Vec<u32> = m
            .iter()
            .enumerate()
            .filter(|(_, f)| f.load(Ordering::Relaxed) == matched)
            .map(|(i, _)| i as u32)
            .collect();
        let mut out = vec![];
        for chunk in idx.chunks(1 << 17) {
            out.push(crate::exec::sort::take_batch(&self.batch, chunk)?);
        }
        Ok(out)
    }

    fn normalize_probe(&self, cols: &[ArrayRef]) -> Result<KeyBatch> {
        let n = cols.first().map(|c| c.len()).unwrap_or(0);
        match &self.keys {
            BuildKeys::Int { packing, .. } => {
                let ints = cols.iter().map(to_i64).collect::<Result<Vec<_>>>()?;
                let nulls = combined_nulls(cols);
                match packing {
                    None => {
                        let values = ints[0].as_primitive::<arrow::datatypes::Int64Type>().values().to_vec();
                        let valid = match nulls {
                            None => vec![true; n],
                            Some(nb) => (0..n).map(|i| nb.is_valid(i)).collect(),
                        };
                        Ok(KeyBatch::Int { values, valid })
                    }
                    Some(p) => {
                        let mut kb = pack(&ints, p, n);
                        if let (KeyBatch::Int { valid, .. }, Some(nb)) = (&mut kb, nulls) {
                            for (i, v) in valid.iter_mut().enumerate() {
                                *v &= nb.is_valid(i);
                            }
                        }
                        Ok(kb)
                    }
                }
            }
            BuildKeys::Rows { conv, .. } => {
                let rows = conv.convert_columns(cols)?;
                let hashes = (0..rows.num_rows()).map(|i| hash_bytes(rows.row(i).as_ref())).collect();
                Ok(KeyBatch::Rows { rows, hashes, valid: combined_nulls(cols) })
            }
        }
    }

    /// For each probe row call `on_match(probe_row, build_row)` for every match.
    #[inline]
    fn for_each_match(&self, kb: &KeyBatch, mut on_match: impl FnMut(usize, usize) -> bool) {
        match (&self.keys, kb) {
            (BuildKeys::Int { values: bv, .. }, KeyBatch::Int { values, valid }) => {
                for (i, (&k, &ok)) in values.iter().zip(valid.iter()).enumerate() {
                    if !ok {
                        continue;
                    }
                    let mut cur = self.heads[hash_u64(k as u64) as usize & self.mask];
                    while cur != 0 {
                        let b = (cur - 1) as usize;
                        // SAFETY: chain entries are valid build row indices
                        if unsafe { *bv.get_unchecked(b) } == k && !on_match(i, b) {
                            break;
                        }
                        cur = unsafe { *self.next.get_unchecked(b) };
                    }
                }
            }
            (BuildKeys::Rows { rows: br, hashes: bh, .. }, KeyBatch::Rows { rows, hashes, valid }) => {
                for (i, &h) in hashes.iter().enumerate() {
                    if valid.as_ref().is_some_and(|v| v.is_null(i)) {
                        continue;
                    }
                    let mut cur = self.heads[h as usize & self.mask];
                    while cur != 0 {
                        let b = (cur - 1) as usize;
                        if bh[b] == h && br.row(b) == rows.row(i) && !on_match(i, b) {
                            break;
                        }
                        cur = self.next[b];
                    }
                }
            }
            _ => unreachable!(),
        }
    }
}

fn rows_keys(cols: &[ArrayRef]) -> Result<BuildKeys> {
    let conv = RowConverter::new(cols.iter().map(|c| SortField::new(c.data_type().clone())).collect())?;
    let rows = conv.convert_columns(cols)?;
    let hashes: Vec<u64> = (0..rows.num_rows())
        .into_par_iter()
        .with_min_len(1 << 14)
        .map(|i| hash_bytes(rows.row(i).as_ref()))
        .collect();
    Ok(BuildKeys::Rows { conv, rows, hashes })
}

fn pack(ints: &[ArrayRef], p: &Packing, n: usize) -> KeyBatch {
    let mut values = vec![0i64; n];
    let mut valid = vec![true; n];
    for (c, &(mn, mx, shift)) in ints.iter().zip(&p.cols) {
        let a = c.as_primitive::<arrow::datatypes::Int64Type>();
        for (i, &v) in a.values().iter().enumerate() {
            if v < mn || v > mx {
                valid[i] = false;
            } else {
                values[i] |= ((v - mn) as i64) << shift;
            }
        }
    }
    KeyBatch::Int { values, valid }
}

// ---------------------------------------------------------------------------
// build sink
// ---------------------------------------------------------------------------

/// The build side of a hash join: a table in memory, or partitions on disk
/// when it did not fit under the memory limit (a grace hash join follows).
pub enum BuildSide {
    Table(JoinHashTable),
    Spilled(Vec<Option<SpillFile>>),
}

pub struct JoinBuildSink {
    pub key_exprs: Vec<PhysExpr>,
    pub schema: SchemaRef,
    pub track_matches: bool,
    spilling: AtomicBool,
    spill: PartitionedSpill,
}

pub struct JoinBuildLocal {
    batches: Vec<(usize, RecordBatch)>,
    reservation: Reservation,
}

impl JoinBuildSink {
    pub fn new(key_exprs: Vec<PhysExpr>, schema: SchemaRef, track_matches: bool) -> Self {
        let spill = PartitionedSpill::new(schema.clone(), grace_partitions());
        Self { key_exprs, schema, track_matches, spilling: AtomicBool::new(false), spill }
    }

    fn spill_batch(&self, batch: &RecordBatch) -> Result<()> {
        let keys = self.key_exprs.iter().map(|e| e.evaluate_array(batch)).collect::<Result<Vec<_>>>()?;
        self.spill.write(batch, &keys)
    }

    fn spill_local(&self, local: &mut JoinBuildLocal) -> Result<()> {
        for (_, b) in local.batches.drain(..) {
            self.spill_batch(&b)?;
        }
        local.reservation.free();
        Ok(())
    }
}

impl Sink for JoinBuildSink {
    type Local = JoinBuildLocal;
    type Output = BuildSide;

    fn make_local(&self) -> Self::Local {
        JoinBuildLocal { batches: vec![], reservation: memory::pool().reservation() }
    }
    fn push(&self, local: &mut Self::Local, morsel: usize, batch: RecordBatch) -> Result<()> {
        if batch.num_rows() == 0 {
            return Ok(());
        }
        if self.spilling.load(Ordering::Relaxed) {
            return self.spill_batch(&batch);
        }
        // the table holds the rows about twice: concatenated copy, keys and chains
        if local.reservation.try_grow(batch.get_array_memory_size() * 2) {
            local.batches.push((morsel, batch));
            return Ok(());
        }
        self.spilling.store(true, Ordering::Relaxed);
        self.spill_local(local)?;
        self.spill_batch(&batch)
    }
    fn finalize(&self, mut locals: Vec<Self::Local>) -> Result<BuildSide> {
        if self.spilling.load(Ordering::Relaxed) {
            for l in &mut locals {
                self.spill_local(l)?;
            }
            let files = self.spill.finish()?;
            if crate::exec::pipeline::profiling() {
                let bytes: u64 = files.iter().flatten().map(|f| f.bytes()).sum();
                eprintln!("[workhouse]   join build spilled {:.1} MB to {} partitions", bytes as f64 / 1e6, files.iter().flatten().count());
            }
            return Ok(BuildSide::Spilled(files));
        }
        let mut held = memory::pool().reservation();
        held.grow(locals.iter().map(|l| l.reservation.size()).sum());
        let mut all: Vec<(usize, RecordBatch)> = locals.into_iter().flat_map(|l| l.batches).collect();
        all.sort_by_key(|(m, _)| *m);
        let batches: Vec<RecordBatch> = all.into_iter().map(|(_, b)| b).collect();
        let t0 = std::time::Instant::now();
        let batch = concat_parallel(&self.schema, &batches)?;
        let t1 = t0.elapsed();
        let keys = self.key_exprs.iter().map(|e| e.evaluate_array(&batch)).collect::<Result<Vec<_>>>()?;
        let t = JoinHashTable::build(batch, keys, self.track_matches)?.holding(held);
        if crate::exec::pipeline::profiling() {
            eprintln!("[workhouse]   join build: concat {:.2}ms, total {:.2}ms", t1.as_secs_f64() * 1e3, t0.elapsed().as_secs_f64() * 1e3);
        }
        Ok(BuildSide::Table(t))
    }
}

/// Concatenate batches column-parallel.
pub fn concat_parallel(schema: &SchemaRef, batches: &[RecordBatch]) -> Result<RecordBatch> {
    if batches.len() == 1 {
        return crate::exec::ops::compact_batch_views(batches[0].clone());
    }
    if batches.is_empty() || schema.fields().is_empty() {
        return Ok(concat_batches(schema, batches)?);
    }
    let rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    let cols = (0..schema.fields().len())
        .into_par_iter()
        .map(|c| {
            let arrays: Vec<&dyn Array> = batches.iter().map(|b| b.column(c).as_ref()).collect();
            if matches!(arrays[0].data_type(), DataType::Utf8View | DataType::BinaryView) {
                concat_views(&arrays)
            } else {
                arrow::compute::concat(&arrays)
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(RecordBatch::try_new_with_options(
        schema.clone(),
        cols,
        &RecordBatchOptions::new().with_row_count(Some(rows)),
    )?)
}

/// Concatenate view arrays, compacting their strings into fresh buffers
/// (in parallel over ~64K-row pieces): the inputs reference many decoded
/// page buffers, and every array taken from the result would carry them all.
fn concat_views(arrays: &[&dyn Array]) -> std::result::Result<ArrayRef, arrow::error::ArrowError> {
    let mut groups: Vec<Vec<&dyn Array>> = vec![];
    let mut cur = vec![];
    let mut rows = 0;
    for &a in arrays {
        cur.push(a);
        rows += a.len();
        if rows >= 1 << 16 {
            groups.push(std::mem::take(&mut cur));
            rows = 0;
        }
    }
    if !cur.is_empty() {
        groups.push(cur);
    }
    let pieces = groups
        .par_iter()
        .map(|g| {
            let c = arrow::compute::concat(g)?;
            Ok(match c.data_type() {
                DataType::Utf8View => Arc::new(c.as_string_view().gc()) as ArrayRef,
                _ => Arc::new(c.as_binary_view().gc()) as ArrayRef,
            })
        })
        .collect::<std::result::Result<Vec<_>, arrow::error::ArrowError>>()?;
    if pieces.len() == 1 {
        return Ok(pieces.into_iter().next().unwrap());
    }
    let refs: Vec<&dyn Array> = pieces.iter().map(|p| p.as_ref()).collect();
    arrow::compute::concat(&refs)
}

// ---------------------------------------------------------------------------
// probe operator
// ---------------------------------------------------------------------------

pub struct HashJoinProbe {
    pub table: Arc<JoinHashTable>,
    pub probe_keys: Vec<PhysExpr>,
    pub join_type: JoinType,
    /// Residual predicate over [probe columns..., build columns...].
    pub filter: Option<PhysExpr>,
    /// Schema of [probe..., build...].
    pub joined_schema: SchemaRef,
    /// Final output schema (after optional reordering).
    pub output_schema: SchemaRef,
    /// Output column i = joined column order[i] (used when sides were swapped).
    pub order: Option<Vec<usize>>,
    /// Semi/anti join with the build side being the preserved one: probing
    /// only marks matched build rows, results are read from the table.
    pub mark_only: bool,
}

impl HashJoinProbe {
    fn assemble(&self, probe: &RecordBatch, pidx: &[u32], bidx: &UInt32Array) -> Result<RecordBatch> {
        let n = pidx.len();
        let identity = n == probe.num_rows() && pidx.iter().enumerate().all(|(i, &p)| p as usize == i);
        let mut cols = Vec::with_capacity(self.joined_schema.fields().len());
        if identity {
            cols.extend(probe.columns().iter().cloned());
        } else {
            let pidx = UInt32Array::from(pidx.to_vec());
            for c in probe.columns() {
                cols.push(take(c, &pidx, None)?);
            }
        }
        for c in self.table.batch.columns() {
            cols.push(take(c, bidx, None)?);
        }
        Ok(RecordBatch::try_new_with_options(
            self.joined_schema.clone(),
            cols,
            &RecordBatchOptions::new().with_row_count(Some(n)),
        )?)
    }

    fn finish_batch(&self, b: RecordBatch) -> Result<RecordBatch> {
        match &self.order {
            None => Ok(RecordBatch::try_new_with_options(
                self.output_schema.clone(),
                b.columns().to_vec(),
                &RecordBatchOptions::new().with_row_count(Some(b.num_rows())),
            )?),
            Some(order) => Ok(RecordBatch::try_new_with_options(
                self.output_schema.clone(),
                order.iter().map(|&i| b.column(i).clone()).collect(),
                &RecordBatchOptions::new().with_row_count(Some(b.num_rows())),
            )?),
        }
    }

    fn emit_pairs(&self, probe: &RecordBatch, p: &[u32], b: &[Option<u32>], emit: Emit<'_>) -> Result<()> {
        for start in (0..p.len()).step_by(OUT_CHUNK) {
            let end = (start + OUT_CHUNK).min(p.len());
            let bidx: UInt32Array = b[start..end].iter().copied().collect();
            let joined = self.assemble(probe, &p[start..end], &bidx)?;
            emit(self.finish_batch(joined)?)?;
        }
        Ok(())
    }

    /// Candidate pairs filtered through the residual predicate.
    fn filter_pairs(&self, probe: &RecordBatch, p: Vec<u32>, b: Vec<u32>) -> Result<(Vec<u32>, Vec<u32>)> {
        let Some(f) = &self.filter else { return Ok((p, b)) };
        let mut keep_p = Vec::with_capacity(p.len());
        let mut keep_b = Vec::with_capacity(b.len());
        for start in (0..p.len()).step_by(OUT_CHUNK) {
            let end = (start + OUT_CHUNK).min(p.len());
            let bidx = UInt32Array::from(b[start..end].to_vec());
            let joined = self.assemble(probe, &p[start..end], &bidx)?;
            let mask = f.evaluate_array(&joined)?;
            let mask = mask.as_boolean();
            for (k, i) in (start..end).enumerate() {
                if mask.is_valid(k) && mask.value(k) {
                    keep_p.push(p[i]);
                    keep_b.push(b[i]);
                }
            }
        }
        Ok((keep_p, keep_b))
    }

    fn mark(&self, b: &[u32]) {
        if let Some(m) = &self.table.matched {
            for &x in b {
                m[x as usize].store(true, Ordering::Relaxed);
            }
        }
    }
}

impl Operator for HashJoinProbe {
    fn execute(&self, batch: RecordBatch, emit: Emit<'_>) -> Result<()> {
        let n = batch.num_rows();
        let key_cols = self.probe_keys.iter().map(|e| e.evaluate_array(&batch)).collect::<Result<Vec<_>>>()?;
        if self.mark_only {
            if self.table.num_rows() == 0 {
                return Ok(());
            }
            let kb = self.table.normalize_probe(&key_cols)?;
            let matched = self.table.matched.as_ref().expect("mark mode requires match tracking");
            if self.filter.is_none() {
                self.table.for_each_match(&kb, |_, b| {
                    matched[b].store(true, Ordering::Relaxed);
                    true
                });
            } else {
                let mut p = Vec::with_capacity(n);
                let mut b = Vec::with_capacity(n);
                self.table.for_each_match(&kb, |i, bi| {
                    if !matched[bi].load(Ordering::Relaxed) {
                        p.push(i as u32);
                        b.push(bi as u32);
                    }
                    true
                });
                let (_, b) = self.filter_pairs(&batch, p, b)?;
                self.mark(&b);
            }
            return Ok(());
        }
        if self.table.num_rows() == 0 {
            return match self.join_type {
                JoinType::Inner | JoinType::Semi | JoinType::Right => Ok(()),
                JoinType::Anti => emit(batch),
                _ => {
                    let none: Vec<Option<u32>> = vec![None; n];
                    let p: Vec<u32> = (0..n as u32).collect();
                    self.emit_pairs(&batch, &p, &none, emit)
                }
            };
        }
        let kb = self.table.normalize_probe(&key_cols)?;
        match self.join_type {
            JoinType::Semi | JoinType::Anti if self.filter.is_none() => {
                let mut found = vec![false; n];
                self.table.for_each_match(&kb, |i, _| {
                    found[i] = true;
                    false
                });
                let keep = if self.join_type == JoinType::Semi {
                    found
                } else {
                    found.into_iter().map(|f| !f).collect()
                };
                let mask = BooleanArray::from(keep);
                let c = mask.true_count();
                if c == 0 {
                    return Ok(());
                }
                if c == n {
                    return emit(self.finish_batch(batch)?);
                }
                emit(self.finish_batch(filter_record_batch(&batch, &mask)?)?)
            }
            JoinType::Left | JoinType::Full if self.filter.is_none() => {
                // preserve probe order: matches of row i, or a single null match
                let mut p = Vec::with_capacity(n);
                let mut b: Vec<Option<u32>> = Vec::with_capacity(n);
                let mut last_row = usize::MAX;
                let mut emitted_upto = 0usize;
                self.table.for_each_match(&kb, |i, bi| {
                    if i != last_row {
                        for k in emitted_upto..i {
                            p.push(k as u32);
                            b.push(None);
                        }
                        last_row = i;
                        emitted_upto = i + 1;
                    }
                    p.push(i as u32);
                    b.push(Some(bi as u32));
                    true
                });
                for k in emitted_upto..n {
                    p.push(k as u32);
                    b.push(None);
                }
                if self.table.matched.is_some() {
                    let matched: Vec<u32> = b.iter().flatten().copied().collect();
                    self.mark(&matched);
                }
                self.emit_pairs(&batch, &p, &b, emit)
            }
            _ => {
                let mut p = Vec::with_capacity(n);
                let mut b = Vec::with_capacity(n);
                self.table.for_each_match(&kb, |i, bi| {
                    p.push(i as u32);
                    b.push(bi as u32);
                    true
                });
                let (p, b) = self.filter_pairs(&batch, p, b)?;
                match self.join_type {
                    JoinType::Inner => {
                        let b: Vec<Option<u32>> = b.into_iter().map(Some).collect();
                        self.emit_pairs(&batch, &p, &b, emit)
                    }
                    JoinType::Right => {
                        self.mark(&b);
                        let b: Vec<Option<u32>> = b.into_iter().map(Some).collect();
                        self.emit_pairs(&batch, &p, &b, emit)
                    }
                    JoinType::Semi | JoinType::Anti => {
                        let mut found = vec![false; n];
                        for &i in &p {
                            found[i as usize] = true;
                        }
                        let keep: Vec<bool> = if self.join_type == JoinType::Semi {
                            found
                        } else {
                            found.into_iter().map(|f| !f).collect()
                        };
                        let mask = BooleanArray::from(keep);
                        if mask.true_count() == 0 {
                            return Ok(());
                        }
                        emit(self.finish_batch(filter_record_batch(&batch, &mask)?)?)
                    }
                    JoinType::Left | JoinType::Full => {
                        self.mark(&b);
                        let mut found = vec![false; n];
                        for &i in &p {
                            found[i as usize] = true;
                        }
                        let mut pp = p;
                        let mut bb: Vec<Option<u32>> = b.into_iter().map(Some).collect();
                        for (i, f) in found.iter().enumerate() {
                            if !f {
                                pp.push(i as u32);
                                bb.push(None);
                            }
                        }
                        self.emit_pairs(&batch, &pp, &bb, emit)
                    }
                }
            }
        }
    }

    fn finish(&self) -> Result<Vec<RecordBatch>> {
        if self.mark_only {
            return Ok(vec![]);
        }
        let Some(m) = &self.table.matched else { return Ok(vec![]) };
        let unmatched: Vec<u32> = m
            .iter()
            .enumerate()
            .filter(|(_, f)| !f.load(Ordering::Relaxed))
            .map(|(i, _)| i as u32)
            .collect();
        if unmatched.is_empty() {
            return Ok(vec![]);
        }
        let probe_fields = self.joined_schema.fields().len() - self.table.batch.num_columns();
        let mut out = vec![];
        for chunk in unmatched.chunks(OUT_CHUNK) {
            let idx = UInt32Array::from(chunk.to_vec());
            let mut cols: Vec<ArrayRef> = (0..probe_fields)
                .map(|i| new_null_array(self.joined_schema.field(i).data_type(), chunk.len()))
                .collect();
            for c in self.table.batch.columns() {
                cols.push(take(c, &idx, None)?);
            }
            let b = RecordBatch::try_new_with_options(
                self.joined_schema.clone(),
                cols,
                &RecordBatchOptions::new().with_row_count(Some(chunk.len())),
            )?;
            out.push(self.finish_batch(b)?);
        }
        Ok(out)
    }

    fn describe(&self) -> String {
        format!(
            "HashJoinProbe({:?}{}, build_rows={}, keys=[{}]{})",
            self.join_type,
            if self.mark_only { " mark-build" } else { "" },
            self.table.num_rows(),
            self.probe_keys.iter().map(|k| k.to_string()).collect::<Vec<_>>().join(", "),
            if self.filter.is_some() { ", filtered" } else { "" }
        )
    }
}

// ---------------------------------------------------------------------------
// nested loop join (no equi-keys)
// ---------------------------------------------------------------------------

pub struct NestedLoopJoin {
    pub build: RecordBatch,
    pub join_type: JoinType,
    pub filter: Option<PhysExpr>,
    pub joined_schema: SchemaRef,
    pub output_schema: SchemaRef,
    pub order: Option<Vec<usize>>,
}

impl NestedLoopJoin {
    fn reorder(&self, b: RecordBatch) -> Result<RecordBatch> {
        let cols = match &self.order {
            None => b.columns().to_vec(),
            Some(o) => o.iter().map(|&i| b.column(i).clone()).collect(),
        };
        Ok(RecordBatch::try_new_with_options(
            self.output_schema.clone(),
            cols,
            &RecordBatchOptions::new().with_row_count(Some(b.num_rows())),
        )?)
    }
}

impl Operator for NestedLoopJoin {
    fn execute(&self, batch: RecordBatch, emit: Emit<'_>) -> Result<()> {
        let n = batch.num_rows();
        let m = self.build.num_rows();
        let rows_per_chunk = (OUT_CHUNK / m.max(1)).max(1);
        let mut found = vec![false; n];
        for start in (0..n).step_by(rows_per_chunk) {
            let end = (start + rows_per_chunk).min(n);
            let mut p = Vec::with_capacity((end - start) * m);
            let mut b = Vec::with_capacity((end - start) * m);
            for i in start..end {
                for j in 0..m {
                    p.push(i as u32);
                    b.push(j as u32);
                }
            }
            if p.is_empty() {
                continue;
            }
            let pidx = UInt32Array::from(p.clone());
            let bidx = UInt32Array::from(b);
            let mut cols: Vec<ArrayRef> = batch.columns().iter().map(|c| take(c, &pidx, None)).collect::<Result<_, _>>()?;
            for c in self.build.columns() {
                cols.push(take(c, &bidx, None)?);
            }
            let mut joined = RecordBatch::try_new_with_options(
                self.joined_schema.clone(),
                cols,
                &RecordBatchOptions::new().with_row_count(Some(p.len())),
            )?;
            let mut kept_p = p;
            if let Some(f) = &self.filter {
                let mask = f.evaluate_array(&joined)?;
                let mask = crate::physical::expr::null_as_false(mask.as_boolean());
                kept_p = kept_p.iter().zip(mask.values().iter()).filter_map(|(x, k)| k.then_some(*x)).collect();
                joined = filter_record_batch(&joined, &mask)?;
            }
            for &i in &kept_p {
                found[i as usize] = true;
            }
            if matches!(self.join_type, JoinType::Inner | JoinType::Left) && joined.num_rows() > 0 {
                emit(self.reorder(joined)?)?;
            }
        }
        match self.join_type {
            JoinType::Semi | JoinType::Anti => {
                let keep: Vec<bool> =
                    found.iter().map(|f| if self.join_type == JoinType::Semi { *f } else { !*f }).collect();
                let mask = BooleanArray::from(keep);
                if mask.true_count() > 0 {
                    emit(self.reorder(filter_record_batch(&batch, &mask)?)?)?;
                }
            }
            JoinType::Left => {
                let un: Vec<u32> = found.iter().enumerate().filter(|(_, f)| !**f).map(|(i, _)| i as u32).collect();
                if !un.is_empty() {
                    let idx = UInt32Array::from(un.clone());
                    let mut cols: Vec<ArrayRef> = batch.columns().iter().map(|c| take(c, &idx, None)).collect::<Result<_, _>>()?;
                    for f in self.build.schema().fields() {
                        cols.push(new_null_array(f.data_type(), un.len()));
                    }
                    let b = RecordBatch::try_new_with_options(
                        self.joined_schema.clone(),
                        cols,
                        &RecordBatchOptions::new().with_row_count(Some(un.len())),
                    )?;
                    emit(self.reorder(b)?)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

    fn describe(&self) -> String {
        format!("NestedLoopJoin({:?}, build_rows={})", self.join_type, self.build.num_rows())
    }
}

pub fn joined_schema(probe: &Schema, build: &Schema) -> SchemaRef {
    let mut fields: Vec<_> = probe.fields().iter().map(|f| Arc::new(f.as_ref().clone().with_nullable(true))).collect();
    fields.extend(build.fields().iter().map(|f| Arc::new(f.as_ref().clone().with_nullable(true))));
    Arc::new(Schema::new(fields))
}
