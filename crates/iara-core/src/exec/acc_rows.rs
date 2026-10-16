//! Accumulators whose state has a fixed size per group (`count`, `sum`,
//! `min`/`max` of primitives, `avg`) keep it in rows of 8-byte words. A hash
//! aggregation lays the states of all its aggregates side by side in one row
//! per group ([`AccSet`]): an input row then touches one cache line however
//! many aggregates it feeds, where a vector per aggregate costs a cache miss
//! each once there are millions of groups. Elsewhere ([`OwnRows`]) such an
//! accumulator keeps rows of its own.
//!
//! A zeroed state is the empty one: no rows, a sum of nothing, no min yet.

use std::any::Any;
use std::marker::PhantomData;
use std::sync::Arc;

use arrow::array::*;
use arrow::buffer::{NullBuffer, ScalarBuffer};
use arrow::compute::{cast, filter};
use arrow::datatypes::*;

use crate::error::{Result, WhError};
use crate::exec::accumulators::{Accumulator, SumNative, ToF64, Wide, downcast, sum_overflow};
use crate::physical::expr::null_as_false;

/// One cache line.
#[repr(C, align(64))]
#[derive(Clone, Copy, Default)]
struct Line([u64; 8]);

/// Zeroed per-group states of `stride` words each.
pub struct Rows {
    stride: usize,
    lines: Vec<Line>,
    groups: usize,
}

impl Rows {
    pub fn new(stride: usize) -> Self {
        Self { stride, lines: vec![], groups: 0 }
    }

    /// Room for groups `0..n`.
    pub fn grow(&mut self, n: usize) {
        if n > self.groups {
            self.lines.resize((n * self.stride).div_ceil(8), Line::default());
            self.groups = n;
        }
    }

    pub fn groups(&self) -> usize {
        self.groups
    }

    #[inline(always)]
    fn word(&self, g: usize, at: usize) -> *const u64 {
        debug_assert!(g < self.groups);
        (self.lines.as_ptr() as *const u64).wrapping_add(g * self.stride + at)
    }

    #[inline(always)]
    fn get<T: Copy>(&self, g: usize, at: usize) -> T {
        // SAFETY: groups below `groups` have `stride` words of room
        unsafe { std::ptr::read_unaligned(self.word(g, at) as *const T) }
    }

    #[inline(always)]
    fn set<T: Copy>(&mut self, g: usize, at: usize, v: T) {
        // SAFETY: as above
        unsafe { std::ptr::write_unaligned(self.word(g, at) as *mut T, v) }
    }
}

/// An aggregate's fixed-size state at word `at` of each group's row.
pub trait RowAcc: Send + Sync {
    /// Words of one group's state.
    fn words(&self) -> usize;
    /// Fold `values` (one array per argument) into the groups given by `gids`.
    fn update(&self, rows: &mut Rows, at: usize, values: &[ArrayRef], gids: &[u32]) -> Result<()>;
    /// All rows belong to group 0.
    fn update_single(&self, rows: &mut Rows, at: usize, values: &[ArrayRef], num_rows: usize) -> Result<()> {
        self.update(rows, at, values, &vec![0u32; num_rows])
    }
    /// Merge groups `src[i]` of `other` into groups `dst[i]`.
    fn merge(&self, rows: &mut Rows, at: usize, other: &Rows, src: &[u32], dst: &[u32]) -> Result<()>;
    fn finish(&self, rows: &Rows, at: usize, num_groups: usize) -> Result<ArrayRef>;
}

fn nulls_of(a: &dyn Array) -> Option<&NullBuffer> {
    a.nulls().filter(|n| n.null_count() > 0)
}

/// `f(group, value)` for every row whose value is not null.
#[inline(always)]
fn each_valid<T: Copy>(gids: &[u32], vals: &[T], nulls: Option<&NullBuffer>, mut f: impl FnMut(usize, T)) {
    match nulls {
        None => {
            for (&g, &v) in gids.iter().zip(vals) {
                f(g as usize, v)
            }
        }
        Some(n) => {
            for (i, (&g, &v)) in gids.iter().zip(vals).enumerate() {
                if n.is_valid(i) {
                    f(g as usize, v)
                }
            }
        }
    }
}

/// Validity from a per-group flag; `None` when every group is valid.
fn flags(n: usize, valid: impl Fn(usize) -> bool) -> Option<NullBuffer> {
    let v: Vec<bool> = (0..n).map(valid).collect();
    (!v.iter().all(|&b| b)).then(|| NullBuffer::from(v))
}

