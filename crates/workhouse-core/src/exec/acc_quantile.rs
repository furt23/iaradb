//! `quantile_cont` / `quantile_disc` / `approx_quantile`: the values of each
//! group are collected and sorted at the end (exact; `approx_quantile` does
//! not use a sketch). Spilled partitions are aggregated from raw rows, so
//! only `update` / `merge` need to be correct, as for the other accumulators.

use std::any::Any;
use std::sync::Arc;

use arrow::array::*;
use arrow::compute::cast;
use arrow::datatypes::*;

use super::accumulators::{Accumulator, as_f64, downcast};
use crate::error::{Result, WhError};

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum QuantileMode {
    Cont,
    Disc,
}

enum Store {
    Float(Vec<Vec<f64>>),
    /// integers, dates and timestamps (exact, no f64 round trip)
    Int(Vec<Vec<i64>>),
}

pub struct QuantileAcc {
    store: Store,
    mode: QuantileMode,
    p: Option<f64>,
    out: DataType,
}

fn int_like(dt: &DataType) -> bool {
    dt.is_integer() || matches!(dt, DataType::Date32 | DataType::Date64 | DataType::Timestamp(_, _))
}

impl QuantileAcc {
    /// `out` is the result type (Float64 for cont; the input type for disc and
    /// for `approx_quantile` over integers).
    pub fn try_new(mode: QuantileMode, input: &DataType, out: DataType) -> Result<Self> {
        let store = if mode == QuantileMode::Disc && int_like(input) {
            Store::Int(vec![])
        } else if input.is_numeric() || matches!(input, DataType::Null | DataType::Boolean) {
            Store::Float(vec![])
        } else {
            return Err(WhError::NotSupported(format!("quantile over {input}")));
        };
        Ok(Self { store, mode, p: None, out })
    }

    fn read_p(&mut self, values: &[ArrayRef]) -> Result<()> {
        if self.p.is_some() {
            return Ok(());
        }
        let Some(a) = values.get(1) else {
            self.p = Some(0.5);
            return Ok(());
        };
        let a = as_f64(a)?;
        let a = a.as_primitive::<Float64Type>();
        if let Some(i) = (0..a.len()).find(|&i| a.is_valid(i)) {
            let p = a.value(i);
            if !(0.0..=1.0).contains(&p) {
                return Err(WhError::Execution(format!("quantile must be between 0 and 1, got {p}")));
            }
            self.p = Some(p);
        }
        Ok(())
    }
}

fn disc_index(n: usize, p: f64) -> usize {
    ((n as f64 * p).ceil() as usize).saturating_sub(1).min(n - 1)
}

fn cont(v: &mut [f64], p: f64) -> Option<f64> {
    if v.is_empty() {
        return None;
    }
    v.sort_unstable_by(|a, b| a.total_cmp(b));
    let rn = (v.len() - 1) as f64 * p;
    let (lo, hi) = (rn.floor() as usize, rn.ceil() as usize);
    Some(if lo == hi { v[lo] } else { v[lo] + (rn - lo as f64) * (v[hi] - v[lo]) })
}

impl Accumulator for QuantileAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.read_p(values)?;
        match &mut self.store {
            Store::Float(vals) => {
                vals.resize_with(num_groups, Vec::new);
                let a = as_f64(&values[0])?;
                let a = a.as_primitive::<Float64Type>();
                for (i, &g) in gids.iter().enumerate() {
                    if a.is_valid(i) {
                        vals[g as usize].push(a.value(i));
                    }
                }
            }
            Store::Int(vals) => {
                vals.resize_with(num_groups, Vec::new);
                let a = cast(&values[0], &DataType::Int64)?;
                let a = a.as_primitive::<Int64Type>();
                for (i, &g) in gids.iter().enumerate() {
                    if a.is_valid(i) {
                        vals[g as usize].push(a.value(i));
                    }
                }
            }
        }
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<QuantileAcc>(other)?;
        self.p = self.p.or(o.p);
        match (&mut self.store, &o.store) {
            (Store::Float(a), Store::Float(b)) => {
                a.resize_with(num_groups, Vec::new);
                for (&s, &d) in src.iter().zip(dst) {
                    if let Some(v) = b.get(s as usize) {
                        a[d as usize].extend_from_slice(v);
                    }
                }
            }
            (Store::Int(a), Store::Int(b)) => {
                a.resize_with(num_groups, Vec::new);
                for (&s, &d) in src.iter().zip(dst) {
                    if let Some(v) = b.get(s as usize) {
                        a[d as usize].extend_from_slice(v);
                    }
                }
            }
            _ => return Err(WhError::Execution("quantile store mismatch".into())),
        }
        Ok(())
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        let p = self.p.unwrap_or(0.5);
        let disc = self.mode == QuantileMode::Disc;
        let arr: ArrayRef = match &mut self.store {
            Store::Float(vals) => {
                vals.resize_with(num_groups, Vec::new);
                let out: Float64Array = vals
                    .iter_mut()
                    .map(|v| if disc { pick_disc(v, p, |a, b| a.total_cmp(b)) } else { cont(v, p) })
                    .collect();
                Arc::new(out)
            }
            Store::Int(vals) => {
                vals.resize_with(num_groups, Vec::new);
                let out: Int64Array = vals.iter_mut().map(|v| pick_disc(v, p, |a, b| a.cmp(b))).collect();
                Arc::new(out)
            }
        };
        // interpolated values go back to an integer type truncated (as DuckDB's approx_quantile)
        Ok(if arr.data_type() == &self.out { arr } else { cast(&arr, &self.out)? })
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

fn pick_disc<T: Copy>(v: &mut [T], p: f64, cmp: impl Fn(&T, &T) -> std::cmp::Ordering) -> Option<T> {
    if v.is_empty() {
        return None;
    }
    let idx = disc_index(v.len(), p);
    Some(*v.select_nth_unstable_by(idx, cmp).1)
}
