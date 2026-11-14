//! Hash joins.
//!
//! Build: the build side is materialised, key columns are normalised (integer
//! keys - also multi-column ones - are packed into a single i64 when their
//! value ranges allow it, everything else uses the Arrow row format) and
//! indexed: integer keys by a partitioned open-addressing table
//! ([`crate::exec::join_table`]), row-format keys by a chained hash table
//! filled *in parallel* with an atomic swap on the bucket heads (no locks).
//! Probe: a streaming operator inside the probe-side pipeline; each morsel
//! batch is hashed and matched against the shared, read-only table.

use std::ops::Range;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};

use arrow::array::*;
use arrow::buffer::{BooleanBuffer, NullBuffer, ScalarBuffer};
use arrow::compute::{cast, concat_batches, filter_record_batch, take};
use arrow::datatypes::{DataType, Schema, SchemaRef};
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use arrow::row::{RowConverter, Rows, SortField};
use rayon::prelude::*;

use crate::error::{Result, WhError};
use crate::exec::batch_mem;
use crate::exec::join_spill::{PartitionedSpill, grace_partitions};
use crate::exec::join_table::{IntTable, PREFETCH_AHEAD, PREFETCH_MIN_BYTES, prefetch};
use crate::exec::memory::{self, Reservation};
use crate::exec::pipeline::{Emit, Operator, Sink};
use crate::exec::spill::SpillFile;
use crate::hash::hash_bytes;
use crate::logical::JoinType;
use crate::physical::expr::{PhysExpr, null_as_false};

const OUT_CHUNK: usize = 1 << 13;
/// Hash table bytes per build row (directory, entry, normalised key).
const TABLE_ROW_BYTES: usize = 40;
/// Buffers a view column of a build table may reference without compaction.
const MAX_TABLE_BUFFERS: usize = 32;

/// Key types joined as one integer column.
pub fn int_like(dt: &DataType) -> bool {
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
    Int { table: IntTable, packing: Option<Packing> },
    /// one string column: its values compared as they are, without a row encoding
    Str { keys: StringViewArray, hashes: Vec<u64>, chains: Chains },
    Rows { conv: RowConverter, rows: Rows, hashes: Vec<u64>, chains: Chains },
}

/// A chained hash table over row-format keys: bucket heads and the next row
/// of each row's chain (row + 1; 0 ends a chain).
struct Chains {
    heads: Vec<u32>,
    next: Vec<u32>,
    mask: usize,
}

pub struct JoinHashTable {
    pub batch: RecordBatch,
    keys: BuildKeys,
    matched: Option<Vec<AtomicBool>>,
    /// memory accounted for the table (released with it)
    memory: Option<Reservation>,
}

struct SendPtr(*mut u32);
unsafe impl Send for SendPtr {}
unsafe impl Sync for SendPtr {}

/// Normalised probe/build keys: either packed i64s or row-format bytes.
enum KeyBatch {
    Int { values: ScalarBuffer<i64>, valid: Option<Vec<bool>> },
    Str { keys: StringViewArray, hashes: Vec<u64>, valid: Option<NullBuffer> },
    Rows { rows: Rows, hashes: Vec<u64>, valid: Option<NullBuffer> },
}

