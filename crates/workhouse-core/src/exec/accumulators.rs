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
use hashbrown::{HashMap, HashSet};

use crate::error::{Result, WhError};
use crate::expr::AggFunc;

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
    fn as_any(&self) -> &dyn Any;
}

fn downcast<'a, T: 'static>(other: &'a dyn Accumulator) -> Result<&'a T> {
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

pub struct SumAcc<I: ArrowPrimitiveType, O: ArrowPrimitiveType> {
    sums: Vec<O::Native>,
    seen: Option<Vec<bool>>,
    out_type: DataType,
    _p: PhantomData<fn() -> I>,
}

impl<I: ArrowPrimitiveType, O: ArrowPrimitiveType> SumAcc<I, O> {
    pub fn new(out_type: DataType, track_seen: bool) -> Self {
        Self { sums: vec![], seen: if track_seen { Some(vec![]) } else { None }, out_type, _p: PhantomData }
    }
}

impl<I, O> Accumulator for SumAcc<I, O>
where
    I: ArrowPrimitiveType,
    O: ArrowPrimitiveType,
    I::Native: Into<O::Native>,
{
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        let prev = self.sums.len();
        self.sums.resize(num_groups, O::Native::ZERO);
        let arr = values[0].as_primitive::<I>();
        let vals = arr.values();
        match arr.nulls().filter(|n| n.null_count() > 0) {
            None => {
                let s = &mut self.sums;
                for (&g, &v) in gids.iter().zip(vals.iter()) {
                    // SAFETY: group ids are < num_groups
                    let slot = unsafe { s.get_unchecked_mut(g as usize) };
                    *slot = slot.add_wrapping(v.into());
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
                        *slot = slot.add_wrapping(v.into());
                        seen[g as usize] = true;
                    }
                }
            }
        }
        Ok(())
    }

    fn update_single(&mut self, values: &[ArrayRef], _num_rows: usize) -> Result<()> {
        if self.sums.is_empty() {
            self.sums.push(O::Native::ZERO);
            self.seen = Some(vec![false]);
        }
        let arr = values[0].as_primitive::<I>();
        let mut acc = self.sums[0];
        let mut any = false;
        match arr.nulls().filter(|n| n.null_count() > 0) {
            None => {
                // 4 independent accumulators let the compiler vectorise float sums too
                let vals = arr.values();
                let mut lanes = [O::Native::ZERO; 4];
                let chunks = vals.chunks_exact(4);
                let rem = chunks.remainder();
                for c in chunks {
                    for l in 0..4 {
                        lanes[l] = lanes[l].add_wrapping(c[l].into());
                    }
                }
                for &v in rem {
                    acc = acc.add_wrapping(v.into());
                }
                for l in lanes {
                    acc = acc.add_wrapping(l);
                }
                any = !vals.is_empty();
            }
            Some(nulls) => {
                for (i, &v) in arr.values().iter().enumerate() {
                    if nulls.is_valid(i) {
                        acc = acc.add_wrapping(v.into());
                        any = true;
                    }
                }
            }
        }
        self.sums[0] = acc;
        if any {
            self.seen.as_mut().unwrap()[0] = true;
        }
        Ok(())
    }

    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<Self>(other)?;
        let prev = self.sums.len();
        self.sums.resize(num_groups, O::Native::ZERO);
        if o.seen.is_some() || self.seen.is_some() {
            let seen = self.seen.get_or_insert_with(|| vec![true; prev]);
            seen.resize(num_groups, false);
        }
        for (&s, &d) in src.iter().zip(dst) {
            let (s, d) = (s as usize, d as usize);
            let v = o.sums.get(s).copied().unwrap_or(O::Native::ZERO);
            self.sums[d] = self.sums[d].add_wrapping(v);
            if let Some(seen) = &mut self.seen {
                let os = match &o.seen {
                    Some(x) => x.get(s).copied().unwrap_or(false),
                    None => s < o.sums.len(),
                };
                seen[d] |= os;
            }
        }
        Ok(())
    }

    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        self.sums.resize(num_groups, O::Native::ZERO);
        let nulls = valid_mask(&self.seen, num_groups);
        Ok(Arc::new(
            PrimitiveArray::<O>::new(ScalarBuffer::from(std::mem::take(&mut self.sums)), nulls)
                .with_data_type(self.out_type.clone()),
        ))
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
        Ok(Self { conv: RowConverter::new(vec![SortField::new(dt.clone())])?, vals: vec![], min, dt: dt.clone() })
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

pub struct MeanAcc {
    sums: Vec<f64>,
    counts: Vec<i64>,
}

fn as_f64(a: &ArrayRef) -> Result<ArrayRef> {
    if a.data_type() == &DataType::Float64 { Ok(a.clone()) } else { Ok(cast(a, &DataType::Float64)?) }
}

