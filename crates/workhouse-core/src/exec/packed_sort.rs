//! Sorting on small fixed-width keys by packing them into one integer.
//!
//! Each key column is mapped to an order-preserving `u64` (complemented when
//! descending), shifted down by its minimum and given just enough bits for
//! its range plus a slot for NULL. When all keys fit next to a 32-bit row
//! index in a `u64` (or `u128`), a multi-column sort becomes a plain integer
//! sort (no comparator, no indirection), ties keep their input order, and
//! runs of equal keys can be read straight off the sorted words.

use std::ops::{BitOr, Shl, Shr};

use arrow::array::{Array, ArrayRef, AsArray, PrimitiveArray};
use arrow::compute::SortOptions;
use arrow::datatypes::*;
use rayon::prelude::*;

const MIN_LEN: usize = 1 << 14;

trait Word: Copy + Ord + Send + Sync + From<u64> + Shl<u32, Output = Self> + Shr<u32, Output = Self> + BitOr<Output = Self> {
    fn low32(self) -> u32;
}

impl Word for u64 {
    fn low32(self) -> u32 {
        self as u32
    }
}

impl Word for u128 {
    fn low32(self) -> u32 {
        self as u32
    }
}

enum Words {
    U64(Vec<u64>),
    U128(Vec<u128>),
}

pub struct PackedSort {
    /// sorted position -> input row
    pub perm: Vec<u32>,
    words: Words,
    /// bits taken by each key, in key order
    bits: Vec<u32>,
}

impl PackedSort {
    /// `true` at each sorted position whose first `n_keys` keys differ from
    /// the previous position's.
    pub fn breaks(&self, n_keys: usize) -> Vec<bool> {
        let total: u32 = self.bits.iter().sum();
        let used: u32 = self.bits[..n_keys].iter().sum();
        if used == 0 {
            return vec![false; self.perm.len()];
        }
        let shift = 32 + total - used;
        match &self.words {
            Words::U64(w) => breaks(w, shift),
            Words::U128(w) => breaks(w, shift),
        }
    }
}

fn breaks<W: Word>(w: &[W], shift: u32) -> Vec<bool> {
    (0..w.len()).into_par_iter().with_min_len(MIN_LEN).map(|i| i > 0 && (w[i] >> shift) != (w[i - 1] >> shift)).collect()
}

/// Sort `keys` (stable), or `None` when they cannot be packed: a type that
/// is not fixed-width, more than 96 key bits, or 2^32 rows or more.
pub fn sort(keys: &[ArrayRef], opts: &[SortOptions]) -> Option<PackedSort> {
    let n = keys.first()?.len();
    if n >= u32::MAX as usize {
        return None;
    }
    let codes = keys.iter().zip(opts).map(|(k, o)| encode(k, *o)).collect::<Option<Vec<_>>>()?;
    let bits: Vec<u32> = codes.iter().map(|c| c.1).collect();
    let total: u32 = bits.iter().sum();
    let (perm, words) = if total <= 32 {
        let w = pack::<u64>(&codes, n);
        (w.par_iter().with_min_len(MIN_LEN).map(|x| x.low32()).collect(), Words::U64(w))
    } else if total <= 96 {
        let w = pack::<u128>(&codes, n);
        (w.par_iter().with_min_len(MIN_LEN).map(|x| x.low32()).collect(), Words::U128(w))
    } else {
        return None;
    };
    Some(PackedSort { perm, words, bits })
}

fn pack<W: Word>(codes: &[(Vec<u64>, u32)], n: usize) -> Vec<W> {
    let mut w: Vec<W> = (0..n)
        .into_par_iter()
        .with_min_len(MIN_LEN)
        .map(|i| {
            let mut acc = W::from(0u64);
            for (c, bits) in codes {
                if *bits > 0 {
                    acc = (acc << *bits) | W::from(c[i]);
                }
            }
            (acc << 32) | W::from(i as u64)
        })
        .collect();
    if n > 1 << 15 {
        w.par_sort_unstable();
    } else {
        w.sort_unstable();
    }
    w
}

/// Order-preserving codes of one key and the bits they need.
fn encode(a: &ArrayRef, opts: SortOptions) -> Option<(Vec<u64>, u32)> {
    let mut v = ordered(a)?;
    if a.null_count() == a.len() {
        return Some((vec![0; a.len()], 0));
    }
    if opts.descending {
        v.par_iter_mut().with_min_len(MIN_LEN).for_each(|x| *x = !*x);
    }
    let nulls = a.nulls();
    let valid = |i: usize| nulls.is_none_or(|n| n.is_valid(i));
    let (min, max) = v
        .par_iter()
        .enumerate()
        .with_min_len(MIN_LEN)
        .filter(|(i, _)| valid(*i))
        .map(|(_, &x)| (x, x))
        .reduce(|| (u64::MAX, 0), |a, b| (a.0.min(b.0), a.1.max(b.1)));
    let has_nulls = a.null_count() > 0;
    let range = max - min;
    let top = range as u128 + has_nulls as u128;
    if top > u64::MAX as u128 {
        return None;
    }
    let (null_code, offset) = if opts.nulls_first { (0, has_nulls as u64) } else { (range + 1, 0) };
    if has_nulls {
        v.par_iter_mut().enumerate().with_min_len(MIN_LEN).for_each(|(i, x)| {
            *x = if valid(i) { *x - min + offset } else { null_code };
        });
    } else {
        v.par_iter_mut().with_min_len(MIN_LEN).for_each(|x| *x -= min);
    }
    Some((v, 128 - top.leading_zeros()))
}

