//! Vectorised group accumulators. State is stored column-wise per group id
//! (`Vec<T>` indexed by group), so updates are tight loops over
//! `(group_id, value)` pairs without per-row dynamic dispatch.

use std::any::Any;
use std::marker::PhantomData;
use std::sync::Arc;

use arrow::array::*;
use arrow::buffer::{NullBuffer, ScalarBuffer};
use arrow::compute::{cast, interleave};
use arrow::datatypes::*;
use arrow::row::{RowConverter, SortField};

use crate::error::{Result, WhError};
use crate::expr::AggFunc;

use super::acc_misc::*;
use super::acc_quantile::{QuantileAcc, QuantileMode};
use super::acc_stats::PairStatAcc;

pub trait Accumulator: Send + Sync {
    /// Fold `values` (one array per argument) into the groups given by `gids`.
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()>;
    /// All rows belong to group 0.
    fn update_single(&mut self, values: &[ArrayRef], num_rows: usize) -> Result<()> {
        let gids = vec![0u32; num_rows];
        self.update(values, &gids, 1)
    }
    /// Merge groups `src[i]` of `other` into groups `dst[i]` of `self`.
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()>;
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef>;
    /// Bytes the state holds beyond a fixed amount per group (accumulators
    /// that keep rows, like `array_agg`): the aggregation counts them against
    /// the memory limit.
    fn state_bytes(&self) -> usize {
        0
    }
    fn as_any(&self) -> &dyn Any;
}