impl Accumulator for MeanAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.sums.resize(num_groups, 0.0);
        self.counts.resize(num_groups, 0);
        let a = as_f64(&values[0])?;
        let a = a.as_primitive::<Float64Type>();
        match a.nulls().filter(|n| n.null_count() > 0) {
            None => {
                for (&g, &v) in gids.iter().zip(a.values().iter()) {
                    let g = g as usize;
                    // SAFETY: group ids are < num_groups
                    unsafe {
                        *self.sums.get_unchecked_mut(g) += v;
                        *self.counts.get_unchecked_mut(g) += 1;
                    }
                }
            }
            Some(nulls) => {
                for (i, (&g, &v)) in gids.iter().zip(a.values().iter()).enumerate() {
                    if nulls.is_valid(i) {
                        self.sums[g as usize] += v;
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
        let a = as_f64(&values[0])?;
        let a = a.as_primitive::<Float64Type>();
        let valid = a.len() - a.null_count();
        let s = if a.null_count() == 0 {
            let mut lanes = [0.0f64; 4];
            let chunks = a.values().chunks_exact(4);
            let rem: f64 = chunks.remainder().iter().sum();
            for c in chunks {
                for l in 0..4 {
                    lanes[l] += c[l];
                }
            }
            lanes.iter().sum::<f64>() + rem
        } else {
            a.iter().flatten().sum()
        };
        self.sums[0] += s;
        self.counts[0] += valid as i64;
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<MeanAcc>(other)?;
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

pub enum DistinctSet {
    Int(HashSet<(u32, i64)>),
    Bytes(RowConverter, HashSet<(u32, Box<[u8]>)>),
}

pub struct CountDistinctAcc {
    set: DistinctSet,
}

impl CountDistinctAcc {
    pub fn try_new(dt: &DataType) -> Result<Self> {
        let int_like = dt.is_integer() || matches!(dt, DataType::Date32 | DataType::Date64 | DataType::Timestamp(_, _));
        Ok(Self {
            set: if int_like {
                DistinctSet::Int(HashSet::new())
            } else {
                DistinctSet::Bytes(RowConverter::new(vec![SortField::new(dt.clone())])?, HashSet::new())
            },
        })
    }
}

impl Accumulator for CountDistinctAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], _num_groups: usize) -> Result<()> {
        let a = &values[0];
        match &mut self.set {
            DistinctSet::Int(s) => {
                let c = cast(a, &DataType::Int64)?;
                let c = c.as_primitive::<Int64Type>();
                for (i, &g) in gids.iter().enumerate() {
                    if c.is_valid(i) {
                        s.insert((g, c.value(i)));
                    }
                }
            }
            DistinctSet::Bytes(conv, s) => {
                let rows = conv.convert_columns(std::slice::from_ref(a))?;
                let nulls = a.logical_nulls();
                for (i, &g) in gids.iter().enumerate() {
                    if nulls.as_ref().is_some_and(|n| n.is_null(i)) {
                        continue;
                    }
                    s.insert((g, rows.row(i).as_ref().into()));
                }
            }
        }
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], _num_groups: usize) -> Result<()> {
        let o = downcast::<CountDistinctAcc>(other)?;
        let map: HashMap<u32, u32> = src.iter().copied().zip(dst.iter().copied()).collect();
        match (&mut self.set, &o.set) {
            (DistinctSet::Int(a), DistinctSet::Int(b)) => {
                for (g, v) in b {
                    if let Some(d) = map.get(g) {
                        a.insert((*d, *v));
                    }
                }
            }
            (DistinctSet::Bytes(_, a), DistinctSet::Bytes(_, b)) => {
                for (g, v) in b {
                    if let Some(d) = map.get(g) {
                        a.insert((*d, v.clone()));
                    }
                }
            }
            _ => return Err(WhError::Execution("distinct set mismatch".into())),
        }
        Ok(())
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        let mut counts = vec![0i64; num_groups];
        match &self.set {
            DistinctSet::Int(s) => s.iter().for_each(|(g, _)| counts[*g as usize] += 1),
            DistinctSet::Bytes(_, s) => s.iter().for_each(|(g, _)| counts[*g as usize] += 1),
        }
        Ok(Arc::new(Int64Array::from(counts)))
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

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
        AggFunc::Mean => Box::new(MeanAcc { sums: vec![], counts: vec![] }),
        AggFunc::Median => Box::new(MedianAcc { vals: vec![] }),
        AggFunc::Std => Box::new(VarAcc::new(1.0, true)),
        AggFunc::StdPop => Box::new(VarAcc::new(0.0, true)),
        AggFunc::Var => Box::new(VarAcc::new(1.0, false)),
        AggFunc::VarPop => Box::new(VarAcc::new(0.0, false)),
        AggFunc::First => Box::new(FirstLastAcc::new(dt, false)),
        AggFunc::Last => Box::new(FirstLastAcc::new(dt, true)),
    })
}
