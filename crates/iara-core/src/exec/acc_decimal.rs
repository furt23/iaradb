//! `avg` over decimals: the sum is kept exactly as an i128 (no per-row
//! conversion to f64) and divided once per group at the end.

use std::any::Any;
use std::sync::Arc;

use arrow::array::*;
use arrow::datatypes::Decimal128Type;

use crate::error::{Result, WhError};
use crate::exec::accumulators::{Accumulator, downcast};

pub struct DecimalMeanAcc {
    sums: Vec<i128>,
    counts: Vec<i64>,
    scale: i8,
}

impl DecimalMeanAcc {
    pub fn new(scale: i8) -> Self {
        Self { sums: vec![], counts: vec![], scale }
    }

    fn resize(&mut self, n: usize) {
        self.sums.resize(n, 0);
        self.counts.resize(n, 0);
    }
}

fn overflow() -> WhError {
    WhError::Execution("decimal overflow in avg(...): cast to DOUBLE".into())
}

impl Accumulator for DecimalMeanAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.resize(num_groups);
        let a = values[0].as_primitive::<Decimal128Type>();
        let mut over = false;
        let (sums, counts) = (&mut self.sums, &mut self.counts);
        match a.nulls().filter(|n| n.null_count() > 0) {
            None => {
                for (&g, &v) in gids.iter().zip(a.values().iter()) {
                    let g = g as usize;
                    // SAFETY: group ids are < num_groups
                    unsafe {
                        let s = sums.get_unchecked_mut(g);
                        let (r, o) = s.overflowing_add(v);
                        *s = r;
                        over |= o;
                        *counts.get_unchecked_mut(g) += 1;
                    }
                }
            }
            Some(nulls) => {
                for (i, (&g, &v)) in gids.iter().zip(a.values().iter()).enumerate() {
                    if nulls.is_valid(i) {
                        let (r, o) = sums[g as usize].overflowing_add(v);
                        sums[g as usize] = r;
                        over |= o;
                        counts[g as usize] += 1;
                    }
                }
            }
        }
        if over { Err(overflow()) } else { Ok(()) }
    }

    fn update_single(&mut self, values: &[ArrayRef], _num_rows: usize) -> Result<()> {
        self.resize(1);
        let a = values[0].as_primitive::<Decimal128Type>();
        let mut over = false;
        let mut lanes = [0i128; 4];
        let mut add = |lane: usize, v: i128| {
            let (r, o) = lanes[lane].overflowing_add(v);
            lanes[lane] = r;
            over |= o;
        };
        let valid = match a.nulls().filter(|n| n.null_count() > 0) {
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
        for l in lanes {
            let (r, o) = self.sums[0].overflowing_add(l);
            self.sums[0] = r;
            over |= o;
        }
        self.counts[0] += valid as i64;
        if over { Err(overflow()) } else { Ok(()) }
    }

    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<Self>(other)?;
        self.resize(num_groups);
        let mut over = false;
        for (&s, &d) in src.iter().zip(dst) {
            let (s, d) = (s as usize, d as usize);
            if s < o.sums.len() {
                let (r, of) = self.sums[d].overflowing_add(o.sums[s]);
                self.sums[d] = r;
                over |= of;
                self.counts[d] += o.counts[s];
            }
        }
        if over { Err(overflow()) } else { Ok(()) }
    }

    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        self.resize(num_groups);
        let unit = 10f64.powi(self.scale as i32);
        let out: Float64Array = self
            .sums
            .iter()
            .zip(&self.counts)
            .map(|(&s, &c)| (c > 0).then(|| s as f64 / unit / c as f64))
            .collect();
        Ok(Arc::new(out))
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dec(v: Vec<Option<i128>>) -> ArrayRef {
        Arc::new(Decimal128Array::from(v).with_precision_and_scale(15, 2).unwrap())
    }

    #[test]
    fn grouped_single_and_merged_means() {
        let mut a = DecimalMeanAcc::new(2);
        a.update(&[dec(vec![Some(100), Some(300), None, Some(-50)])], &[0, 0, 1, 1], 3).unwrap();
        let mut b = DecimalMeanAcc::new(2);
        b.update_single(&[dec(vec![Some(1), Some(2), Some(3), Some(4), Some(5)])], 5).unwrap();
        a.merge(&b, &[0], &[1], 3).unwrap();
        let r = a.finish(3).unwrap();
        let r = r.as_primitive::<arrow::datatypes::Float64Type>();
        assert_eq!(r.value(0), 2.0);
        assert!((r.value(1) - (-50.0 + 15.0) / 100.0 / 6.0).abs() < 1e-12);
        assert!(r.is_null(2));
    }
}
