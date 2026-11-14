//! The running bound of a top k (`ORDER BY x LIMIT k`). Once a worker of
//! the sort holds k rows, a row whose first key sorts after its k-th one
//! cannot be in the result: k rows come before it. The sort tightens the
//! bound as it goes, and drops such rows before buffering them; a Parquet
//! scan under it drops them while decoding (the other columns of those rows
//! are never decoded) and skips row groups whose statistics are all past it.
//!
//! Keys are compared as order-preserving `i64` ordinals: integers, dates,
//! times and timestamps as they are, floats by their total order bits,
//! strings by their first 8 bytes. Strings that differ later share an
//! ordinal; the bound keeps the rows that tie with it, so that only costs
//! rows it could have dropped.

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

use arrow::array::{Array, ArrayRef, AsArray, BooleanArray};
use arrow::buffer::BooleanBuffer;
use arrow::datatypes::*;

#[derive(Debug)]
pub struct TopKBound {
    pub descending: bool,
    pub nulls_first: bool,
    /// the bound's ordinal, meaningful once `set`
    value: AtomicI64,
    set: AtomicBool,
}

/// Order-preserving ordinal of an `f64` (the order of `f64::total_cmp`).
fn f64_ordinal(x: f64) -> i64 {
    let b = x.to_bits() as i64;
    b ^ (((b >> 63) as u64) >> 1) as i64
}

fn f32_ordinal(x: f32) -> i64 {
    let b = x.to_bits() as i32;
    (b ^ (((b >> 31) as u32) >> 1) as i32) as i64
}

/// `$body` with `$v` bound to the values of a key array and `$conv` to the
/// map of a value to its ordinal; `$none` for key types without ordinals.
macro_rules! with_ordinals {
    ($a:expr, $v:ident, $conv:ident, $body:expr, $none:expr) => {{
        macro_rules! go {
            ($t:ty, $f:expr) => {{
                let $v = $a.as_primitive::<$t>().values();
                let $conv = $f;
                $body
            }};
        }
        match $a.data_type() {
            DataType::Int8 => go!(Int8Type, |x: i8| x as i64),
            DataType::Int16 => go!(Int16Type, |x: i16| x as i64),
            DataType::Int32 => go!(Int32Type, |x: i32| x as i64),
            DataType::Int64 => go!(Int64Type, |x: i64| x),
            DataType::UInt8 => go!(UInt8Type, |x: u8| x as i64),
            DataType::UInt16 => go!(UInt16Type, |x: u16| x as i64),
            DataType::UInt32 => go!(UInt32Type, |x: u32| x as i64),
            DataType::Date32 => go!(Date32Type, |x: i32| x as i64),
            DataType::Date64 => go!(Date64Type, |x: i64| x),
            DataType::Time32(TimeUnit::Second) => go!(Time32SecondType, |x: i32| x as i64),
            DataType::Time32(TimeUnit::Millisecond) => go!(Time32MillisecondType, |x: i32| x as i64),
            DataType::Time64(TimeUnit::Microsecond) => go!(Time64MicrosecondType, |x: i64| x),
            DataType::Time64(TimeUnit::Nanosecond) => go!(Time64NanosecondType, |x: i64| x),
            DataType::Timestamp(TimeUnit::Second, _) => go!(TimestampSecondType, |x: i64| x),
            DataType::Timestamp(TimeUnit::Millisecond, _) => go!(TimestampMillisecondType, |x: i64| x),
            DataType::Timestamp(TimeUnit::Microsecond, _) => go!(TimestampMicrosecondType, |x: i64| x),
            DataType::Timestamp(TimeUnit::Nanosecond, _) => go!(TimestampNanosecondType, |x: i64| x),
            DataType::Float32 => go!(Float32Type, f32_ordinal),
            DataType::Float64 => go!(Float64Type, f64_ordinal),
            _ => $none,
        }
    }};
}

/// Order-preserving ordinal of 8 bytes read as a big-endian number.
fn bytes_ordinal(b: u64) -> i64 {
    (b ^ (1 << 63)) as i64
}

/// The ordinal of a string: its first 8 bytes, zeros past its end.
fn prefix_ordinal(s: &[u8]) -> i64 {
    let mut b = [0u8; 8];
    let n = s.len().min(8);
    b[..n].copy_from_slice(&s[..n]);
    bytes_ordinal(u64::from_be_bytes(b))
}

