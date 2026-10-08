//! Value functions: lag / lead (rows at an offset within the partition) and
//! first_value / last_value / nth_value (rows of the frame).

use arrow::array::{ArrayRef, BooleanArray};
use arrow::compute::cast;
use arrow::compute::kernels::zip::zip;

use crate::error::{Result, WhError};
use crate::exec::window::frame::{Frames, RangeKeys};
use crate::exec::window::layout::{Layout, NO_ROW};
use crate::exec::window::{WindowFunctionExpr, valid_rows};
use crate::expr::{AggFunc, WindowFunc};

/// Positions of the partition's valid rows, and for each partition offset
/// the number of valid rows before it.
struct Valid {
    positions: Vec<usize>,
    before: Vec<usize>,
}

impl Valid {
    fn new(valid: &[bool], p: &std::ops::Range<usize>) -> Self {
        let mut positions = vec![];
        let mut before = Vec::with_capacity(p.len() + 1);
        for i in p.clone() {
            before.push(positions.len());
            if valid[i] {
                positions.push(i);
            }
        }
        before.push(positions.len());
        Self { positions, before }
    }
}

/// `lag(x, k, default)` / `lead(x, k, default)`.
pub fn offset(f: &WindowFunctionExpr, batch: &arrow::record_batch::RecordBatch, layout: &Layout) -> Result<ArrayRef> {
    let values = f.args[0].evaluate_array(batch)?;
    let k = match f.args.get(1) {
        Some(_) => f.literal_arg(1)?.ok_or_else(|| WhError::Execution(format!("{}() offset must not be NULL", f.func.name())))?,
        None => 1,
    };
    // look `back` rows behind (lag) or ahead (lead, or a negative lag)
    let back = if f.func == WindowFunc::Lag { k } else { -k };
    let valid = if f.ignore_nulls { Some(valid_rows(Some(&values), None, layout)?) } else { None };
    let idx = layout.for_partitions(NO_ROW, |p, out| {
        match &valid {
            None => {
                for (j, o) in out.iter_mut().enumerate() {
                    let t = (p.start + j) as i64 - back;
                    if t >= p.start as i64 && t < p.end as i64 {
                        *o = t as u32;
                    }
                }
            }
            Some(valid) => {
                let v = Valid::new(valid, &p);
                for (j, o) in out.iter_mut().enumerate() {
                    if back == 0 {
                        *o = (p.start + j) as u32;
                        continue;
                    }
                    // valid rows strictly before / at-or-before this one
                    let before = v.before[j] as i64;
                    let upto = v.before[j + 1] as i64;
                    let t = if back > 0 { before - back } else { upto - 1 - back };
                    if t >= 0 && (t as usize) < v.positions.len() {
                        *o = v.positions[t as usize] as u32;
                    }
                }
            }
        }
        Ok(())
    })?;
    let (taken, missing) = layout.gather(&values, &idx)?;
    let taken = cast(&taken, &f.out_type)?;
    match f.args.get(2) {
        None => Ok(taken),
        Some(d) => {
            let default = cast(&d.evaluate(batch)?.into_array(batch.num_rows())?, &f.out_type)?;
            Ok(zip(&BooleanArray::from(missing), &default, &taken)?)
        }
    }
}

enum Pick {
    First,
    Last,
    Nth(usize),
}

/// `first_value` / `last_value` / `nth_value` over the frame, and the
/// `first` / `last` aggregates (the first / last non-null value).
pub fn frame_value(f: &WindowFunctionExpr, batch: &arrow::record_batch::RecordBatch, layout: &Layout) -> Result<ArrayRef> {
    let values = f.args[0].evaluate_array(batch)?;
    let (pick, skip_nulls) = match f.func {
        WindowFunc::FirstValue => (Pick::First, f.ignore_nulls),
        WindowFunc::LastValue => (Pick::Last, f.ignore_nulls),
        WindowFunc::NthValue => {
            let n = f.literal_arg(1)?.ok_or_else(|| WhError::Execution("nth_value() position must not be NULL".into()))?;
            if n <= 0 {
                return Err(WhError::Execution(format!("nth_value() position must be positive, got {n}")));
            }
            (Pick::Nth(n as usize), f.ignore_nulls)
        }
        WindowFunc::Agg(AggFunc::First) => (Pick::First, true),
        WindowFunc::Agg(AggFunc::Last) => (Pick::Last, true),
        other => return Err(WhError::Execution(format!("{} is not a value function", other.name()))),
    };
    let filter = match &f.filter {
        Some(fl) => Some(fl.evaluate_array(batch)?),
        None => None,
    };
    // rows that can be picked: FILTER passed and, when skipping nulls, a value
    let valid = if skip_nulls || filter.is_some() {
        Some(valid_rows(skip_nulls.then_some(&values), filter.as_ref(), layout)?)
    } else {
        None
    };
    let keys = RangeKeys::new(layout, &f.frame)?;
    let idx = layout.for_partitions(NO_ROW, |p, out| {
        let frames = Frames::new(layout, &f.frame, keys.as_ref(), p.clone());
        let v = valid.as_ref().map(|valid| Valid::new(valid, &p));
        for (j, o) in out.iter_mut().enumerate() {
            let (s, e) = frames.bounds(p.start + j);
            if e <= s {
                continue;
            }
            let pos = match &v {
                None => match pick {
                    Pick::First => Some(s),
                    Pick::Last => Some(e - 1),
                    Pick::Nth(n) => (s + n - 1 < e).then_some(s + n - 1),
                },
                Some(v) => {
                    let (lo, hi) = (v.before[s - p.start], v.before[e - p.start]);
                    let k = match pick {
                        Pick::First => lo,
                        Pick::Last => hi.wrapping_sub(1),
                        Pick::Nth(n) => lo + n - 1,
                    };
                    (k >= lo && k < hi).then(|| v.positions[k])
                }
            };
            if let Some(pos) = pos {
                *o = pos as u32;
            }
        }
        Ok(())
    })?;
    let (taken, _) = layout.gather(&values, &idx)?;
    Ok(taken)
}
