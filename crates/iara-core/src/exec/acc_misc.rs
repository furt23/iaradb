//! `count_if`, `bool_and` / `bool_or`, `product`, `max_by` / `min_by` and
//! `sum(DISTINCT)`.

use std::any::Any;
use std::sync::Arc;

use arrow::array::*;
use arrow::compute::interleave;
use arrow::datatypes::*;
use arrow::row::{RowConverter, SortField};
use hashbrown::{HashMap, HashSet};

use super::accumulators::{Accumulator, as_f64, downcast};
use crate::error::{Result, WhError};

/// Null for a group without a non-null input (DuckDB), else the count of trues.
pub struct CountIfAcc {
    counts: Vec<Option<i64>>,
}

impl CountIfAcc {
    pub fn new() -> Self {
        Self { counts: vec![] }
    }
}

impl Accumulator for CountIfAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.counts.resize(num_groups, None);
        let a = values[0].as_boolean();
        for (i, &g) in gids.iter().enumerate() {
            if a.is_valid(i) {
                *self.counts[g as usize].get_or_insert(0) += i64::from(a.value(i));
            }
        }
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<CountIfAcc>(other)?;
        self.counts.resize(num_groups, None);
        for (&s, &d) in src.iter().zip(dst) {
            if let Some(Some(n)) = o.counts.get(s as usize) {
                *self.counts[d as usize].get_or_insert(0) += n;
            }
        }
        Ok(())
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        self.counts.resize(num_groups, None);
        Ok(Arc::new(Int64Array::from(self.counts.clone())))
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

/// `bool_and` (`AND = true`) / `bool_or`; null for groups without values.
pub struct BoolAcc<const AND: bool> {
    state: Vec<Option<bool>>,
}

impl<const AND: bool> BoolAcc<AND> {
    pub fn new() -> Self {
        Self { state: vec![] }
    }
    fn fold(cur: &mut Option<bool>, v: bool) {
        *cur = Some(match *cur {
            None => v,
            Some(c) if AND => c && v,
            Some(c) => c || v,
        });
    }
}