pub(crate) fn downcast<'a, T: 'static>(other: &'a dyn Accumulator) -> Result<&'a T> {
    other
        .as_any()
        .downcast_ref::<T>()
        .ok_or_else(|| WhError::Execution("accumulator type mismatch during merge".into()))
}

fn valid_mask(seen: &Option<Vec<bool>>, n: usize) -> Option<NullBuffer> {
    seen.as_ref().map(|s| {
        let mut s = s.clone();
        s.resize(n, false);
        NullBuffer::from(s)
    })
}

// ---------------------------------------------------------------------------
// COUNT
// ---------------------------------------------------------------------------

pub struct CountAcc {
    counts: Vec<i64>,
}

impl Accumulator for CountAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.counts.resize(num_groups, 0);
        let c = &mut self.counts;
        match values.first().and_then(|v| v.logical_nulls()).filter(|n| n.null_count() > 0) {
            None => {
                for &g in gids {
                    // SAFETY: group ids are < num_groups
                    unsafe { *c.get_unchecked_mut(g as usize) += 1 };
                }
            }
            Some(nulls) => {
                for (i, &g) in gids.iter().enumerate() {
                    c[g as usize] += nulls.is_valid(i) as i64;
                }
            }
        }
        Ok(())
    }
    fn update_single(&mut self, values: &[ArrayRef], num_rows: usize) -> Result<()> {
        self.counts.resize(1, 0);
        let nulls = values.first().and_then(|v| v.logical_nulls()).map(|n| n.null_count()).unwrap_or(0);
        self.counts[0] += (num_rows - nulls) as i64;
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<CountAcc>(other)?;
        self.counts.resize(num_groups, 0);
        for (&s, &d) in src.iter().zip(dst) {
            self.counts[d as usize] += o.counts.get(s as usize).copied().unwrap_or(0);
        }
        Ok(())
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        self.counts.resize(num_groups, 0);
        Ok(Arc::new(Int64Array::from(std::mem::take(&mut self.counts))))
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

// ---------------------------------------------------------------------------
// SUM
// ---------------------------------------------------------------------------

/// How a sum is kept. Integer sums are held in a wider type, so the order
/// the rows (and the partial sums of the threads) arrive in cannot cause an
/// overflow: the total either fits the output type or is an error.
pub trait SumNative: ArrowNativeTypeOp {
    type Wide: Copy + Send + Sync + 'static;
    const ZERO_WIDE: Self::Wide;
    fn widen(self) -> Self::Wide;
    /// `a + b`; sets `over` when the wide type itself overflows (decimals).
    fn add_wide(a: Self::Wide, b: Self::Wide, over: &mut bool) -> Self::Wide;
    /// The sum as the output type; `None` when it does not fit.
    fn narrow(w: Self::Wide) -> Option<Self>;
}

macro_rules! int_sum_native {
    ($t:ty, $wide:ty) => {
        impl SumNative for $t {
            type Wide = $wide;
            const ZERO_WIDE: $wide = 0;
            #[inline(always)]
            fn widen(self) -> $wide {
                self as $wide
            }
            // 2^64 rows of 2^63 would be needed to overflow the wide type
            #[inline(always)]
            fn add_wide(a: $wide, b: $wide, _over: &mut bool) -> $wide {
                a.wrapping_add(b)
            }
            #[inline(always)]
            fn narrow(w: $wide) -> Option<$t> {
                <$t>::try_from(w).ok()
            }
        }
    };
}
int_sum_native!(i64, i128);
int_sum_native!(u64, u128);

/// Decimals have no wider type: overflow of the i128 is detected as it happens.
impl SumNative for i128 {
    type Wide = i128;
    const ZERO_WIDE: i128 = 0;
    #[inline(always)]
    fn widen(self) -> i128 {
        self
    }
    #[inline(always)]
    fn add_wide(a: i128, b: i128, over: &mut bool) -> i128 {
        let (r, o) = a.overflowing_add(b);
        *over |= o;
        r
    }
    #[inline(always)]
    fn narrow(w: i128) -> Option<i128> {
        Some(w)
    }
}

impl SumNative for f64 {
    type Wide = f64;
    const ZERO_WIDE: f64 = 0.0;
    #[inline(always)]
    fn widen(self) -> f64 {
        self
    }
    #[inline(always)]
    fn add_wide(a: f64, b: f64, _over: &mut bool) -> f64 {
        a + b
    }
    #[inline(always)]
    fn narrow(w: f64) -> Option<f64> {
        Some(w)
    }
}

type Wide<O> = <<O as ArrowPrimitiveType>::Native as SumNative>::Wide;

/// The error of a sum that does not fit its type.
fn sum_overflow(out: &DataType) -> WhError {
    let kind = if matches!(out, DataType::Decimal128(..)) { "decimal" } else { "integer" };
    WhError::Execution(format!("{kind} overflow in sum(...): cast to DOUBLE or DECIMAL"))
}

pub struct SumAcc<I: ArrowPrimitiveType, O: ArrowPrimitiveType>
where
    O::Native: SumNative,
{
    sums: Vec<Wide<O>>,
    seen: Option<Vec<bool>>,
    out_type: DataType,
    _p: PhantomData<fn() -> I>,
}

impl<I: ArrowPrimitiveType, O: ArrowPrimitiveType> SumAcc<I, O>
where
    O::Native: SumNative,
{
    pub fn new(out_type: DataType, track_seen: bool) -> Self {
        Self { sums: vec![], seen: if track_seen { Some(vec![]) } else { None }, out_type, _p: PhantomData }
    }

    fn zero() -> Wide<O> {
        <O::Native as SumNative>::ZERO_WIDE
    }

    #[inline(always)]
    fn add(a: Wide<O>, v: I::Native, over: &mut bool) -> Wide<O>
    where
        I::Native: Into<O::Native>,
    {
        <O::Native as SumNative>::add_wide(a, v.into().widen(), over)
    }

    fn check(&self, over: bool) -> Result<()> {
        if over { Err(sum_overflow(&self.out_type)) } else { Ok(()) }
    }
}

impl<I, O> Accumulator for SumAcc<I, O>
where
    I: ArrowPrimitiveType,
    O: ArrowPrimitiveType,
    I::Native: Into<O::Native>,
    O::Native: SumNative,
{
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        let prev = self.sums.len();
        let mut over = false;
        self.sums.resize(num_groups, Self::zero());
        let arr = values[0].as_primitive::<I>();
        let vals = arr.values();
        match arr.nulls().filter(|n| n.null_count() > 0) {
            None => {
                let s = &mut self.sums;
                for (&g, &v) in gids.iter().zip(vals.iter()) {
                    // SAFETY: group ids are < num_groups
                    let slot = unsafe { s.get_unchecked_mut(g as usize) };
                    *slot = Self::add(*slot, v, &mut over);
                }
                if let Some(seen) = &mut self.seen {
                    seen.resize(num_groups, false);
                    for &g in gids {
                        seen[g as usize] = true;
                    }
                }
            }
            Some(nulls) => {
                let seen = self.seen.get_or_insert_with(|| vec![true; prev]);
                seen.resize(num_groups, false);
                for (i, (&g, &v)) in gids.iter().zip(vals.iter()).enumerate() {
                    if nulls.is_valid(i) {
                        let slot = &mut self.sums[g as usize];
                        *slot = Self::add(*slot, v, &mut over);
                        seen[g as usize] = true;
                    }
                }
            }
        }
        self.check(over)
    }

    fn update_single(&mut self, values: &[ArrayRef], _num_rows: usize) -> Result<()> {
        if self.sums.is_empty() {
            self.sums.push(Self::zero());
            self.seen = Some(vec![false]);
        }
        let arr = values[0].as_primitive::<I>();
        let mut acc = self.sums[0];
        let mut any = false;
        let mut over = false;
        match arr.nulls().filter(|n| n.null_count() > 0) {
            None => {
                // 4 independent accumulators let the compiler vectorise float sums too
                let vals = arr.values();
                let mut lanes = [Self::zero(); 4];
                let chunks = vals.chunks_exact(4);
                let rem = chunks.remainder();
                for c in chunks {
                    for l in 0..4 {
                        lanes[l] = Self::add(lanes[l], c[l], &mut over);
                    }
                }
                for &v in rem {
                    acc = Self::add(acc, v, &mut over);
                }
                for l in lanes {
                    acc = <O::Native as SumNative>::add_wide(acc, l, &mut over);
                }
                any = !vals.is_empty();
            }
            Some(nulls) => {
                for (i, &v) in arr.values().iter().enumerate() {
                    if nulls.is_valid(i) {
                        acc = Self::add(acc, v, &mut over);
                        any = true;
                    }
                }
            }
        }
        self.check(over)?;
        self.sums[0] = acc;
        if any {
            self.seen.as_mut().unwrap()[0] = true;
        }
        Ok(())
    }

    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<Self>(other)?;
        let prev = self.sums.len();
        let mut over = false;
        self.sums.resize(num_groups, Self::zero());
        if o.seen.is_some() || self.seen.is_some() {
            let seen = self.seen.get_or_insert_with(|| vec![true; prev]);
            seen.resize(num_groups, false);
        }
        for (&s, &d) in src.iter().zip(dst) {
            let (s, d) = (s as usize, d as usize);
            let v = o.sums.get(s).copied().unwrap_or(Self::zero());
            self.sums[d] = <O::Native as SumNative>::add_wide(self.sums[d], v, &mut over);
            if let Some(seen) = &mut self.seen {
                let os = match &o.seen {
                    Some(x) => x.get(s).copied().unwrap_or(false),
                    None => s < o.sums.len(),
                };
                seen[d] |= os;
            }
        }
        self.check(over)
    }

    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        // groups that never received a row (empty input) are NULL, not 0
        let touched = self.sums.len();
        self.sums.resize(num_groups, Self::zero());
        let mut nulls = valid_mask(&self.seen, num_groups);
        if self.seen.is_none() && touched < num_groups {
            nulls = Some(NullBuffer::from((0..num_groups).map(|g| g < touched).collect::<Vec<_>>()));
        }
        let wide = std::mem::take(&mut self.sums);
        let sums = wide
            .into_iter()
            .map(|w| <O::Native as SumNative>::narrow(w).ok_or_else(|| sum_overflow(&self.out_type)))
            .collect::<Result<Vec<O::Native>>>()?;
        Ok(Arc::new(PrimitiveArray::<O>::new(ScalarBuffer::from(sums), nulls).with_data_type(self.out_type.clone())))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

