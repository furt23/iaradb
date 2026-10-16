//! Two-column statistics: `corr`, `covar_samp`, `covar_pop`, `regr_slope(y, x)`.
//! Welford-style co-moments with the Chan merge. Rows with a null in either
//! column are skipped, as in DuckDB.

use std::any::Any;
use std::sync::Arc;

use arrow::array::*;
use arrow::datatypes::*;

use super::accumulators::{Accumulator, as_f64, downcast};
use crate::error::Result;
use crate::expr::AggFunc;

#[derive(Clone, Copy, Default)]
struct Moments {
    n: f64,
    mx: f64,
    my: f64,
    c: f64,
    m2x: f64,
    m2y: f64,
}

pub struct PairStatAcc {
    func: AggFunc,
    st: Vec<Moments>,
}

impl PairStatAcc {
    pub fn new(func: AggFunc) -> Self {
        Self { func, st: vec![] }
    }
}

impl Moments {
    fn add(&mut self, x: f64, y: f64) {
        self.n += 1.0;
        let dx = x - self.mx;
        self.mx += dx / self.n;
        let dy = y - self.my;
        self.my += dy / self.n;
        self.c += dx * (y - self.my);
        self.m2x += dx * (x - self.mx);
        self.m2y += dy * (y - self.my);
    }
    fn merge(&mut self, o: &Moments) {
        if o.n == 0.0 {
            return;
        }
        let (na, nb) = (self.n, o.n);
        let n = na + nb;
        let (dx, dy) = (o.mx - self.mx, o.my - self.my);
        self.c += o.c + dx * dy * na * nb / n;
        self.m2x += o.m2x + dx * dx * na * nb / n;
        self.m2y += o.m2y + dy * dy * na * nb / n;
        self.mx += dx * nb / n;
        self.my += dy * nb / n;
        self.n = n;
    }
    fn result(&self, func: AggFunc) -> Option<f64> {
        match func {
            _ if self.n == 0.0 => None,
            AggFunc::CovarPop => Some(self.c / self.n),
            AggFunc::CovarSamp => (self.n > 1.0).then(|| self.c / (self.n - 1.0)),
            AggFunc::Corr => Some(self.c / (self.m2x * self.m2y).sqrt()),
            // regr_slope(y, x): x is the first moment axis (see `update`)
            _ => Some(self.c / self.m2x),
        }
    }
}

impl Accumulator for PairStatAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.st.resize(num_groups, Moments::default());
        let (a, b) = (as_f64(&values[0])?, as_f64(&values[1])?);
        let (a, b) = (a.as_primitive::<Float64Type>(), b.as_primitive::<Float64Type>());
        // regr_slope(y, x) takes y first; the other statistics are symmetric
        let swap = self.func == AggFunc::RegrSlope;
        for (i, &g) in gids.iter().enumerate() {
            if a.is_valid(i) && b.is_valid(i) {
                let (x, y) = if swap { (b.value(i), a.value(i)) } else { (a.value(i), b.value(i)) };
                self.st[g as usize].add(x, y);
            }
        }
        Ok(())
    }
    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<PairStatAcc>(other)?;
        self.st.resize(num_groups, Moments::default());
        for (&s, &d) in src.iter().zip(dst) {
            if let Some(m) = o.st.get(s as usize) {
                self.st[d as usize].merge(m);
            }
        }
        Ok(())
    }
    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        self.st.resize(num_groups, Moments::default());
        let out: Float64Array = self.st.iter().map(|m| m.result(self.func)).collect();
        Ok(Arc::new(out))
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}