impl<const AND: bool> Accumulator for BoolAcc<AND> {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.state.resize(num_groups, None);
        let a = values[0].as_boolean();
        for (i, &g) in gids.iter().enumerate() {
            if a.is_valid(i) {
                Self::fold(&mut self.state[g as usize], a.value(i));
            }
        }
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<BoolAcc<AND>>(other)?;
        self.state.resize(num_groups, None);
        for (&s, &d) in src.iter().zip(dst) {
            if let Some(Some(v)) = o.state.get(s as usize) {
                Self::fold(&mut self.state[d as usize], *v);
            }
        }
        Ok(())
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        self.state.resize(num_groups, None);
        Ok(Arc::new(self.state.iter().copied().collect::<BooleanArray>()))
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

pub struct ProductAcc {
    prod: Vec<Option<f64>>,
}

impl ProductAcc {
    pub fn new() -> Self {
        Self { prod: vec![] }
    }
}

impl Accumulator for ProductAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.prod.resize(num_groups, None);
        let a = as_f64(&values[0])?;
        let a = a.as_primitive::<Float64Type>();
        for (i, &g) in gids.iter().enumerate() {
            if a.is_valid(i) {
                let p = &mut self.prod[g as usize];
                *p = Some(p.unwrap_or(1.0) * a.value(i));
            }
        }
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<ProductAcc>(other)?;
        self.prod.resize(num_groups, None);
        for (&s, &d) in src.iter().zip(dst) {
            if let Some(Some(v)) = o.prod.get(s as usize) {
                let p = &mut self.prod[d as usize];
                *p = Some(p.unwrap_or(1.0) * v);
            }
        }
        Ok(())
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        self.prod.resize(num_groups, None);
        Ok(Arc::new(self.prod.iter().copied().collect::<Float64Array>()))
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

// ---------------------------------------------------------------------------
// max_by / min_by: keys are compared in arrow's row format (byte order == sort order)
// ---------------------------------------------------------------------------

/// Per group: the row-format key and the position (array, row) of its value.
type Best = Option<(Box<[u8]>, usize, usize)>;

pub struct ArgExtremeAcc {
    max: bool,
    dt: DataType,
    conv: Option<RowConverter>,
    arrays: Vec<ArrayRef>,
    best: Vec<Best>,
}

impl ArgExtremeAcc {
    pub fn new(dt: DataType, max: bool) -> Self {
        Self { max, dt, conv: None, arrays: vec![], best: vec![] }
    }
    fn better(&self, new: &[u8], old: &[u8]) -> bool {
        if self.max { new > old } else { new < old }
    }
}

impl Accumulator for ArgExtremeAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.best.resize(num_groups, None);
        let (val, key) = (&values[0], &values[1]);
        if self.conv.is_none() {
            self.conv = Some(RowConverter::new(vec![SortField::new(key.data_type().clone())])?);
        }
        let rows = self.conv.as_ref().expect("converter").convert_columns(std::slice::from_ref(key))?;
        let ai = self.arrays.len();
        let mut used = false;
        for (i, &g) in gids.iter().enumerate() {
            // rows with a null in either column are ignored
            if key.is_null(i) || val.is_null(i) {
                continue;
            }
            let k = rows.row(i);
            let replace = match &self.best[g as usize] {
                None => true,
                Some((old, _, _)) => self.better(k.as_ref(), old),
            };
            if replace {
                self.best[g as usize] = Some((k.as_ref().into(), ai, i));
                used = true;
            }
        }
        if used {
            self.arrays.push(val.clone());
        }
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<ArgExtremeAcc>(other)?;
        self.best.resize(num_groups, None);
        let base = self.arrays.len();
        self.arrays.extend(o.arrays.iter().cloned());
        for (&s, &d) in src.iter().zip(dst) {
            if let Some(Some((k, a, r))) = o.best.get(s as usize) {
                let replace = match &self.best[d as usize] {
                    None => true,
                    Some((old, _, _)) => self.better(k, old),
                };
                if replace {
                    self.best[d as usize] = Some((k.clone(), base + a, *r));
                }
            }
        }
        Ok(())
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        self.best.resize(num_groups, None);
        let null = new_null_array(&self.dt, 1);
        let mut sources: Vec<&dyn Array> = self.arrays.iter().map(|a| a.as_ref()).collect();
        let null_idx = sources.len();
        sources.push(null.as_ref());
        let idx: Vec<(usize, usize)> =
            self.best.iter().map(|b| b.as_ref().map_or((null_idx, 0), |(_, a, r)| (*a, *r))).collect();
        Ok(interleave(&sources, &idx)?)
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

// ---------------------------------------------------------------------------
// sum(DISTINCT x) for integers and floats
// ---------------------------------------------------------------------------

pub struct SumDistinctAcc {
    float: bool,
    /// (group, value as i64 or f64 bits)
    seen: HashSet<(u32, i64)>,
}

impl SumDistinctAcc {
    pub fn try_new(dt: &DataType) -> Result<Self> {
        let float = dt.is_floating();
        if !(float || dt.is_integer()) {
            return Err(WhError::NotSupported(format!("sum(DISTINCT ..) over {dt}")));
        }
        Ok(Self { float, seen: HashSet::new() })
    }
}

impl Accumulator for SumDistinctAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], _num_groups: usize) -> Result<()> {
        if self.float {
            let a = as_f64(&values[0])?;
            let a = a.as_primitive::<Float64Type>();
            for (i, &g) in gids.iter().enumerate() {
                if a.is_valid(i) {
                    // -0.0 and 0.0 are one value
                    let v = if a.value(i) == 0.0 { 0.0 } else { a.value(i) };
                    self.seen.insert((g, v.to_bits() as i64));
                }
            }
        } else {
            // not safe: a UInt64 past i64::MAX is an error, not a silent NULL
            let strict = arrow::compute::CastOptions { safe: false, ..Default::default() };
            let a = arrow::compute::cast_with_options(&values[0], &DataType::Int64, &strict)
                .map_err(|_| WhError::Execution("integer overflow in sum(...): cast to DOUBLE or DECIMAL".into()))?;
            let a = a.as_primitive::<Int64Type>();
            for (i, &g) in gids.iter().enumerate() {
                if a.is_valid(i) {
                    self.seen.insert((g, a.value(i)));
                }
            }
        }
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], _num_groups: usize) -> Result<()> {
        let o = downcast::<SumDistinctAcc>(other)?;
        let map: HashMap<u32, u32> = src.iter().copied().zip(dst.iter().copied()).collect();
        for (g, v) in &o.seen {
            if let Some(d) = map.get(g) {
                self.seen.insert((*d, *v));
            }
        }
        Ok(())
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        if self.float {
            let mut sums: Vec<Option<f64>> = vec![None; num_groups];
            for (g, v) in &self.seen {
                let s = &mut sums[*g as usize];
                *s = Some(s.unwrap_or(0.0) + f64::from_bits(*v as u64));
            }
            return Ok(Arc::new(sums.into_iter().collect::<Float64Array>()));
        }
        let mut sums: Vec<Option<i128>> = vec![None; num_groups];
        for (g, v) in &self.seen {
            let s = &mut sums[*g as usize];
            *s = Some(s.unwrap_or(0) + *v as i128);
        }
        let out = sums
            .into_iter()
            .map(|s| {
                s.map(|s| i64::try_from(s).map_err(|_| WhError::Execution("integer overflow in sum(...): cast to DOUBLE or DECIMAL".into()))).transpose()
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(Arc::new(Int64Array::from(out)))
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}
