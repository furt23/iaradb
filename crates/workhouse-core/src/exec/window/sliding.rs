//! Aggregates over moving frames. Frame bounds only move forward from one
//! row to the next, so each aggregate keeps a state that rows enter and
//! leave: O(1) per row for sums, counts and moments, amortised O(1) for
//! min / max (a monotonic deque).

use std::cmp::Ordering;
use std::collections::VecDeque;

use arrow::array::DynComparator;

use crate::error::Result;
use crate::exec::window::frame::{Frames, RangeKeys};
use crate::exec::window::layout::{Layout, NO_ROW};
use crate::expr::{FrameBound, FrameUnits, WindowFrame};

pub trait State {
    fn reset(&mut self);
    fn add(&mut self, i: usize);
    fn remove(&mut self, i: usize);
}

/// Evaluate a state over the frame of every row; `read` turns the state
/// into the row's output.
pub fn slide<S, T>(
    layout: &Layout,
    frame: &WindowFrame,
    init: T,
    make: impl Fn() -> S + Sync,
    read: impl Fn(&S) -> T + Sync,
) -> Result<Vec<T>>
where
    S: State,
    T: Clone + Send + Sync,
{
    let keys = RangeKeys::new(layout, frame)?;
    // a chunk of a partition can start on its own when its first frame is
    // cheap to fill: bounded on both sides (GROUPS frames index the whole
    // partition's peer groups)
    let split = frame.start != FrameBound::UnboundedPreceding
        && frame.end != FrameBound::UnboundedFollowing
        && frame.units != FrameUnits::Groups;
    layout.for_chunks(init, split, |p, rows, out| {
        let frames = Frames::new(layout, frame, keys.as_ref(), p);
        let mut st = make();
        let (mut lo, mut hi) = (rows.start, rows.start);
        for (j, o) in out.iter_mut().enumerate() {
            let (s, e) = frames.bounds(rows.start + j);
            let e = e.max(s);
            // frames normally advance; anything else restarts the state
            if s < lo || e < hi || s >= hi {
                st.reset();
                (lo, hi) = (s, s);
            }
            while hi < e {
                st.add(hi);
                hi += 1;
            }
            while lo < s {
                st.remove(lo);
                lo += 1;
            }
            *o = read(&st);
        }
        Ok(())
    })
}

#[inline]
fn ok(valid: Option<&[bool]>, i: usize) -> bool {
    valid.is_none_or(|v| v[i])
}

/// Number of valid rows.
pub struct Count<'a> {
    pub valid: Option<&'a [bool]>,
    pub n: i64,
}

impl State for Count<'_> {
    fn reset(&mut self) {
        self.n = 0;
    }
    fn add(&mut self, i: usize) {
        if ok(self.valid, i) {
            self.n += 1;
        }
    }
    fn remove(&mut self, i: usize) {
        if ok(self.valid, i) {
            self.n -= 1;
        }
    }
}

/// Exact sum of integers (and scaled decimals).
pub struct IntSum<'a, T> {
    pub values: &'a [T],
    pub valid: Option<&'a [bool]>,
    pub sum: i128,
    pub n: i64,
}

impl<T: Copy + Into<i128>> State for IntSum<'_, T> {
    fn reset(&mut self) {
        (self.sum, self.n) = (0, 0);
    }
    fn add(&mut self, i: usize) {
        if ok(self.valid, i) {
            self.sum += self.values[i].into();
            self.n += 1;
        }
    }
    fn remove(&mut self, i: usize) {
        if ok(self.valid, i) {
            self.sum -= self.values[i].into();
            self.n -= 1;
        }
    }
}

/// Compensated (Neumaier) floating point sum: rows leaving the frame are
/// subtracted without accumulating rounding error.
pub struct FloatSum<'a> {
    pub values: &'a [f64],
    pub valid: Option<&'a [bool]>,
    pub sum: f64,
    pub comp: f64,
    pub n: i64,
    /// non-finite values in the frame (they cannot be subtracted back out):
    /// NaN, +inf, -inf
    pub special: [i64; 3],
}