// ---------------------------------------------------------------------------
// COUNT
// ---------------------------------------------------------------------------

/// `count(*)` (no argument) or `count(x)` (non-null values).
pub struct CountRow;

impl RowAcc for CountRow {
    fn words(&self) -> usize {
        1
    }
    fn update(&self, rows: &mut Rows, at: usize, values: &[ArrayRef], gids: &[u32]) -> Result<()> {
        match values.first().and_then(|v| v.logical_nulls()).filter(|n| n.null_count() > 0) {
            None => {
                for &g in gids {
                    let g = g as usize;
                    rows.set(g, at, rows.get::<i64>(g, at) + 1);
                }
            }
            Some(nulls) => {
                for (i, &g) in gids.iter().enumerate() {
                    let g = g as usize;
                    rows.set(g, at, rows.get::<i64>(g, at) + nulls.is_valid(i) as i64);
                }
            }
        }
        Ok(())
    }
    fn update_single(&self, rows: &mut Rows, at: usize, values: &[ArrayRef], num_rows: usize) -> Result<()> {
        let nulls = values.first().and_then(|v| v.logical_nulls()).map(|n| n.null_count()).unwrap_or(0);
        rows.set(0, at, rows.get::<i64>(0, at) + (num_rows - nulls) as i64);
        Ok(())
    }
    fn merge(&self, rows: &mut Rows, at: usize, other: &Rows, src: &[u32], dst: &[u32]) -> Result<()> {
        for (&s, &d) in src.iter().zip(dst) {
            if (s as usize) < other.groups {
                let d = d as usize;
                rows.set(d, at, rows.get::<i64>(d, at) + other.get::<i64>(s as usize, at));
            }
        }
        Ok(())
    }
    fn finish(&self, rows: &Rows, at: usize, n: usize) -> Result<ArrayRef> {
        Ok(Arc::new(Int64Array::from_iter_values((0..n).map(|g| rows.get::<i64>(g, at)))))
    }
}

// ---------------------------------------------------------------------------
// SUM: the wide sum, then a word that says whether a value was added
// ---------------------------------------------------------------------------

pub struct SumRow<I: ArrowPrimitiveType, O: ArrowPrimitiveType> {
    out_type: DataType,
    _p: PhantomData<fn() -> (I, O)>,
}

impl<I: ArrowPrimitiveType, O: ArrowPrimitiveType> SumRow<I, O>
where
    O::Native: SumNative,
{
    pub fn new(out_type: DataType) -> Self {
        Self { out_type, _p: PhantomData }
    }

    /// Words of the wide sum (the seen word follows it).
    const WIDE: usize = std::mem::size_of::<Wide<O>>().div_ceil(8);

    fn check(&self, over: bool) -> Result<()> {
        if over { Err(sum_overflow(&self.out_type)) } else { Ok(()) }
    }
}

