//! Vectorised group accumulators. State is stored column-wise per group id
//! (`Vec<T>` indexed by group), so updates are tight loops over
//! `(group_id, value)` pairs without per-row dynamic dispatch.

use std::any::Any;
use std::sync::Arc;

use arrow::array::*;
use arrow::compute::{cast, interleave};
use arrow::datatypes::*;
use arrow::row::{RowConverter, SortField};

use crate::error::{Result, WhError};
use crate::expr::AggFunc;

use super::acc_misc::*;
use super::acc_rows::{CountRow, DecimalMeanRow, MeanRow, MinMaxRow, OwnRows, RowAcc, SumRow};
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

pub(crate) type Wide<O> = <<O as ArrowPrimitiveType>::Native as SumNative>::Wide;

/// The error of a sum that does not fit its type.
pub(crate) fn sum_overflow(out: &DataType) -> WhError {
    let kind = if matches!(out, DataType::Decimal128(..)) { "decimal" } else { "integer" };
    WhError::Execution(format!("{kind} overflow in sum(...): cast to DOUBLE or DECIMAL"))
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

pub(crate) fn as_f64(a: &ArrayRef) -> Result<ArrayRef> {
    if a.data_type() == &DataType::Float64 { Ok(a.clone()) } else { Ok(cast(a, &DataType::Float64)?) }
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

/// The accumulator of an aggregate whose per-group state has a fixed size,
/// kept in rows (see [`crate::exec::acc_rows`]); `None` for the others.
pub fn create_row_accumulator(func: AggFunc, input: Option<&DataType>, distinct: bool) -> Option<Box<dyn RowAcc>> {
    use DataType::*;
    let dt = input.cloned().unwrap_or(Null);
    if distinct && !matches!(func, AggFunc::Min | AggFunc::Max) {
        return None;
    }
    macro_rules! sum {
        ($i:ty, $o:ty, $out:expr) => {
            Box::new(SumRow::<$i, $o>::new($out)) as Box<dyn RowAcc>
        };
    }
    macro_rules! minmax {
        ($t:ty) => {
            if func == AggFunc::Min {
                Box::new(MinMaxRow::<$t, true>::new(dt.clone())) as Box<dyn RowAcc>
            } else {
                Box::new(MinMaxRow::<$t, false>::new(dt.clone())) as Box<dyn RowAcc>
            }
        };
    }
    Some(match func {
        AggFunc::Count => Box::new(CountRow),
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
            _ => return None,
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
            _ => return None,
        },
        AggFunc::Mean => match &dt {
            Int8 => Box::new(MeanRow::<Int8Type>::new()),
            Int16 => Box::new(MeanRow::<Int16Type>::new()),
            Int32 => Box::new(MeanRow::<Int32Type>::new()),
            Int64 => Box::new(MeanRow::<Int64Type>::new()),
            UInt8 => Box::new(MeanRow::<UInt8Type>::new()),
            UInt16 => Box::new(MeanRow::<UInt16Type>::new()),
            UInt32 => Box::new(MeanRow::<UInt32Type>::new()),
            UInt64 => Box::new(MeanRow::<UInt64Type>::new()),
            Float32 => Box::new(MeanRow::<Float32Type>::new()),
            Decimal128(_, s) => Box::new(DecimalMeanRow::new(*s)),
            _ => Box::new(MeanRow::<Float64Type>::new()),
        },
        _ => return None,
    })
}

pub fn create_accumulator(func: AggFunc, input: Option<&DataType>, distinct: bool) -> Result<Box<dyn Accumulator>> {
    use DataType::*;
    if let Some(acc) = create_row_accumulator(func, input, distinct) {
        return Ok(Box::new(OwnRows::new(acc)));
    }
    let dt = input.cloned().unwrap_or(Null);
    if distinct {
        return match func {
            AggFunc::Count => Ok(Box::new(CountDistinctAcc::try_new(&dt)?)),
            AggFunc::Min | AggFunc::Max => create_accumulator(func, input, false),
            AggFunc::Sum => Ok(Box::new(SumDistinctAcc::try_new(&dt)?)),
            f => Err(WhError::NotSupported(format!("{}(DISTINCT ..) is not supported", f.name()))),
        };
    }
    Ok(match func {
        AggFunc::Sum => return Err(WhError::NotSupported(format!("sum over {dt}"))),
        AggFunc::Min | AggFunc::Max => match &dt {
            Utf8 | LargeUtf8 | Utf8View => Box::new(MinMaxStrAcc::new(dt.clone(), func == AggFunc::Min)),
            t => Box::new(MinMaxRowAcc::try_new(t, func == AggFunc::Min)?),
        },
        AggFunc::Count | AggFunc::Mean => unreachable!("{} keeps its state in rows", func.name()),
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