impl FloatSum<'_> {
    fn acc(&mut self, x: f64) {
        let t = self.sum + x;
        if self.sum.abs() >= x.abs() {
            self.comp += (self.sum - t) + x;
        } else {
            self.comp += (x - t) + self.sum;
        }
        self.sum = t;
    }

    pub fn value(&self) -> Option<f64> {
        let [nan, pos, neg] = self.special;
        Some(match () {
            _ if self.n == 0 => return None,
            _ if nan > 0 || (pos > 0 && neg > 0) => f64::NAN,
            _ if pos > 0 => f64::INFINITY,
            _ if neg > 0 => f64::NEG_INFINITY,
            _ => self.sum + self.comp,
        })
    }

    fn special_slot(x: f64) -> usize {
        if x.is_nan() {
            0
        } else if x > 0.0 {
            1
        } else {
            2
        }
    }
}

impl State for FloatSum<'_> {
    fn reset(&mut self) {
        (self.sum, self.comp, self.n, self.special) = (0.0, 0.0, 0, [0; 3]);
    }
    fn add(&mut self, i: usize) {
        if ok(self.valid, i) {
            let x = self.values[i];
            self.n += 1;
            if x.is_finite() { self.acc(x) } else { self.special[Self::special_slot(x)] += 1 }
        }
    }
    fn remove(&mut self, i: usize) {
        if ok(self.valid, i) {
            let x = self.values[i];
            self.n -= 1;
            if x.is_finite() { self.acc(-x) } else { self.special[Self::special_slot(x)] -= 1 }
        }
    }
}

/// Count, mean and sum of squared deviations (Welford, with removal).
pub struct Moments<'a> {
    pub values: &'a [f64],
    pub valid: Option<&'a [bool]>,
    pub n: f64,
    pub mean: f64,
    pub m2: f64,
}

impl Moments<'_> {
    pub fn variance(&self, ddof: f64) -> Option<f64> {
        (self.n > ddof).then(|| (self.m2 / (self.n - ddof)).max(0.0))
    }
}

impl State for Moments<'_> {
    fn reset(&mut self) {
        (self.n, self.mean, self.m2) = (0.0, 0.0, 0.0);
    }
    fn add(&mut self, i: usize) {
        if ok(self.valid, i) {
            let x = self.values[i];
            self.n += 1.0;
            let d = x - self.mean;
            self.mean += d / self.n;
            self.m2 += d * (x - self.mean);
        }
    }
    fn remove(&mut self, i: usize) {
        if ok(self.valid, i) {
            if self.n <= 1.0 {
                self.reset();
                return;
            }
            let x = self.values[i];
            self.n -= 1.0;
            let d = x - self.mean;
            self.mean -= d / self.n;
            self.m2 -= d * (x - self.mean);
        }
    }
}

/// Position of the minimum (or maximum) valid value: a deque of candidate
/// positions with strictly improving values from front to back.
pub struct Extreme<'a> {
    pub cmp: &'a DynComparator,
    pub valid: Option<&'a [bool]>,
    pub min: bool,
    pub deque: VecDeque<usize>,
}

impl Extreme<'_> {
    pub fn position(&self) -> u32 {
        self.deque.front().map_or(NO_ROW, |&i| i as u32)
    }
}

impl State for Extreme<'_> {
    fn reset(&mut self) {
        self.deque.clear();
    }
    fn add(&mut self, i: usize) {
        if !ok(self.valid, i) {
            return;
        }
        let better = if self.min { Ordering::Less } else { Ordering::Greater };
        while let Some(&b) = self.deque.back() {
            // candidates not better than the new row can no longer be the extreme
            if (self.cmp)(b, i) == better {
                break;
            }
            self.deque.pop_back();
        }
        self.deque.push_back(i);
    }
    fn remove(&mut self, i: usize) {
        if self.deque.front() == Some(&i) {
            self.deque.pop_front();
        }
    }
}