impl<I, O> RowAcc for SumRow<I, O>
where
    I: ArrowPrimitiveType,
    O: ArrowPrimitiveType,
    I::Native: Into<O::Native>,
    O::Native: SumNative,
{
    fn words(&self) -> usize {
        Self::WIDE + 1
    }
    fn update(&self, rows: &mut Rows, at: usize, values: &[ArrayRef], gids: &[u32]) -> Result<()> {
        let arr = values[0].as_primitive::<I>();
        let (vals, nulls) = (arr.values(), nulls_of(arr));
        let mut over = false;
        let seen = at + Self::WIDE;
        each_valid(gids, vals, nulls, |g, v| {
            let w = <O::Native as SumNative>::add_wide(rows.get::<Wide<O>>(g, at), v.into().widen(), &mut over);
            rows.set(g, at, w);
            if rows.get::<u64>(g, seen) == 0 {
                rows.set(g, seen, 1u64);
            }
        });
        self.check(over)
    }
    fn update_single(&self, rows: &mut Rows, at: usize, values: &[ArrayRef], _num_rows: usize) -> Result<()> {
        let arr = values[0].as_primitive::<I>();
        let add = |a: Wide<O>, v: I::Native, over: &mut bool| <O::Native as SumNative>::add_wide(a, v.into().widen(), over);
        let zero = <O::Native as SumNative>::ZERO_WIDE;
        let mut acc = rows.get::<Wide<O>>(0, at);
        let mut over = false;
        let any = match nulls_of(arr) {
            None => {
                // 4 independent accumulators let the compiler vectorise float sums too
                let vals = arr.values();
                let mut lanes = [zero; 4];
                let chunks = vals.chunks_exact(4);
                let rem = chunks.remainder();
                for c in chunks {
                    for l in 0..4 {
                        lanes[l] = add(lanes[l], c[l], &mut over);
                    }
                }
                for &v in rem {
                    acc = add(acc, v, &mut over);
                }
                for l in lanes {
                    acc = <O::Native as SumNative>::add_wide(acc, l, &mut over);
                }
                !vals.is_empty()
            }
            Some(nulls) => {
                for i in nulls.valid_indices() {
                    acc = add(acc, arr.value(i), &mut over);
                }
                nulls.null_count() < nulls.len()
            }
        };
        self.check(over)?;
        rows.set(0, at, acc);
        if any {
            rows.set(0, at + Self::WIDE, 1u64);
        }
        Ok(())
    }
    fn merge(&self, rows: &mut Rows, at: usize, other: &Rows, src: &[u32], dst: &[u32]) -> Result<()> {
        let seen = at + Self::WIDE;
        let mut over = false;
        for (&s, &d) in src.iter().zip(dst) {
            let (s, d) = (s as usize, d as usize);
            if s < other.groups && other.get::<u64>(s, seen) != 0 {
                let w = <O::Native as SumNative>::add_wide(rows.get(d, at), other.get(s, at), &mut over);
                rows.set::<Wide<O>>(d, at, w);
                rows.set(d, seen, 1u64);
            }
        }
        self.check(over)
    }
    fn finish(&self, rows: &Rows, at: usize, n: usize) -> Result<ArrayRef> {
        let seen = |g: usize| rows.get::<u64>(g, at + Self::WIDE) != 0;
        let sums = (0..n)
            .map(|g| {
                if !seen(g) {
                    return Ok(O::Native::default());
                }
                <O::Native as SumNative>::narrow(rows.get(g, at)).ok_or_else(|| sum_overflow(&self.out_type))
            })
            .collect::<Result<Vec<O::Native>>>()?;
        Ok(Arc::new(PrimitiveArray::<O>::new(ScalarBuffer::from(sums), flags(n, seen)).with_data_type(self.out_type.clone())))
    }
}

// ---------------------------------------------------------------------------
// MIN / MAX (primitive): the value, then a word that says whether there is one
// ---------------------------------------------------------------------------

pub struct MinMaxRow<T: ArrowPrimitiveType, const MIN: bool> {
    dt: DataType,
    _p: PhantomData<fn() -> T>,
}

impl<T: ArrowPrimitiveType, const MIN: bool> MinMaxRow<T, MIN> {
    pub fn new(dt: DataType) -> Self {
        Self { dt, _p: PhantomData }
    }
    const VALUE: usize = std::mem::size_of::<T::Native>().div_ceil(8);
    #[inline(always)]
    fn better(v: T::Native, cur: T::Native) -> bool {
        if MIN { v.is_lt(cur) } else { v.is_gt(cur) }
    }
}

impl<T: ArrowPrimitiveType, const MIN: bool> RowAcc for MinMaxRow<T, MIN> {
    fn words(&self) -> usize {
        Self::VALUE + 1
    }
    fn update(&self, rows: &mut Rows, at: usize, values: &[ArrayRef], gids: &[u32]) -> Result<()> {
        let arr = values[0].as_primitive::<T>();
        let nulls = nulls_of(arr);
        let seen = at + Self::VALUE;
        each_valid(gids, arr.values(), nulls, |g, v| {
            if rows.get::<u64>(g, seen) == 0 || Self::better(v, rows.get(g, at)) {
                rows.set(g, at, v);
                rows.set(g, seen, 1u64);
            }
        });
        Ok(())
    }
    fn merge(&self, rows: &mut Rows, at: usize, other: &Rows, src: &[u32], dst: &[u32]) -> Result<()> {
        let seen = at + Self::VALUE;
        for (&s, &d) in src.iter().zip(dst) {
            let (s, d) = (s as usize, d as usize);
            if s < other.groups && other.get::<u64>(s, seen) != 0 {
                let v: T::Native = other.get(s, at);
                if rows.get::<u64>(d, seen) == 0 || Self::better(v, rows.get(d, at)) {
                    rows.set(d, at, v);
                    rows.set(d, seen, 1u64);
                }
            }
        }
        Ok(())
    }
    fn finish(&self, rows: &Rows, at: usize, n: usize) -> Result<ArrayRef> {
        let seen = |g: usize| rows.get::<u64>(g, at + Self::VALUE) != 0;
        let vals: Vec<T::Native> = (0..n).map(|g| if seen(g) { rows.get(g, at) } else { T::Native::default() }).collect();
        Ok(Arc::new(PrimitiveArray::<T>::new(ScalarBuffer::from(vals), flags(n, seen)).with_data_type(self.dt.clone())))
    }
}