// ---------------------------------------------------------------------------
// MIN / MAX (primitive)
// ---------------------------------------------------------------------------

pub struct MinMaxAcc<T: ArrowPrimitiveType, const MIN: bool> {
    vals: Vec<T::Native>,
    seen: Vec<bool>,
    dt: DataType,
}

impl<T: ArrowPrimitiveType, const MIN: bool> MinMaxAcc<T, MIN> {
    pub fn new(dt: DataType) -> Self {
        Self { vals: vec![], seen: vec![], dt }
    }
    #[inline(always)]
    fn identity() -> T::Native {
        if MIN { T::Native::MAX_TOTAL_ORDER } else { T::Native::MIN_TOTAL_ORDER }
    }
    #[inline(always)]
    fn better(v: T::Native, cur: T::Native) -> bool {
        if MIN { v.is_lt(cur) } else { v.is_gt(cur) }
    }
}

impl<T: ArrowPrimitiveType, const MIN: bool> Accumulator for MinMaxAcc<T, MIN> {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.vals.resize(num_groups, Self::identity());
        self.seen.resize(num_groups, false);
        let arr = values[0].as_primitive::<T>();
        let nulls = arr.nulls().filter(|n| n.null_count() > 0);
        for (i, (&g, &v)) in gids.iter().zip(arr.values().iter()).enumerate() {
            if nulls.is_some_and(|n| n.is_null(i)) {
                continue;
            }
            let g = g as usize;
            if !self.seen[g] || Self::better(v, self.vals[g]) {
                self.vals[g] = v;
                self.seen[g] = true;
            }
        }
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<Self>(other)?;
        self.vals.resize(num_groups, Self::identity());
        self.seen.resize(num_groups, false);
        for (&s, &d) in src.iter().zip(dst) {
            let (s, d) = (s as usize, d as usize);
            if s < o.seen.len() && o.seen[s] && (!self.seen[d] || Self::better(o.vals[s], self.vals[d])) {
                self.vals[d] = o.vals[s];
                self.seen[d] = true;
            }
        }
        Ok(())
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        self.vals.resize(num_groups, Self::identity());
        self.seen.resize(num_groups, false);
        let nulls = NullBuffer::from(std::mem::take(&mut self.seen));
        Ok(Arc::new(
            PrimitiveArray::<T>::new(ScalarBuffer::from(std::mem::take(&mut self.vals)), Some(nulls))
                .with_data_type(self.dt.clone()),
        ))
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

// ---------------------------------------------------------------------------
// MIN / MAX of strings: direct byte comparisons (UTF-8 byte order == code point order)
// ---------------------------------------------------------------------------

pub struct MinMaxStrAcc {
    vals: Vec<Option<Box<[u8]>>>,
    min: bool,
    dt: DataType,
}

impl MinMaxStrAcc {
    pub fn new(dt: DataType, min: bool) -> Self {
        Self { vals: vec![], min, dt }
    }
    #[inline]
    fn offer(&mut self, g: usize, v: &[u8]) {
        let better = match &self.vals[g] {
            None => true,
            Some(cur) => {
                if self.min {
                    v < cur.as_ref()
                } else {
                    v > cur.as_ref()
                }
            }
        };
        if better {
            self.vals[g] = Some(v.into());
        }
    }
    fn run<'a>(&mut self, it: impl Iterator<Item = Option<&'a str>>, gids: &[u32]) {
        for (v, &g) in it.zip(gids) {
            if let Some(v) = v {
                self.offer(g as usize, v.as_bytes());
            }
        }
    }
}

