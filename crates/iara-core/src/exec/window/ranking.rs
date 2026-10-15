//! Ranking functions: row_number, rank, dense_rank, percent_rank,
//! cume_dist, ntile.

use std::ops::Range;
use std::sync::Arc;

use arrow::array::{ArrayRef, Float64Array, Int64Array};

use crate::error::{Result, WhError};
use crate::exec::window::WindowFunctionExpr;
use crate::exec::window::layout::Layout;
use crate::expr::WindowFunc;

pub fn evaluate(f: &WindowFunctionExpr, layout: &Layout) -> Result<ArrayRef> {
    let ps = &layout.peer_start;
    let pe = &layout.peer_end;
    let sorted: ArrayRef = match f.func {
        WindowFunc::RowNumber => ints(layout, true, |p, rows, out| {
            for (k, o) in out.iter_mut().enumerate() {
                *o = (rows.start + k - p.start) as i64 + 1;
            }
        })?,
        WindowFunc::Rank => ints(layout, true, |p, rows, out| {
            for (k, o) in out.iter_mut().enumerate() {
                *o = (ps[rows.start + k] as usize - p.start) as i64 + 1;
            }
        })?,
        // a running count of peer groups: whole partitions only
        WindowFunc::DenseRank => ints(layout, false, |p, _, out| {
            let mut g = 0;
            for (k, o) in out.iter_mut().enumerate() {
                let i = p.start + k;
                if ps[i] as usize == i {
                    g += 1;
                }
                *o = g;
            }
        })?,
        WindowFunc::PercentRank => floats(layout, |p, rows, out| {
            let n = p.len();
            for (k, o) in out.iter_mut().enumerate() {
                let rank = ps[rows.start + k] as usize - p.start;
                *o = if n > 1 { rank as f64 / (n - 1) as f64 } else { 0.0 };
            }
        })?,
        WindowFunc::CumeDist => floats(layout, |p, rows, out| {
            let n = p.len() as f64;
            for (k, o) in out.iter_mut().enumerate() {
                *o = (pe[rows.start + k] as usize - p.start) as f64 / n;
            }
        })?,
        WindowFunc::Ntile => {
            let buckets = f.literal_arg(0)?.ok_or_else(|| WhError::Execution("ntile() argument must not be NULL".into()))?;
            if buckets <= 0 {
                return Err(WhError::Execution(format!("ntile() argument must be positive, got {buckets}")));
            }
            let buckets = buckets as usize;
            ints(layout, true, |p, rows, out| {
                // the first `n % buckets` buckets hold one row more
                let n = p.len();
                let (q, r) = (n / buckets, n % buckets);
                let big = (q + 1) * r;
                for (j, o) in out.iter_mut().enumerate() {
                    let k = rows.start + j - p.start;
                    let b = if k < big { k / (q + 1) } else { r + (k - big) / q.max(1) };
                    *o = b as i64 + 1;
                }
            })?
        }
        other => return Err(WhError::Execution(format!("{} is not a ranking function", other.name()))),
    };
    layout.unsort(sorted)
}

/// `f(partition, rows, out)` fills the outputs of `rows`; with `split` a
/// large partition comes in several chunks, otherwise `rows` is all of it.
fn ints(layout: &Layout, split: bool, f: impl Fn(Range<usize>, Range<usize>, &mut [i64]) + Sync) -> Result<ArrayRef> {
    let v = layout.for_chunks(0i64, split, |p, rows, out| {
        f(p, rows, out);
        Ok(())
    })?;
    Ok(Arc::new(Int64Array::from(v)))
}

/// Position-based float outputs (always splittable).
fn floats(layout: &Layout, f: impl Fn(Range<usize>, Range<usize>, &mut [f64]) + Sync) -> Result<ArrayRef> {
    let v = layout.for_chunks(0f64, true, |p, rows, out| {
        f(p, rows, out);
        Ok(())
    })?;
    Ok(Arc::new(Float64Array::from(v)))
}