// ---------------------------------------------------------------------------
// AVG: [f64 sum, count], or for decimals [i128 sum, count] divided at the end
// ---------------------------------------------------------------------------

/// The average over an input of primitive type `I`, widened to f64 per
/// element (no converted copy of each batch). `MeanRow<Float64Type>` also
/// serves the types without a direct impl: their batches are cast to Float64.
pub struct MeanRow<I: ArrowPrimitiveType>(PhantomData<fn() -> I>);

impl<I: ArrowPrimitiveType> MeanRow<I> {
    pub fn new() -> Self {
        Self(PhantomData)
    }
    fn input(value: &ArrayRef) -> Result<ArrayRef> {
        if value.data_type() == &I::DATA_TYPE { Ok(value.clone()) } else { Ok(cast(value, &I::DATA_TYPE)?) }
    }
}

impl<I> RowAcc for MeanRow<I>
where
    I: ArrowPrimitiveType,
    I::Native: ToF64,
{
    fn words(&self) -> usize {
        2
    }
    fn update(&self, rows: &mut Rows, at: usize, values: &[ArrayRef], gids: &[u32]) -> Result<()> {
        let a = Self::input(&values[0])?;
        let a = a.as_primitive::<I>();
        let nulls = nulls_of(a);
        each_valid(gids, a.values(), nulls, |g, v| {
            rows.set(g, at, rows.get::<f64>(g, at) + v.to_f64());
            rows.set(g, at + 1, rows.get::<i64>(g, at + 1) + 1);
        });
        Ok(())
    }
    fn update_single(&self, rows: &mut Rows, at: usize, values: &[ArrayRef], _num_rows: usize) -> Result<()> {
        let a = Self::input(&values[0])?;
        let a = a.as_primitive::<I>();
        let valid = a.len() - a.null_count();
        let s = if a.null_count() == 0 {
            let mut lanes = [0.0f64; 4];
            let chunks = a.values().chunks_exact(4);
            let rem: f64 = chunks.remainder().iter().map(|v| v.to_f64()).sum();
            for c in chunks {
                for l in 0..4 {
                    lanes[l] += c[l].to_f64();
                }
            }
            lanes.iter().sum::<f64>() + rem
        } else {
            a.iter().flatten().map(|v| v.to_f64()).sum()
        };
        rows.set(0, at, rows.get::<f64>(0, at) + s);
        rows.set(0, at + 1, rows.get::<i64>(0, at + 1) + valid as i64);
        Ok(())
    }
    fn merge(&self, rows: &mut Rows, at: usize, other: &Rows, src: &[u32], dst: &[u32]) -> Result<()> {
        for (&s, &d) in src.iter().zip(dst) {
            let (s, d) = (s as usize, d as usize);
            if s < other.groups {
                rows.set(d, at, rows.get::<f64>(d, at) + other.get::<f64>(s, at));
                rows.set(d, at + 1, rows.get::<i64>(d, at + 1) + other.get::<i64>(s, at + 1));
            }
        }
        Ok(())
    }
    fn finish(&self, rows: &Rows, at: usize, n: usize) -> Result<ArrayRef> {
        let out: Float64Array = (0..n)
            .map(|g| {
                let c = rows.get::<i64>(g, at + 1);
                (c > 0).then(|| rows.get::<f64>(g, at) / c as f64)
            })
            .collect();
        Ok(Arc::new(out))
    }
}

/// `avg` over decimals: the sum is kept exactly as an i128 (no per-row
/// conversion to f64) and divided once per group at the end.
pub struct DecimalMeanRow {
    scale: i8,
}

impl DecimalMeanRow {
    pub fn new(scale: i8) -> Self {
        Self { scale }
    }
}

fn decimal_mean_overflow() -> WhError {
    WhError::Execution("decimal overflow in avg(...): cast to DOUBLE".into())
}

