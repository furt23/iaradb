//! Element access: `list[i]`, `len`, slices.

use std::sync::Arc;

use arrow::array::*;
use arrow::compute::take;

use super::gather::{Gather, as_list, int64, span};
use crate::error::Result;

/// `list_extract(l, i)`: 1-based, negative counts from the end, out of range is NULL.
pub fn extract(l: &ArrayRef, i: &ArrayRef) -> Result<ArrayRef> {
    let (list, idx) = (as_list(l)?, int64(i)?);
    let picks: UInt32Array = (0..list.len())
        .map(|r| {
            if list.is_null(r) || idx.is_null(r) {
                return None;
            }
            let (s, e) = span(list, r);
            let len = (e - s) as i64;
            let pos = match idx.value(r) {
                0 => return None,
                k if k > 0 => k - 1,
                k => len + k,
            };
            (0..len).contains(&pos).then(|| (s as i64 + pos) as u32)
        })
        .collect();
    Ok(take(list.values().as_ref(), &picks, None)?)
}

pub fn length(l: &ArrayRef) -> Result<ArrayRef> {
    let list = as_list(l)?;
    let lens: Vec<i64> = list.value_offsets().windows(2).map(|w| (w[1] - w[0]) as i64).collect();
    Ok(Arc::new(Int64Array::new(lens.into(), list.nulls().cloned())))
}

/// The 1-based inclusive bound `i` of a list of `len` elements, as a 0-based
/// position: negative bounds count from the end, 0 is the first element.
fn position(i: i64, len: i64) -> i64 {
    match i {
        0 => 0,
        k if k > 0 => k - 1,
        k => len + k,
    }
}

/// The inclusive end bound as a 0-based position; 0 ends before the first element.
fn end_position(i: i64, len: i64) -> i64 {
    if i == 0 { -1 } else { position(i, len) }
}

/// `list_slice(l, begin[, end])`: both bounds inclusive; NULL bound gives NULL.
pub fn slice(l: &ArrayRef, begin: &ArrayRef, end: Option<&ArrayRef>) -> Result<ArrayRef> {
    let (list, b) = (as_list(l)?, int64(begin)?);
    let e = end.map(int64).transpose()?;
    let mut g = Gather::with_capacity(list.len(), list.values().len());
    for r in 0..list.len() {
        if list.is_null(r) || b.is_null(r) || e.is_some_and(|e| e.is_null(r)) {
            g.null_row();
            continue;
        }
        let (s, f) = span(list, r);
        let len = (f - s) as i64;
        let from = position(b.value(r), len).clamp(0, len);
        let to = e.map_or(len - 1, |e| end_position(e.value(r), len)).min(len - 1);
        g.row(((s as i64 + from)..=(s as i64 + to)).filter(|_| from <= to).map(|k| k as u32));
    }
    g.finish(list.values())
}