/// The key as `u64`s whose unsigned order is the key's order.
fn ordered(a: &ArrayRef) -> Option<Vec<u64>> {
    fn map<T: ArrowPrimitiveType>(a: &PrimitiveArray<T>, f: impl Fn(T::Native) -> u64 + Sync) -> Vec<u64> {
        a.values().par_iter().with_min_len(MIN_LEN).map(|&v| f(v)).collect()
    }
    macro_rules! int {
        ($t:ty) => {
            map(a.as_primitive::<$t>(), |v| (v as i64 as u64) ^ (1 << 63))
        };
    }
    macro_rules! uint {
        ($t:ty) => {
            map(a.as_primitive::<$t>(), |v| v as u64)
        };
    }
    use DataType::*;
    Some(match a.data_type() {
        Int8 => int!(Int8Type),
        Int16 => int!(Int16Type),
        Int32 => int!(Int32Type),
        Int64 => int!(Int64Type),
        UInt8 => uint!(UInt8Type),
        UInt16 => uint!(UInt16Type),
        UInt32 => uint!(UInt32Type),
        UInt64 => uint!(UInt64Type),
        Date32 => int!(Date32Type),
        Date64 => int!(Date64Type),
        Timestamp(TimeUnit::Second, _) => int!(TimestampSecondType),
        Timestamp(TimeUnit::Millisecond, _) => int!(TimestampMillisecondType),
        Timestamp(TimeUnit::Microsecond, _) => int!(TimestampMicrosecondType),
        Timestamp(TimeUnit::Nanosecond, _) => int!(TimestampNanosecondType),
        Float32 => map(a.as_primitive::<Float32Type>(), |v| float_bits(v as f64)),
        Float64 => map(a.as_primitive::<Float64Type>(), float_bits),
        Boolean => {
            let b = a.as_boolean().values();
            (0..b.len()).into_par_iter().with_min_len(MIN_LEN).map(|i| b.value(i) as u64).collect()
        }
        _ => return None,
    })
}

/// IEEE total order as unsigned integers (what arrow's sort kernels use).
fn float_bits(v: f64) -> u64 {
    let b = v.to_bits();
    if b >> 63 == 1 { !b } else { b | (1 << 63) }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use arrow::array::{Float64Array, Int32Array, StringArray};

    use super::*;
    use crate::exec::sort::sort_indices;

    fn check(keys: Vec<ArrayRef>, opts: Vec<SortOptions>) {
        let packed = sort(&keys, &opts).expect("packable");
        let fields = keys.iter().zip(&opts).map(|(k, o)| arrow::row::SortField::new_with_options(k.data_type().clone(), *o));
        let rows = arrow::row::RowConverter::new(fields.collect()).unwrap().convert_columns(&keys).unwrap();
        let mut expected: Vec<u32> = (0..keys[0].len() as u32).collect();
        expected.sort_by(|&a, &b| rows.row(a as usize).cmp(&rows.row(b as usize)).then(a.cmp(&b)));
        assert_eq!(packed.perm, expected);
        let brk = packed.breaks(keys.len());
        for i in 1..expected.len() {
            assert_eq!(brk[i], rows.row(expected[i] as usize) != rows.row(expected[i - 1] as usize));
        }
    }

    #[test]
    fn matches_row_format_order() {
        let extremes: ArrayRef = Arc::new(Int32Array::from(vec![Some(3), None, Some(i32::MAX), Some(i32::MIN)]));
        let a: ArrayRef = Arc::new(Int32Array::from(vec![Some(3), None, Some(-7), Some(3), Some(900), None, Some(-900)]));
        let b: ArrayRef = Arc::new(Float64Array::from(vec![Some(1.5), Some(-0.0), None, Some(f64::NAN), Some(-2.0), Some(1.5), Some(0.0)]));
        for desc in [false, true] {
            for nulls_first in [false, true] {
                let o = SortOptions { descending: desc, nulls_first };
                check(vec![extremes.clone()], vec![o]);
                check(vec![a.clone()], vec![o]);
                check(vec![a.clone(), b.clone()], vec![o, SortOptions { descending: !desc, nulls_first: !nulls_first }]);
            }
        }
    }

    #[test]
    fn falls_back_for_strings_and_wide_keys() {
        let s: ArrayRef = Arc::new(StringArray::from(vec!["b", "a"]));
        assert!(sort(&[s], &[SortOptions::default()]).is_none());
        let wide: ArrayRef = Arc::new(Float64Array::from(vec![1.0, -1.0]));
        assert!(sort(&[wide.clone(), wide], &[SortOptions::default(); 2]).is_none());
        let keys: Vec<ArrayRef> = vec![Arc::new(Int32Array::from(vec![2, 1, 2]))];
        assert_eq!(sort_indices(&keys, &[SortOptions::default()], None).unwrap(), vec![1, 0, 2]);
    }
}