impl RowAcc for DecimalMeanRow {
    fn words(&self) -> usize {
        3
    }
    fn update(&self, rows: &mut Rows, at: usize, values: &[ArrayRef], gids: &[u32]) -> Result<()> {
        let a = values[0].as_primitive::<Decimal128Type>();
        let nulls = nulls_of(a);
        let mut over = false;
        each_valid(gids, a.values(), nulls, |g, v| {
            let (r, o) = rows.get::<i128>(g, at).overflowing_add(v);
            over |= o;
            rows.set(g, at, r);
            rows.set(g, at + 2, rows.get::<i64>(g, at + 2) + 1);
        });
        if over { Err(decimal_mean_overflow()) } else { Ok(()) }
    }
    fn update_single(&self, rows: &mut Rows, at: usize, values: &[ArrayRef], _num_rows: usize) -> Result<()> {
        let a = values[0].as_primitive::<Decimal128Type>();
        let mut over = false;
        let mut lanes = [0i128; 4];
        let mut add = |lane: usize, v: i128| {
            let (r, o) = lanes[lane].overflowing_add(v);
            lanes[lane] = r;
            over |= o;
        };
        let valid = match nulls_of(a) {
            None => {
                let chunks = a.values().chunks_exact(4);
                let rem = chunks.remainder();
                for c in chunks {
                    for (l, &v) in c.iter().enumerate() {
                        add(l, v);
                    }
                }
                for &v in rem {
                    add(0, v);
                }
                a.len()
            }
            Some(nulls) => {
                for i in nulls.valid_indices() {
                    add(0, a.value(i));
                }
                nulls.len() - nulls.null_count()
            }
        };
        let mut sum = rows.get::<i128>(0, at);
        for l in lanes {
            let (r, o) = sum.overflowing_add(l);
            sum = r;
            over |= o;
        }
        rows.set(0, at, sum);
        rows.set(0, at + 2, rows.get::<i64>(0, at + 2) + valid as i64);
        if over { Err(decimal_mean_overflow()) } else { Ok(()) }
    }
    fn merge(&self, rows: &mut Rows, at: usize, other: &Rows, src: &[u32], dst: &[u32]) -> Result<()> {
        let mut over = false;
        for (&s, &d) in src.iter().zip(dst) {
            let (s, d) = (s as usize, d as usize);
            if s < other.groups {
                let (r, o) = rows.get::<i128>(d, at).overflowing_add(other.get(s, at));
                over |= o;
                rows.set(d, at, r);
                rows.set(d, at + 2, rows.get::<i64>(d, at + 2) + other.get::<i64>(s, at + 2));
            }
        }
        if over { Err(decimal_mean_overflow()) } else { Ok(()) }
    }
    fn finish(&self, rows: &Rows, at: usize, n: usize) -> Result<ArrayRef> {
        let unit = 10f64.powi(self.scale as i32);
        let out: Float64Array = (0..n)
            .map(|g| {
                let c = rows.get::<i64>(g, at + 2);
                (c > 0).then(|| rows.get::<i128>(g, at) as f64 / unit / c as f64)
            })
            .collect();
        Ok(Arc::new(out))
    }
}

// ---------------------------------------------------------------------------
// an accumulator on rows of its own
// ---------------------------------------------------------------------------

pub struct OwnRows {
    acc: Box<dyn RowAcc>,
    rows: Rows,
}

impl OwnRows {
    pub fn new(acc: Box<dyn RowAcc>) -> Self {
        let rows = Rows::new(acc.words());
        Self { acc, rows }
    }
}