impl Accumulator for MinMaxStrAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.vals.resize(num_groups, None);
        let a = &values[0];
        match a.data_type() {
            DataType::Utf8 => self.run(a.as_string::<i32>().iter(), gids),
            DataType::LargeUtf8 => self.run(a.as_string::<i64>().iter(), gids),
            DataType::Utf8View => self.run(a.as_string_view().iter(), gids),
            t => return Err(WhError::Execution(format!("string min/max on {t}"))),
        }
        Ok(())
    }
    fn update_single(&mut self, values: &[ArrayRef], _num_rows: usize) -> Result<()> {
        self.vals.resize(1, None);
        let a = &values[0];
        // find the best value of the batch first, copy it once
        let pick = |it: &mut dyn Iterator<Item = Option<&str>>, min: bool| -> Option<String> {
            let mut best: Option<&str> = None;
            for v in it.flatten() {
                best = Some(match best {
                    None => v,
                    Some(b) => {
                        if (min && v < b) || (!min && v > b) {
                            v
                        } else {
                            b
                        }
                    }
                });
            }
            best.map(|s| s.to_string())
        };
        let best = match a.data_type() {
            DataType::Utf8 => pick(&mut a.as_string::<i32>().iter(), self.min),
            DataType::LargeUtf8 => pick(&mut a.as_string::<i64>().iter(), self.min),
            DataType::Utf8View => pick(&mut a.as_string_view().iter(), self.min),
            t => return Err(WhError::Execution(format!("string min/max on {t}"))),
        };
        if let Some(b) = best {
            self.offer(0, b.as_bytes());
        }
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<Self>(other)?;
        self.vals.resize(num_groups, None);
        for (&s, &d) in src.iter().zip(dst) {
            if let Some(Some(v)) = o.vals.get(s as usize) {
                let v = v.clone();
                self.offer(d as usize, &v);
            }
        }
        Ok(())
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        self.vals.resize(num_groups, None);
        let arr: StringArray = self
            .vals
            .iter()
            .map(|v| v.as_ref().map(|b| std::str::from_utf8(b).unwrap_or("")))
            .collect();
        let arr: ArrayRef = Arc::new(arr);
        if arr.data_type() == &self.dt { Ok(arr) } else { Ok(cast(&arr, &self.dt)?) }
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

// ---------------------------------------------------------------------------
// MIN / MAX (strings, binary, booleans and anything orderable): row format
// ---------------------------------------------------------------------------

pub struct MinMaxRowAcc {
    conv: RowConverter,
    vals: Vec<Option<Box<[u8]>>>,
    min: bool,
    dt: DataType,
}

impl MinMaxRowAcc {
    pub fn try_new(dt: &DataType, min: bool) -> Result<Self> {
        // NULL elements inside lists and structs sort last (DuckDB), so max(s) can be {a: NULL, ..}
        let order = arrow::compute::SortOptions { descending: false, nulls_first: false };
        let conv = RowConverter::new(vec![SortField::new_with_options(dt.clone(), order)])?;
        Ok(Self { conv, vals: vec![], min, dt: dt.clone() })
    }
    fn offer(&mut self, g: usize, row: &[u8]) {
        let replace = match &self.vals[g] {
            None => true,
            Some(cur) => {
                if self.min {
                    row < cur.as_ref()
                } else {
                    row > cur.as_ref()
                }
            }
        };
        if replace {
            self.vals[g] = Some(row.into());
        }
    }
}

impl Accumulator for MinMaxRowAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.vals.resize(num_groups, None);
        let rows = self.conv.convert_columns(&values[..1])?;
        let nulls = values[0].logical_nulls();
        for (i, &g) in gids.iter().enumerate() {
            if nulls.as_ref().is_some_and(|n| n.is_null(i)) {
                continue;
            }
            self.offer(g as usize, rows.row(i).as_ref());
        }
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<Self>(other)?;
        self.vals.resize(num_groups, None);
        for (&s, &d) in src.iter().zip(dst) {
            if let Some(Some(v)) = o.vals.get(s as usize) {
                let v = v.clone();
                self.offer(d as usize, &v);
            }
        }
        Ok(())
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        self.vals.resize(num_groups, None);
        let parser = self.conv.parser();
        // groups without values: emit a placeholder row then null it out
        let present: Vec<usize> = (0..num_groups).filter(|&g| self.vals[g].is_some()).collect();
        let rows: Vec<_> = present.iter().map(|&g| parser.parse(self.vals[g].as_ref().unwrap())).collect();
        if present.is_empty() {
            return Ok(new_null_array(&self.dt, num_groups));
        }
        let decoded = self.conv.convert_rows(rows)?.remove(0);
        let mut idx: Vec<Option<u32>> = vec![None; num_groups];
        for (k, &g) in present.iter().enumerate() {
            idx[g] = Some(k as u32);
        }
        Ok(arrow::compute::take(&decoded, &UInt32Array::from(idx), None)?)
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

// ---------------------------------------------------------------------------
// AVG
// ---------------------------------------------------------------------------

/// A native value as the f64 an average adds (what casting the array to Float64 gives).
pub trait ToF64: Copy {
    fn to_f64(self) -> f64;
}

macro_rules! to_f64 {
    ($($t:ty),*) => {$(
        impl ToF64 for $t {
            #[inline(always)]
            fn to_f64(self) -> f64 {
                self as f64
            }
        }
    )*};
}
to_f64!(i8, i16, i32, i64, u8, u16, u32, u64, f32, f64);

/// The average over an input of primitive type `I`, widened to f64 per
/// element (no converted copy of each batch). `MeanAcc<Float64Type>` also
/// serves the types without a direct impl (decimals...): their batches are
/// cast to Float64 first.
pub struct MeanAcc<I: ArrowPrimitiveType> {
    sums: Vec<f64>,
    counts: Vec<i64>,
    _p: PhantomData<fn() -> I>,
}

impl<I: ArrowPrimitiveType> MeanAcc<I> {
    pub fn new() -> Self {
        Self { sums: vec![], counts: vec![], _p: PhantomData }
    }
}

pub(crate) fn as_f64(a: &ArrayRef) -> Result<ArrayRef> {
    if a.data_type() == &DataType::Float64 { Ok(a.clone()) } else { Ok(cast(a, &DataType::Float64)?) }
}

impl<I: ArrowPrimitiveType> MeanAcc<I>
where
    I::Native: ToF64,
{
    /// The input as an `I` array: a cast only for the Float64 catch-all (or a
    /// batch that does not have the type the plan promised).
    fn input(value: &ArrayRef) -> Result<ArrayRef> {
        if value.data_type() == &I::DATA_TYPE { Ok(value.clone()) } else { Ok(cast(value, &I::DATA_TYPE)?) }
    }
}

impl<I> Accumulator for MeanAcc<I>
where
    I: ArrowPrimitiveType,
    I::Native: ToF64,
{
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.sums.resize(num_groups, 0.0);
        self.counts.resize(num_groups, 0);
        let a = Self::input(&values[0])?;
        let a = a.as_primitive::<I>();
        match a.nulls().filter(|n| n.null_count() > 0) {
            None => {
                for (&g, &v) in gids.iter().zip(a.values().iter()) {
                    let g = g as usize;
                    // SAFETY: group ids are < num_groups
                    unsafe {
                        *self.sums.get_unchecked_mut(g) += v.to_f64();
                        *self.counts.get_unchecked_mut(g) += 1;
                    }
                }
            }
            Some(nulls) => {
                for (i, (&g, &v)) in gids.iter().zip(a.values().iter()).enumerate() {
                    if nulls.is_valid(i) {
                        self.sums[g as usize] += v.to_f64();
                        self.counts[g as usize] += 1;
                    }
                }
            }
        }
        Ok(())
    }
    fn update_single(&mut self, values: &[ArrayRef], _num_rows: usize) -> Result<()> {
        self.sums.resize(1, 0.0);
        self.counts.resize(1, 0);
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
        self.sums[0] += s;
        self.counts[0] += valid as i64;
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<Self>(other)?;
        self.sums.resize(num_groups, 0.0);
        self.counts.resize(num_groups, 0);
        for (&s, &d) in src.iter().zip(dst) {
            if (s as usize) < o.sums.len() {
                self.sums[d as usize] += o.sums[s as usize];
                self.counts[d as usize] += o.counts[s as usize];
            }
        }
        Ok(())
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        self.sums.resize(num_groups, 0.0);
        self.counts.resize(num_groups, 0);
        let out: Float64Array = self
            .sums
            .iter()
            .zip(&self.counts)
            .map(|(&s, &c)| if c > 0 { Some(s / c as f64) } else { None })
            .collect();
        Ok(Arc::new(out))
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

// ---------------------------------------------------------------------------
// VARIANCE / STDDEV (Welford, Chan merge)
// ---------------------------------------------------------------------------

pub struct VarAcc {
    n: Vec<f64>,
    mean: Vec<f64>,
    m2: Vec<f64>,
    ddof: f64,
    sqrt: bool,
}

impl VarAcc {
    pub fn new(ddof: f64, sqrt: bool) -> Self {
        Self { n: vec![], mean: vec![], m2: vec![], ddof, sqrt }
    }
    fn resize(&mut self, g: usize) {
        self.n.resize(g, 0.0);
        self.mean.resize(g, 0.0);
        self.m2.resize(g, 0.0);
    }
}

impl Accumulator for VarAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.resize(num_groups);
        let a = as_f64(&values[0])?;
        let a = a.as_primitive::<Float64Type>();
        for (i, &g) in gids.iter().enumerate() {
            if a.is_null(i) {
                continue;
            }
            let g = g as usize;
            let x = a.value(i);
            self.n[g] += 1.0;
            let delta = x - self.mean[g];
            self.mean[g] += delta / self.n[g];
            self.m2[g] += delta * (x - self.mean[g]);
        }
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<VarAcc>(other)?;
        self.resize(num_groups);
        for (&s, &d) in src.iter().zip(dst) {
            let (s, d) = (s as usize, d as usize);
            if s >= o.n.len() || o.n[s] == 0.0 {
                continue;
            }
            let (na, nb) = (self.n[d], o.n[s]);
            let n = na + nb;
            let delta = o.mean[s] - self.mean[d];
            self.mean[d] += delta * nb / n;
            self.m2[d] += o.m2[s] + delta * delta * na * nb / n;
            self.n[d] = n;
        }
        Ok(())
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        self.resize(num_groups);
        let out: Float64Array = (0..num_groups)
            .map(|g| {
                let denom = self.n[g] - self.ddof;
                if denom <= 0.0 {
                    None
                } else {
                    let v = self.m2[g] / denom;
                    Some(if self.sqrt { v.sqrt() } else { v })
                }
            })
            .collect();
        Ok(Arc::new(out))
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

// ---------------------------------------------------------------------------
// MEDIAN
// ---------------------------------------------------------------------------

pub struct MedianAcc {
    vals: Vec<Vec<f64>>,
}

impl Accumulator for MedianAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.vals.resize_with(num_groups, Vec::new);
        let a = as_f64(&values[0])?;
        let a = a.as_primitive::<Float64Type>();
        for (i, &g) in gids.iter().enumerate() {
            if a.is_valid(i) {
                self.vals[g as usize].push(a.value(i));
            }
        }
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<MedianAcc>(other)?;
        self.vals.resize_with(num_groups, Vec::new);
        for (&s, &d) in src.iter().zip(dst) {
            if let Some(v) = o.vals.get(s as usize) {
                self.vals[d as usize].extend_from_slice(v);
            }
        }
        Ok(())
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        self.vals.resize_with(num_groups, Vec::new);
        let out: Float64Array = self
            .vals
            .iter_mut()
            .map(|v| {
                if v.is_empty() {
                    return None;
                }
                v.sort_unstable_by(|a, b| a.total_cmp(b));
                let n = v.len();
                Some(if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 })
            })
            .collect();
        Ok(Arc::new(out))
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

// ---------------------------------------------------------------------------
// COUNT(DISTINCT)
// ---------------------------------------------------------------------------

pub use super::acc_distinct::CountDistinctAcc;

// ---------------------------------------------------------------------------
// FIRST / LAST (first/last non-null value seen per group)
// ---------------------------------------------------------------------------

pub struct FirstLastAcc {
    arrays: Vec<ArrayRef>,
    pos: Vec<Option<(usize, usize)>>,
    last: bool,
    dt: DataType,
}

impl FirstLastAcc {
    pub fn new(dt: DataType, last: bool) -> Self {
        Self { arrays: vec![], pos: vec![], last, dt }
    }
}

impl Accumulator for FirstLastAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.pos.resize(num_groups, None);
        let a = &values[0];
        let ai = self.arrays.len();
        let mut used = false;
        for (i, &g) in gids.iter().enumerate() {
            if a.is_null(i) {
                continue;
            }
            let slot = &mut self.pos[g as usize];
            if self.last || slot.is_none() {
                *slot = Some((ai, i));
                used = true;
            }
        }
        if used {
            self.arrays.push(a.clone());
        }
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<FirstLastAcc>(other)?;
        self.pos.resize(num_groups, None);
        let base = self.arrays.len();
        self.arrays.extend(o.arrays.iter().cloned());
        for (&s, &d) in src.iter().zip(dst) {
            if let Some(Some((a, r))) = o.pos.get(s as usize) {
                let slot = &mut self.pos[d as usize];
                if self.last || slot.is_none() {
                    *slot = Some((base + a, *r));
                }
            }
        }
        Ok(())
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        self.pos.resize(num_groups, None);
        let null = new_null_array(&self.dt, 1);
        let mut sources: Vec<&dyn Array> = self.arrays.iter().map(|a| a.as_ref()).collect();
        let null_idx = sources.len();
        sources.push(null.as_ref());
        let idx: Vec<(usize, usize)> = self.pos.iter().map(|p| p.unwrap_or((null_idx, 0))).collect();
        Ok(interleave(&sources, &idx)?)
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

// ---------------------------------------------------------------------------
// factory
// ---------------------------------------------------------------------------

pub fn create_accumulator(
    func: AggFunc,
    input: Option<&DataType>,
    distinct: bool,
    has_filter: bool,
) -> Result<Box<dyn Accumulator>> {
    use DataType::*;
    let dt = input.cloned().unwrap_or(Null);
    if distinct {
        return match func {
            AggFunc::Count => Ok(Box::new(CountDistinctAcc::try_new(&dt)?)),
            AggFunc::Min | AggFunc::Max => create_accumulator(func, input, false, has_filter),
            AggFunc::Sum => Ok(Box::new(SumDistinctAcc::try_new(&dt)?)),
            f => Err(WhError::NotSupported(format!("{}(DISTINCT ..) is not supported", f.name()))),
        };
    }
    macro_rules! sum {
        ($i:ty, $o:ty, $out:expr) => {
            Box::new(SumAcc::<$i, $o>::new($out, has_filter)) as Box<dyn Accumulator>
        };
    }
    macro_rules! minmax {
        ($t:ty) => {
            if func == AggFunc::Min {
                Box::new(MinMaxAcc::<$t, true>::new(dt.clone())) as Box<dyn Accumulator>
            } else {
                Box::new(MinMaxAcc::<$t, false>::new(dt.clone())) as Box<dyn Accumulator>
            }
        };
    }
    Ok(match func {
        AggFunc::Count => Box::new(CountAcc { counts: vec![] }),
        AggFunc::Sum => match &dt {
            Int8 => sum!(Int8Type, Int64Type, Int64),
            Int16 => sum!(Int16Type, Int64Type, Int64),
            Int32 => sum!(Int32Type, Int64Type, Int64),
            Int64 => sum!(Int64Type, Int64Type, Int64),
            UInt8 => sum!(UInt8Type, UInt64Type, UInt64),
            UInt16 => sum!(UInt16Type, UInt64Type, UInt64),
            UInt32 => sum!(UInt32Type, UInt64Type, UInt64),
            UInt64 => sum!(UInt64Type, UInt64Type, UInt64),
            Float32 => sum!(Float32Type, Float64Type, Float64),
            Float64 => sum!(Float64Type, Float64Type, Float64),
            Decimal128(_, s) => sum!(Decimal128Type, Decimal128Type, Decimal128(38, *s)),
            t => return Err(WhError::NotSupported(format!("sum over {t}"))),
        },
        AggFunc::Min | AggFunc::Max => match &dt {
            Int8 => minmax!(Int8Type),
            Int16 => minmax!(Int16Type),
            Int32 => minmax!(Int32Type),
            Int64 => minmax!(Int64Type),
            UInt8 => minmax!(UInt8Type),
            UInt16 => minmax!(UInt16Type),
            UInt32 => minmax!(UInt32Type),
            UInt64 => minmax!(UInt64Type),
            Float32 => minmax!(Float32Type),
            Float64 => minmax!(Float64Type),
            Date32 => minmax!(Date32Type),
            Date64 => minmax!(Date64Type),
            Timestamp(TimeUnit::Second, _) => minmax!(TimestampSecondType),
            Timestamp(TimeUnit::Millisecond, _) => minmax!(TimestampMillisecondType),
            Timestamp(TimeUnit::Microsecond, _) => minmax!(TimestampMicrosecondType),
            Timestamp(TimeUnit::Nanosecond, _) => minmax!(TimestampNanosecondType),
            Decimal128(_, _) => minmax!(Decimal128Type),
            Utf8 | LargeUtf8 | Utf8View => Box::new(MinMaxStrAcc::new(dt.clone(), func == AggFunc::Min)),
            t => Box::new(MinMaxRowAcc::try_new(t, func == AggFunc::Min)?),
        },
        AggFunc::Mean => match &dt {
            Int8 => Box::new(MeanAcc::<Int8Type>::new()),
            Int16 => Box::new(MeanAcc::<Int16Type>::new()),
            Int32 => Box::new(MeanAcc::<Int32Type>::new()),
            Int64 => Box::new(MeanAcc::<Int64Type>::new()),
            UInt8 => Box::new(MeanAcc::<UInt8Type>::new()),
            UInt16 => Box::new(MeanAcc::<UInt16Type>::new()),
            UInt32 => Box::new(MeanAcc::<UInt32Type>::new()),
            UInt64 => Box::new(MeanAcc::<UInt64Type>::new()),
            Float32 => Box::new(MeanAcc::<Float32Type>::new()),
            Decimal128(_, s) => Box::new(super::acc_decimal::DecimalMeanAcc::new(*s)),
            _ => Box::new(MeanAcc::<Float64Type>::new()),
        },
        AggFunc::Median => Box::new(MedianAcc { vals: vec![] }),
        AggFunc::Std => Box::new(VarAcc::new(1.0, true)),
        AggFunc::StdPop => Box::new(VarAcc::new(0.0, true)),
        AggFunc::Var => Box::new(VarAcc::new(1.0, false)),
        AggFunc::VarPop => Box::new(VarAcc::new(0.0, false)),
        AggFunc::First => Box::new(FirstLastAcc::new(dt, false)),
        AggFunc::Last => Box::new(FirstLastAcc::new(dt, true)),
        AggFunc::QuantileCont => Box::new(QuantileAcc::try_new(QuantileMode::Cont, &dt, Float64)?),
        AggFunc::QuantileDisc => Box::new(QuantileAcc::try_new(QuantileMode::Disc, &dt, dt.clone())?),
        // DuckDB's t-digest interpolates; integers are truncated back to their type
        AggFunc::ApproxQuantile => {
            let out = if dt.is_floating() { Float64 } else { dt.clone() };
            Box::new(QuantileAcc::try_new(QuantileMode::Cont, &dt, out)?)
        }
        AggFunc::CountIf => Box::new(CountIfAcc::new()),
        AggFunc::BoolAnd => Box::new(BoolAcc::<true>::new()),
        AggFunc::BoolOr => Box::new(BoolAcc::<false>::new()),
        AggFunc::MaxBy => Box::new(ArgExtremeAcc::new(dt, true)),
        AggFunc::MinBy => Box::new(ArgExtremeAcc::new(dt, false)),
        AggFunc::Product => Box::new(ProductAcc::new()),
        AggFunc::Corr | AggFunc::CovarSamp | AggFunc::CovarPop | AggFunc::RegrSlope => Box::new(PairStatAcc::new(func)),
        AggFunc::ArrayAgg | AggFunc::CollectList | AggFunc::CollectSet => {
            return Err(WhError::Execution(format!("{} is built from its aggregate expression", func.name())));
        }
    })
}

#[cfg(test)]
mod sum_tests;

#[cfg(test)]
mod mean_tests;