impl JoinHashTable {
    pub fn build(batch: RecordBatch, key_cols: Vec<ArrayRef>, track_matches: bool) -> Result<Self> {
        let n = batch.num_rows();
        let valid = combined_nulls(&key_cols);
        let all_int = key_cols.iter().all(|c| int_like(c.data_type()));
        let mut ints = None;
        if all_int {
            let cols = key_cols.iter().map(to_i64).collect::<Result<Vec<_>>>()?;
            if cols.len() == 1 {
                ints = Some((cols[0].as_primitive::<arrow::datatypes::Int64Type>().values().clone(), None));
            } else if let Some(packing) = packing_of(&cols) {
                let KeyBatch::Int { values, .. } = pack(&cols, &packing, n) else { unreachable!() };
                ints = Some((values, Some(packing)));
            }
        }
        let keys = match ints {
            Some((values, packing)) => BuildKeys::Int { table: IntTable::build(&values, valid.as_ref()), packing },
            None if key_cols.len() == 1 && is_string(key_cols[0].data_type()) => {
                let keys = string_views(&key_cols[0])?;
                let hashes: Vec<u64> = (0..n).into_par_iter().with_min_len(1 << 14).map(|i| hash_bytes(keys.value(i).as_bytes())).collect();
                let chains = Chains::build(&hashes, valid.as_ref());
                BuildKeys::Str { keys, hashes, chains }
            }
            None => rows_keys(&key_cols, valid.as_ref())?,
        };
        if crate::exec::pipeline::profiling() {
            if let BuildKeys::Rows { chains, .. } | BuildKeys::Str { chains, .. } = &keys {
                chains.report(n);
            }
        }
        let matched = track_matches.then(|| (0..n).map(|_| AtomicBool::new(false)).collect());
        Ok(Self { batch, keys, matched, memory: None })
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

    /// Whether each of `keys`, the probe column of a join on this one column,
    /// is among the build keys. None when the table is not on a single
    /// integer column, or `keys` is not one.
    pub fn contains(&self, keys: &ArrayRef) -> Option<BooleanBuffer> {
        let BuildKeys::Int { table, packing: None } = &self.keys else { return None };
        if !int_like(keys.data_type()) {
            return None;
        }
        let ints = to_i64(keys).ok()?;
        let values = ints.as_primitive::<arrow::datatypes::Int64Type>().values();
        Some(table.contains(values, combined_nulls(std::slice::from_ref(keys)).as_ref()))
    }

    fn normalize_probe(&self, cols: &[ArrayRef]) -> Result<KeyBatch> {
        let n = cols.first().map(|c| c.len()).unwrap_or(0);
        match &self.keys {
            BuildKeys::Int { packing, .. } => {
                let ints = cols.iter().map(to_i64).collect::<Result<Vec<_>>>()?;
                let nulls = combined_nulls(cols);
                match packing {
                    None => {
                        let values = ints[0].as_primitive::<arrow::datatypes::Int64Type>().values().clone();
                        let valid = nulls.map(|nb| (0..n).map(|i| nb.is_valid(i)).collect());
                        Ok(KeyBatch::Int { values, valid })
                    }
                    Some(p) => {
                        let mut kb = pack(&ints, p, n);
                        if let (KeyBatch::Int { valid, .. }, Some(nb)) = (&mut kb, nulls) {
                            match valid {
                                Some(v) => {
                                    for (i, b) in v.iter_mut().enumerate() {
                                        *b &= nb.is_valid(i);
                                    }
                                }
                                None => *valid = Some((0..n).map(|i| nb.is_valid(i)).collect()),
                            }
                        }
                        Ok(kb)
                    }
                }
            }
            BuildKeys::Str { .. } => {
                let keys = string_views(&cols[0])?;
                let hashes = (0..n).map(|i| hash_bytes(keys.value(i).as_bytes())).collect();
                Ok(KeyBatch::Str { keys, hashes, valid: combined_nulls(cols) })
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
            (BuildKeys::Int { table, .. }, KeyBatch::Int { values, valid }) => {
                table.probe(values, valid.as_deref(), on_match)
            }
            (BuildKeys::Str { keys: bk, hashes: bh, chains }, KeyBatch::Str { keys, hashes, valid }) => {
                // a table out of cache: fetch the bucket heads, then the first rows of the chains, ahead of the probe
                let far = chains.heads.len() * 4 > PREFETCH_MIN_BYTES;
                let half = PREFETCH_AHEAD / 2;
                for (i, &h) in hashes.iter().enumerate() {
                    if far {
                        if let Some(&ah) = hashes.get(i + PREFETCH_AHEAD) {
                            prefetch(&chains.heads[ah as usize & chains.mask]);
                        }
                        if let Some(&ah) = hashes.get(i + half) {
                            let first = chains.heads[ah as usize & chains.mask];
                            if first != 0 {
                                let b = (first - 1) as usize;
                                prefetch(&bh[b]);
                                prefetch(&bk.views()[b]);
                            }
                        }
                    }
                    if valid.as_ref().is_some_and(|v| v.is_null(i)) {
                        continue;
                    }
                    let mut cur = chains.heads[h as usize & chains.mask];
                    while cur != 0 {
                        let b = (cur - 1) as usize;
                        if bh[b] == h && bk.value(b) == keys.value(i) && !on_match(i, b) {
                            break;
                        }
                        cur = chains.next[b];
                    }
                }
            }
            (BuildKeys::Rows { rows: br, hashes: bh, chains, .. }, KeyBatch::Rows { rows, hashes, valid }) => {
                for (i, &h) in hashes.iter().enumerate() {
                    if valid.as_ref().is_some_and(|v| v.is_null(i)) {
                        continue;
                    }
                    let mut cur = chains.heads[h as usize & chains.mask];
                    while cur != 0 {
                        let b = (cur - 1) as usize;
                        if bh[b] == h && br.row(b) == rows.row(i) && !on_match(i, b) {
                            break;
                        }
                        cur = chains.next[b];
                    }
                }
            }
            _ => unreachable!(),
        }
    }
}

fn is_string(t: &DataType) -> bool {
    matches!(t, DataType::Utf8 | DataType::Utf8View)
}

/// A string column as views (a `Utf8` column keeps its buffer: only views are made).
fn string_views(a: &ArrayRef) -> Result<StringViewArray> {
    Ok(match a.data_type() {
        DataType::Utf8View => a.as_string_view().clone(),
        _ => cast(a, &DataType::Utf8View)?.as_string_view().clone(),
    })
}

fn rows_keys(cols: &[ArrayRef], valid: Option<&NullBuffer>) -> Result<BuildKeys> {
    let conv = RowConverter::new(cols.iter().map(|c| SortField::new(c.data_type().clone())).collect())?;
    let rows = conv.convert_columns(cols)?;
    let hashes: Vec<u64> = (0..rows.num_rows())
        .into_par_iter()
        .with_min_len(1 << 14)
        .map(|i| hash_bytes(rows.row(i).as_ref()))
        .collect();
    let chains = Chains::build(&hashes, valid);
    Ok(BuildKeys::Rows { conv, rows, hashes, chains })
}

impl Chains {
    fn build(hashes: &[u64], valid: Option<&NullBuffer>) -> Self {
        let n = hashes.len();
        let buckets = (n * 2).next_power_of_two().max(16);
        let mask = buckets - 1;
        let heads: Vec<AtomicU32> = (0..buckets).map(|_| AtomicU32::new(0)).collect();
        let mut next = vec![0u32; n];
        let next_ptr = SendPtr(next.as_mut_ptr());
        hashes.par_iter().enumerate().with_min_len(1 << 14).for_each(|(i, &h)| {
            if valid.is_some_and(|v| v.is_null(i)) {
                return;
            }
            let old = heads[h as usize & mask].swap(i as u32 + 1, Ordering::Relaxed);
            let p = &next_ptr;
            // SAFETY: every row index is written by exactly one task
            unsafe { *p.0.add(i) = old };
        });
        Self { heads: heads.into_iter().map(|a| a.into_inner()).collect(), next, mask }
    }

    fn report(&self, n: usize) {
        let (mut used, mut longest, mut total) = (0usize, 0usize, 0usize);
        for &h in &self.heads {
            let mut len = 0usize;
            let mut cur = h;
            while cur != 0 && len <= n {
                len += 1;
                cur = self.next[(cur - 1) as usize];
            }
            if len > 0 {
                used += 1;
            }
            longest = longest.max(len);
            total += len;
        }
        eprintln!("[iara]   join table: {n} rows, {} buckets, {used} used, longest chain {longest}, chained rows {total}", self.heads.len());
    }
}

/// How to pack integer key columns into one i64 (None: their value ranges
/// need more than 63 bits).
fn packing_of(ints: &[ArrayRef]) -> Option<Packing> {
    let mut cols = vec![];
    let mut total_bits = 0u32;
    for c in ints {
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
    if total_bits > 63 {
        return None;
    }
    let mut shift = 0u32;
    let mut packing = Packing { cols: vec![] };
    for (mn, mx, bits) in cols.iter().rev() {
        packing.cols.push((*mn, *mx, shift));
        shift += bits;
    }
    packing.cols.reverse();
    Some(packing)
}

fn pack(ints: &[ArrayRef], p: &Packing, n: usize) -> KeyBatch {
    if ints.len() == 2 {
        let a0 = ints[0].as_primitive::<arrow::datatypes::Int64Type>().values();
        let a1 = ints[1].as_primitive::<arrow::datatypes::Int64Type>().values();
        let (mn0, mx0, s0) = p.cols[0];
        let (mn1, mx1, s1) = p.cols[1];
        let mut values = Vec::with_capacity(n);
        let mut any_invalid = false;
        for (&v0, &v1) in a0.iter().zip(a1.iter()) {
            let ok = v0 >= mn0 && v0 <= mx0 && v1 >= mn1 && v1 <= mx1;
            any_invalid |= !ok;
            let packed = if ok {
                (((v0 - mn0) as i64) << s0) | (((v1 - mn1) as i64) << s1)
            } else {
                0
            };
            values.push(packed);
        }
        let valid = any_invalid.then(|| {
            a0.iter()
                .zip(a1.iter())
                .map(|(&v0, &v1)| v0 >= mn0 && v0 <= mx0 && v1 >= mn1 && v1 <= mx1)
                .collect()
        });
        return KeyBatch::Int { values: values.into(), valid };
    }
    let mut values = vec![0i64; n];
    let mut valid = vec![true; n];
    let mut any_invalid = false;
    for (c, &(mn, mx, shift)) in ints.iter().zip(&p.cols) {
        let a = c.as_primitive::<arrow::datatypes::Int64Type>();
        for (i, &v) in a.values().iter().enumerate() {
            if v < mn || v > mx {
                valid[i] = false;
                any_invalid = true;
            } else {
                values[i] |= ((v - mn) as i64) << shift;
            }
        }
    }
    KeyBatch::Int { values: values.into(), valid: any_invalid.then_some(valid) }
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
        // the rows (concatenated) and their entries in the hash table
        let batch = batch_mem::compact(batch)?;
        let bytes = batch_mem::batch_bytes(&batch) + batch.num_rows() * TABLE_ROW_BYTES;
        if local.reservation.try_grow(bytes) {
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
                eprintln!("[iara]   join build spilled {:.1} MB to {} partitions", bytes as f64 / 1e6, files.iter().flatten().count());
            }
            return Ok(BuildSide::Spilled(files));
        }
        // the workers' reservations pass to the table (released first: the
        // pool would briefly count them twice)
        let total: usize = locals.iter().map(|l| l.reservation.size()).sum();
        let mut all: Vec<(usize, RecordBatch)> = locals.into_iter().flat_map(|l| l.batches).collect();
        let mut held = memory::pool().reservation();
        held.grow(total);
        all.sort_by_key(|(m, _)| *m);
        let batches: Vec<RecordBatch> = all.into_iter().map(|(_, b)| b).collect();
        let t0 = std::time::Instant::now();
        let batch = concat_parallel(&self.schema, &batches)?;
        // the parts, now copied: not held through the table's build
        drop(batches);
        let t1 = t0.elapsed();
        let keys = self.key_exprs.iter().map(|e| e.evaluate_array(&batch)).collect::<Result<Vec<_>>>()?;
        let t = JoinHashTable::build(batch, keys, self.track_matches)?.holding(held);
        if crate::exec::pipeline::profiling() {
            eprintln!("[iara]   join build: concat {:.2}ms, total {:.2}ms", t1.as_secs_f64() * 1e3, t0.elapsed().as_secs_f64() * 1e3);
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

/// Concatenate view arrays. Arrays taken from the result share all of its
/// buffers (and every take clones and drops the whole list, contending on
/// the buffers' reference counts across threads), so the result keeps few:
/// unless the inputs already reference few buffers that they use, their
/// strings are copied into one fresh buffer per piece, the pieces (one per
/// thread, in parallel) then concatenated.
fn concat_views(arrays: &[&dyn Array]) -> std::result::Result<ArrayRef, arrow::error::ArrowError> {
    let refs: usize = arrays.iter().map(|a| batch_mem::view_buffers(*a)).sum();
    if refs <= MAX_TABLE_BUFFERS && !batch_mem::views_wasteful(arrays) {
        return arrow::compute::concat(arrays);
    }
    let rows: usize = arrays.iter().map(|a| a.len()).sum();
    let piece_rows = (rows / rayon::current_num_threads().max(1)).max(1 << 16);
    let mut groups: Vec<Vec<&dyn Array>> = vec![];
    let mut cur = vec![];
    let mut acc = 0;
    for &a in arrays {
        cur.push(a);
        acc += a.len();
        if acc >= piece_rows {
            groups.push(std::mem::take(&mut cur));
            acc = 0;
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

/// The (probe row, build row) pairs that passed a residual filter.
#[derive(Default)]
struct Kept {
    p: Vec<u32>,
    b: Vec<u32>,
}

impl Kept {
    /// Add the pairs of `mask`, which covers the pairs from `start` on.
    fn add(&mut self, p: &[u32], b: &[u32], start: usize, mask: &BooleanArray) {
        for k in mask.values().set_indices() {
            self.p.push(p[start + k]);
            self.b.push(b[start + k]);
        }
    }
}

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

    fn emit_matched_pairs(&self, probe: &RecordBatch, p: &[u32], b: &[u32], emit: Emit<'_>) -> Result<()> {
        for start in (0..p.len()).step_by(OUT_CHUNK) {
            let end = (start + OUT_CHUNK).min(p.len());
            let bidx = UInt32Array::from(b[start..end].to_vec());
            let joined = self.assemble(probe, &p[start..end], &bidx)?;
            emit(self.finish_batch(joined)?)?;
        }
        Ok(())
    }

    /// Evaluate the residual predicate over the candidate pairs, `OUT_CHUNK`
    /// at a time. `each` gets the range of pairs, their joined batch (the
    /// batch the predicate saw, so kept pairs need no second assemble) and
    /// the mask of kept ones (nulls are false).
    fn filter_each(
        &self,
        f: &PhysExpr,
        probe: &RecordBatch,
        p: &[u32],
        b: &[u32],
        mut each: impl FnMut(std::ops::Range<usize>, RecordBatch, &BooleanArray) -> Result<()>,
    ) -> Result<()> {
        for start in (0..p.len()).step_by(OUT_CHUNK) {
            let end = (start + OUT_CHUNK).min(p.len());
            let bidx = UInt32Array::from(b[start..end].to_vec());
            let joined = self.assemble(probe, &p[start..end], &bidx)?;
            let mask = f.evaluate_array(&joined)?;
            let mask = null_as_false(mask.as_boolean());
            each(start..end, joined, &mask)?;
        }
        Ok(())
    }

    /// Candidate pairs filtered through the residual predicate.
    fn filter_pairs(&self, probe: &RecordBatch, p: Vec<u32>, b: Vec<u32>) -> Result<(Vec<u32>, Vec<u32>)> {
        let Some(f) = &self.filter else { return Ok((p, b)) };
        let mut kept = Kept::default();
        self.filter_each(f, probe, &p, &b, |r, _, mask| Ok(kept.add(&p, &b, r.start, mask)))?;
        Ok((kept.p, kept.b))
    }

    /// A filtered join of a type that emits its matched pairs (all but
    /// semi/anti): the kept rows of each joined batch go out as they are, and
    /// the kept pairs come back (empty for inner joins, which need none).
    fn emit_filtered(&self, probe: &RecordBatch, p: &[u32], b: &[u32], emit: Emit<'_>) -> Result<Kept> {
        let f = self.filter.as_ref().expect("a residual filter");
        let mut kept = Kept::default();
        let track = self.join_type != JoinType::Inner;
        self.filter_each(f, probe, p, b, |r, joined, mask| {
            if track {
                kept.add(p, b, r.start, mask);
            }
            if mask.true_count() > 0 {
                emit(self.finish_batch(filter_record_batch(&joined, mask)?)?)?;
            }
            Ok(())
        })?;
        Ok(kept)
    }

    /// The probe rows missing from `matched` (probe rows that have a kept
    /// pair, in any order, repeats allowed), once each, joined with NULLs.
    fn emit_unmatched(&self, probe: &RecordBatch, matched: &[u32], emit: Emit<'_>) -> Result<()> {
        let mut found = vec![false; probe.num_rows()];
        for &i in matched {
            found[i as usize] = true;
        }
        let p: Vec<u32> = (0..found.len() as u32).filter(|&i| !found[i as usize]).collect();
        if p.is_empty() {
            return Ok(());
        }
        let none: Vec<Option<u32>> = vec![None; p.len()];
        self.emit_pairs(probe, &p, &none, emit)
    }

    /// Semi (rows with a kept pair) or anti (rows without) join output.
    fn emit_semi_anti(&self, probe: &RecordBatch, matched: &[u32], emit: Emit<'_>) -> Result<()> {
        let mut found = vec![false; probe.num_rows()];
        for &i in matched {
            found[i as usize] = true;
        }
        let keep: Vec<bool> = if self.join_type == JoinType::Semi { found } else { found.into_iter().map(|f| !f).collect() };
        let mask = BooleanArray::from(keep);
        if mask.true_count() == 0 {
            return Ok(());
        }
        emit(self.finish_batch(filter_record_batch(probe, &mask)?)?)
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
                if self.filter.is_none() {
                    // inner and right joins (the other types are handled above)
                    if self.join_type == JoinType::Right {
                        self.mark(&b);
                    }
                    return self.emit_matched_pairs(&batch, &p, &b, emit);
                }
                match self.join_type {
                    JoinType::Inner => self.emit_filtered(&batch, &p, &b, emit).map(|_| ()),
                    JoinType::Right => {
                        let kept = self.emit_filtered(&batch, &p, &b, emit)?;
                        self.mark(&kept.b);
                        Ok(())
                    }
                    JoinType::Left | JoinType::Full => {
                        let kept = self.emit_filtered(&batch, &p, &b, emit)?;
                        self.mark(&kept.b);
                        self.emit_unmatched(&batch, &kept.p, emit)
                    }
                    JoinType::Semi | JoinType::Anti => {
                        let (p, _) = self.filter_pairs(&batch, p, b)?;
                        self.emit_semi_anti(&batch, &p, emit)
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

    fn source_column(&self, out: usize) -> Option<usize> {
        // an inner join emits a probe row's matches as it probes it, and nothing at the end
        if self.join_type != JoinType::Inner {
            return None;
        }
        let joined = self.order.as_ref().map_or(Some(out), |o| o.get(out).copied())?;
        (joined < self.joined_schema.fields().len() - self.table.batch.num_columns()).then_some(joined)
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
    /// the build side's bytes, held from the memory pool while the join lives
    pub memory: Option<memory::Reservation>,
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

impl NestedLoopJoin {
    /// The pairs of probe rows `probe_rows` with build rows `build_rows`
    /// (every probe row against every build row), as a joined batch.
    fn block(&self, probe: &RecordBatch, probe_rows: Range<usize>, build_rows: Range<usize>) -> Result<RecordBatch> {
        let (pr, bl) = (probe_rows.len(), build_rows.len());
        let pidx: UInt32Array = probe_rows.flat_map(|i| std::iter::repeat_n(i as u32, bl)).collect();
        let mut cols: Vec<ArrayRef> = probe.columns().iter().map(|c| take(c, &pidx, None)).collect::<Result<_, _>>()?;
        if pr == 1 {
            // one probe row: the build rows go out as they are
            cols.extend(self.build.slice(build_rows.start, bl).columns().iter().cloned());
        } else {
            let bidx: UInt32Array = (0..pr).flat_map(|_| build_rows.clone().map(|j| j as u32)).collect();
            for c in self.build.columns() {
                cols.push(take(c, &bidx, None)?);
            }
        }
        Ok(RecordBatch::try_new_with_options(
            self.joined_schema.clone(),
            cols,
            &RecordBatchOptions::new().with_row_count(Some(pr * bl)),
        )?)
    }

    /// Pair `probe_rows` with the build rows `build_rows`: keep what passes
    /// the filter, emit it (inner and left joins) and flag the probe rows
    /// that matched.
    fn run_block(
        &self,
        probe: &RecordBatch,
        probe_rows: Range<usize>,
        build_rows: Range<usize>,
        found: &mut [bool],
        emit: Emit<'_>,
    ) -> Result<()> {
        let bl = build_rows.len();
        let mut joined = self.block(probe, probe_rows.clone(), build_rows)?;
        match &self.filter {
            Some(f) => {
                let mask = f.evaluate_array(&joined)?;
                let mask = null_as_false(mask.as_boolean());
                for k in mask.values().set_indices() {
                    found[probe_rows.start + k / bl] = true;
                }
                joined = filter_record_batch(&joined, &mask)?;
            }
            None => found[probe_rows.clone()].fill(true),
        }
        if matches!(self.join_type, JoinType::Inner | JoinType::Left) && joined.num_rows() > 0 {
            emit(self.reorder(joined)?)?;
        }
        Ok(())
    }

    /// Fail with a memory-limit error when the build side alone is bigger than
    /// the limit: this join has no spill, so it would only run out of memory.
    /// (Not an exact reservation: the operator is built outside this module.)
    /// Hold the build side's memory: the join cannot spill, so a build side
    /// the pool has no room for is an error (not an out-of-memory crash).
    pub fn reserve_build(build: &RecordBatch) -> Result<memory::Reservation> {
        let need = batch_mem::batch_bytes(build);
        let mut held = memory::pool().reservation();
        if !held.try_grow(need) {
            return Err(WhError::Execution(format!(
                "memory limit exceeded: the build side of a nested loop join (a join without an equality condition) holds {need} bytes and the join cannot spill; raise the memory limit or add an equality condition"
            )));
        }
        Ok(held)
    }
}

impl Operator for NestedLoopJoin {
    fn execute(&self, batch: RecordBatch, emit: Emit<'_>) -> Result<()> {
        let n = batch.num_rows();
        let m = self.build.num_rows();
        let mut found = vec![false; n];
        let no_filter_set = self.filter.is_none() && matches!(self.join_type, JoinType::Semi | JoinType::Anti);
        if no_filter_set {
            // every probe row meets every build row: matched when there is one
            found.fill(m > 0);
        } else if m > 0 {
            // blocks of about OUT_CHUNK pairs: a slice of the build side, and as
            // many probe rows as fit with it (a big build side: one probe row)
            let slice = m.min(OUT_CHUNK);
            let rows = (OUT_CHUNK / slice).max(1);
            for start in (0..n).step_by(rows) {
                let probe_rows = start..(start + rows).min(n);
                for s in (0..m).step_by(slice) {
                    self.run_block(&batch, probe_rows.clone(), s..(s + slice).min(m), &mut found, emit)?;
                }
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