impl Accumulator for OwnRows {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.rows.grow(num_groups);
        self.acc.update(&mut self.rows, 0, values, gids)
    }
    fn update_single(&mut self, values: &[ArrayRef], num_rows: usize) -> Result<()> {
        self.rows.grow(1);
        self.acc.update_single(&mut self.rows, 0, values, num_rows)
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<OwnRows>(other)?;
        self.rows.grow(num_groups);
        self.acc.merge(&mut self.rows, 0, &o.rows, src, dst)
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        self.rows.grow(num_groups);
        self.acc.finish(&self.rows, 0, num_groups)
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

// ---------------------------------------------------------------------------
// the accumulators of a hash aggregation
// ---------------------------------------------------------------------------

/// One aggregate of an [`AccSet`].
pub enum AccPart {
    /// state in the shared rows
    Row(Box<dyn RowAcc>),
    /// state of its own
    Own(Box<dyn Accumulator>),
}

enum Slot {
    Row { acc: Box<dyn RowAcc>, at: usize },
    Own(Box<dyn Accumulator>),
}

/// The aggregates of a group table, in output order.
pub struct AccSet {
    slots: Vec<Slot>,
    rows: Rows,
}

/// Evaluated arguments of an aggregate and its `FILTER` mask.
pub type AccInput = (Vec<ArrayRef>, Option<ArrayRef>);

impl AccSet {
    pub fn new(parts: Vec<AccPart>) -> Self {
        let mut at = 0;
        let mut slots = Vec::with_capacity(parts.len());
        for p in parts {
            slots.push(match p {
                AccPart::Row(acc) => {
                    let words = acc.words();
                    at += words;
                    Slot::Row { acc, at: at - words }
                }
                AccPart::Own(acc) => Slot::Own(acc),
            });
        }
        // a row never straddles cache lines
        let stride = if at <= 8 { at.next_power_of_two() } else { at.div_ceil(8) * 8 };
        Self { slots, rows: Rows::new(stride.max(1)) }
    }

    /// Fold evaluated rows (with group ids) in; a `FILTER` keeps the rows it holds for.
    pub fn update(&mut self, inputs: &[AccInput], gids: &[u32], num_groups: usize) -> Result<()> {
        self.rows.grow(num_groups);
        for (slot, (args, f)) in self.slots.iter_mut().zip(inputs) {
            let filtered;
            let (vals, g): (&[ArrayRef], &[u32]) = match f {
                None => (args, gids),
                Some(mask) => {
                    let mask = null_as_false(mask.as_boolean());
                    let vals = args.iter().map(|v| filter(v, &mask)).collect::<Result<Vec<_>, _>>()?;
                    let g: Vec<u32> = gids.iter().zip(mask.values().iter()).filter_map(|(g, m)| m.then_some(*g)).collect();
                    filtered = (vals, g);
                    (&filtered.0, &filtered.1)
                }
            };
            match slot {
                Slot::Row { acc, at } => acc.update(&mut self.rows, *at, vals, g)?,
                Slot::Own(acc) => acc.update(vals, g, num_groups)?,
            }
        }
        Ok(())
    }

    /// Every row in group 0 (aggregation without keys).
    pub fn update_single(&mut self, inputs: &[AccInput], num_rows: usize) -> Result<()> {
        self.rows.grow(1);
        for (slot, (args, f)) in self.slots.iter_mut().zip(inputs) {
            let filtered;
            let (vals, n): (&[ArrayRef], usize) = match f {
                None => (args, num_rows),
                Some(mask) => {
                    let mask = null_as_false(mask.as_boolean());
                    filtered = args.iter().map(|v| filter(v, &mask)).collect::<Result<Vec<_>, _>>()?;
                    (&filtered, mask.true_count())
                }
            };
            match slot {
                Slot::Row { acc, at } => acc.update_single(&mut self.rows, *at, vals, n)?,
                Slot::Own(acc) => acc.update_single(vals, n)?,
            }
        }
        Ok(())
    }

    /// Merge groups `src[i]` of `other` (built from the same aggregates) into groups `dst[i]`.
    pub fn merge(&mut self, other: &AccSet, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        self.rows.grow(num_groups);
        for (slot, theirs) in self.slots.iter_mut().zip(&other.slots) {
            match (slot, theirs) {
                (Slot::Row { acc, at }, Slot::Row { .. }) => acc.merge(&mut self.rows, *at, &other.rows, src, dst)?,
                (Slot::Own(acc), Slot::Own(o)) => acc.merge(o.as_ref(), src, dst, num_groups)?,
                _ => return Err(WhError::Execution("accumulator type mismatch during merge".into())),
            }
        }
        Ok(())
    }

    pub fn finish(&mut self, num_groups: usize) -> Result<Vec<ArrayRef>> {
        self.rows.grow(num_groups);
        let rows = &self.rows;
        self.slots
            .iter_mut()
            .map(|slot| match slot {
                Slot::Row { acc, at } => acc.finish(rows, *at, num_groups),
                Slot::Own(acc) => acc.finish(num_groups),
            })
            .collect()
    }

    /// Bytes held beyond a fixed amount per group (see [`Accumulator::state_bytes`]).
    pub fn state_bytes(&self) -> usize {
        self.slots
            .iter()
            .map(|s| match s {
                Slot::Own(acc) => acc.state_bytes(),
                Slot::Row { .. } => 0,
            })
            .sum()
    }
}

#[cfg(test)]
mod tests;