/// [`map_ordinals`] for strings. `f` must be a threshold (true up to, or
/// from, some ordinal): a long string of a view array is read only when
/// the 4 bytes its view holds do not decide.
fn map_prefixes(a: &dyn Array, f: impl Fn(i64) -> bool) -> Option<BooleanBuffer> {
    match a.data_type() {
        DataType::Utf8View => {
            let a = a.as_string_view();
            let views = a.views();
            Some(BooleanBuffer::collect_bool(views.len(), |i| {
                // after the length: a string of up to 12 bytes (zeros past its
                // end), else its first 4 bytes and where the rest is
                let head = u64::from_be_bytes(views[i].to_le_bytes()[4..12].try_into().unwrap());
                if views[i] as u32 <= 12 {
                    return f(bytes_ordinal(head));
                }
                let low = f(bytes_ordinal(head & !0xFFFF_FFFF));
                if low == f(bytes_ordinal(head | 0xFFFF_FFFF)) { low } else { a.is_valid(i) && f(prefix_ordinal(a.value(i).as_bytes())) }
            }))
        }
        DataType::Utf8 => {
            let a = a.as_string::<i32>();
            Some(BooleanBuffer::collect_bool(a.len(), |i| f(prefix_ordinal(a.value(i).as_bytes()))))
        }
        DataType::LargeUtf8 => {
            let a = a.as_string::<i64>();
            Some(BooleanBuffer::collect_bool(a.len(), |i| f(prefix_ordinal(a.value(i).as_bytes()))))
        }
        _ => None,
    }
}

fn prefix_at(a: &dyn Array, i: usize) -> Option<i64> {
    let s = match a.data_type() {
        DataType::Utf8View => a.as_string_view().value(i),
        DataType::Utf8 => a.as_string::<i32>().value(i),
        DataType::LargeUtf8 => a.as_string::<i64>().value(i),
        _ => return None,
    };
    Some(prefix_ordinal(s.as_bytes()))
}

/// `f(ordinal)` for every row of a key array (any value for NULL rows), as
/// a boolean buffer; None for key types without ordinals. `f` must be a
/// threshold (see [`map_prefixes`]).
fn map_ordinals(a: &dyn Array, f: impl Fn(i64) -> bool) -> Option<BooleanBuffer> {
    with_ordinals!(a, v, conv, Some(BooleanBuffer::collect_bool(v.len(), |i| f(conv(v[i])))), map_prefixes(a, f))
}

/// The ordinal of row `i` of a key array (None: NULL or no ordinal).
pub fn ordinal_at(a: &dyn Array, i: usize) -> Option<i64> {
    if a.is_null(i) {
        return None;
    }
    with_ordinals!(a, v, conv, Some(conv(v[i])), prefix_at(a, i))
}

impl TopKBound {
    pub fn new(descending: bool, nulls_first: bool) -> Self {
        let start = if descending { i64::MIN } else { i64::MAX };
        Self { descending, nulls_first, value: AtomicI64::new(start), set: AtomicBool::new(false) }
    }

    /// Whether sort keys of this type have ordinals.
    pub fn supports(dt: &DataType) -> bool {
        map_ordinals(arrow::array::new_empty_array(dt).as_ref(), |_| true).is_some()
    }

    /// The bound's ordinal, once some worker held k rows.
    pub fn get(&self) -> Option<i64> {
        self.set.load(Ordering::Acquire).then(|| self.value.load(Ordering::Relaxed))
    }

    /// Offer the first key of a worker's k-th row (row `i` of `keys`): the
    /// bound moves to it if it is tighter.
    pub fn offer(&self, keys: &dyn Array, i: usize) {
        // a NULL k-th key bounds nothing the ordinals can express
        let Some(o) = ordinal_at(keys, i) else { return };
        if self.descending {
            self.value.fetch_max(o, Ordering::Relaxed);
        } else {
            self.value.fetch_min(o, Ordering::Relaxed);
        }
        self.set.store(true, Ordering::Release);
    }

    /// Whether a key with this ordinal can still be in the top k.
    fn keeps(&self, bound: i64, o: i64) -> bool {
        if self.descending { o >= bound } else { o <= bound }
    }

    /// The rows of `keys` that can still be in the top k (None: all can).
    pub fn mask(&self, keys: &ArrayRef) -> Option<BooleanArray> {
        let bound = self.get()?;
        let values = map_ordinals(keys.as_ref(), |o| self.keeps(bound, o))?;
        // NULL keys sort first (always kept) or last (never kept)
        let values = match keys.logical_nulls() {
            Some(n) if self.nulls_first => &values | &!n.inner(),
            Some(n) => &values & n.inner(),
            None => values,
        };
        Some(BooleanArray::new(values, None))
    }

    /// Whether a row group whose values lie between the ordinals `min` and
    /// `max` (with NULLs or not) can hold a row of the top k.
    pub fn may_hold(&self, min: i64, max: i64, has_nulls: bool) -> bool {
        let Some(bound) = self.get() else { return true };
        (has_nulls && self.nulls_first) || self.keeps(bound, if self.descending { max } else { min })
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn ordinals_keep_the_order() {
        let f = Float64Array::from(vec![-f64::INFINITY, -2.5, -0.0, 0.0, 1.0, f64::INFINITY, f64::NAN]);
        let o: Vec<i64> = (0..f.len()).map(|i| ordinal_at(&f, i).unwrap()).collect();
        assert!(o.windows(2).all(|w| w[0] < w[1]), "{o:?}");
        let t = TimestampMicrosecondArray::from(vec![-5, 7]);
        assert_eq!(ordinal_at(&t, 0), Some(-5));
        assert_eq!(ordinal_at(&t, 1), Some(7));
        assert_eq!(ordinal_at(&arrow::array::BooleanArray::from(vec![true]), 0), None);
    }

    use arrow::array::{Float64Array, Int64Array, StringArray, StringViewArray, TimestampMicrosecondArray};

    #[test]
    fn strings_are_bounded_by_their_first_bytes() {
        // sorted; the long ones share 4 bytes (what a view holds), two of them 8
        let texts = vec!["", "a", "ab", "abcdefgh", "abcdefgh-1", "abcdefgh-2 and more than a view holds", "abcdzzzzzzzzzzzzz", "b", "é"];
        let views: ArrayRef = Arc::new(StringViewArray::from(texts.clone()));
        let plain: ArrayRef = Arc::new(StringArray::from(texts.clone()));
        let ords: Vec<i64> = (0..texts.len()).map(|i| ordinal_at(&views, i).unwrap()).collect();
        assert!(ords.windows(2).all(|w| w[0] <= w[1]), "{ords:?}");
        assert_eq!(ords, (0..texts.len()).map(|i| ordinal_at(&plain, i).unwrap()).collect::<Vec<_>>());
        for (k, desc) in (0..texts.len()).flat_map(|k| [(k, false), (k, true)]) {
            let b = TopKBound::new(desc, false);
            b.offer(&views, k);
            // every row at or before the bound is kept; ties on 8 bytes too
            let want: Vec<bool> = ords.iter().map(|&o| if desc { o >= ords[k] } else { o <= ords[k] }).collect();
            for keys in [&views, &plain] {
                let m = b.mask(keys).unwrap();
                assert_eq!(m.iter().map(|v| v.unwrap()).collect::<Vec<_>>(), want, "bound {:?} desc {desc}", texts[k]);
            }
        }
        let nulls: ArrayRef = Arc::new(StringViewArray::from(vec![None, Some("abcdefgh-2 and more than a view holds")]));
        let b = TopKBound::new(false, false);
        b.offer(&views, 4);
        assert_eq!(b.mask(&nulls).unwrap().iter().map(|v| v.unwrap()).collect::<Vec<_>>(), vec![false, true]);
    }

    #[test]
    fn bound_masks_rows_past_it() {
        let b = TopKBound::new(false, false);
        let keys: ArrayRef = Arc::new(Int64Array::from(vec![Some(5), None, Some(1), Some(9)]));
        assert!(b.mask(&keys).is_none());
        b.offer(&Int64Array::from(vec![6]), 0);
        b.offer(&Int64Array::from(vec![8]), 0); // looser: ignored
        let m = b.mask(&keys).unwrap();
        assert_eq!(m.iter().map(|v| v.unwrap()).collect::<Vec<_>>(), vec![true, false, true, false]);
        assert!(b.may_hold(6, 10, false));
        assert!(!b.may_hold(7, 10, false));
        let d = TopKBound::new(true, true);
        d.offer(&Int64Array::from(vec![5]), 0);
        let m = d.mask(&keys).unwrap();
        assert_eq!(m.iter().map(|v| v.unwrap()).collect::<Vec<_>>(), vec![true, true, false, true]);
        assert!(d.may_hold(0, 4, true));
        assert!(!d.may_hold(0, 4, false));
    }
}
