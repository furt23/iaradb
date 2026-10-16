//! Fast, deterministic hashing used by group-by, joins and partitioning.

use std::hash::BuildHasher;

use arrow::array::*;
use arrow::datatypes::*;
use arrow::row::{RowConverter, SortField};

use crate::error::Result;

pub const SEED: u64 = 0x243F_6A88_85A3_08D3;
const K1: u64 = 0x9E37_79B9_7F4A_7C15;
const K2: u64 = 0xC2B2_AE3D_27D4_EB4F;
pub const NULL_HASH: u64 = 0x5BD1_E995_D2E3_9F17;

#[inline(always)]
pub fn folded_multiply(a: u64, b: u64) -> u64 {
    let full = (a as u128).wrapping_mul(b as u128);
    (full as u64) ^ ((full >> 64) as u64)
}

#[inline(always)]
pub fn hash_u64(v: u64) -> u64 {
    folded_multiply(v ^ SEED, K1)
}

#[inline(always)]
pub fn hash_u128(v: u128) -> u64 {
    folded_multiply((v as u64) ^ SEED, ((v >> 64) as u64) ^ K1)
}

#[inline(always)]
pub fn hash_bytes(b: &[u8]) -> u64 {
    foldhash::fast::FixedState::with_seed(SEED).hash_one(b)
}

#[inline(always)]
pub fn combine(h: u64, v: u64) -> u64 {
    folded_multiply(h ^ v.rotate_left(23), K2)
}

/// Native types usable as hash keys: mapped to a canonical bit pattern.
pub trait NativeKey: Copy + Send + Sync + 'static {
    type Key: Copy + Eq + Default + Send + Sync + std::fmt::Debug + 'static;
    fn to_key(self) -> Self::Key;
    fn hash_key(k: Self::Key) -> u64;
}

macro_rules! int_key {
    ($($t:ty),*) => {$(
        impl NativeKey for $t {
            type Key = u64;
            #[inline(always)]
            fn to_key(self) -> u64 { self as i64 as u64 }
            #[inline(always)]
            fn hash_key(k: u64) -> u64 { hash_u64(k) }
        }
    )*};
}
int_key!(i8, i16, i32, i64, u8, u16, u32, u64);

impl NativeKey for f32 {
    type Key = u64;
    #[inline(always)]
    fn to_key(self) -> u64 {
        let v = if self == 0.0 { 0.0f32 } else if self.is_nan() { f32::NAN } else { self };
        v.to_bits() as u64
    }
    #[inline(always)]
    fn hash_key(k: u64) -> u64 {
        hash_u64(k)
    }
}

impl NativeKey for f64 {
    type Key = u64;
    #[inline(always)]
    fn to_key(self) -> u64 {
        let v = if self == 0.0 { 0.0f64 } else if self.is_nan() { f64::NAN } else { self };
        v.to_bits()
    }
    #[inline(always)]
    fn hash_key(k: u64) -> u64 {
        hash_u64(k)
    }
}

impl NativeKey for i128 {
    type Key = u128;
    #[inline(always)]
    fn to_key(self) -> u128 {
        self as u128
    }
    #[inline(always)]
    fn hash_key(k: u128) -> u64 {
        hash_u128(k)
    }
}

fn hash_primitive<T>(arr: &PrimitiveArray<T>, out: &mut [u64], first: bool)
where
    T: ArrowPrimitiveType,
    T::Native: NativeKey,
{
    let values = arr.values();
    match arr.nulls().filter(|n| n.null_count() > 0) {
        None => {
            if first {
                for (o, v) in out.iter_mut().zip(values.iter()) {
                    *o = <T::Native as NativeKey>::hash_key(v.to_key());
                }
            } else {
                for (o, v) in out.iter_mut().zip(values.iter()) {
                    *o = combine(*o, <T::Native as NativeKey>::hash_key(v.to_key()));
                }
            }
        }
        Some(nulls) => {
            for (i, (o, v)) in out.iter_mut().zip(values.iter()).enumerate() {
                let h = if nulls.is_valid(i) { <T::Native as NativeKey>::hash_key(v.to_key()) } else { NULL_HASH };
                *o = if first { h } else { combine(*o, h) };
            }
        }
    }
}

fn hash_byte_iter<'a>(it: impl Iterator<Item = Option<&'a [u8]>>, out: &mut [u64], first: bool) {
    for (o, v) in out.iter_mut().zip(it) {
        let h = match v {
            Some(b) => hash_bytes(b),
            None => NULL_HASH,
        };
        *o = if first { h } else { combine(*o, h) };
    }
}

/// Hash one array into `out` (combining with existing values unless `first`).
pub fn hash_array(array: &ArrayRef, out: &mut [u64], first: bool) -> Result<()> {
    macro_rules! prim {
        ($t:ty) => {
            hash_primitive(array.as_primitive::<$t>(), out, first)
        };
    }
    match array.data_type() {
        DataType::Int8 => prim!(Int8Type),
        DataType::Int16 => prim!(Int16Type),
        DataType::Int32 => prim!(Int32Type),
        DataType::Int64 => prim!(Int64Type),
        DataType::UInt8 => prim!(UInt8Type),
        DataType::UInt16 => prim!(UInt16Type),
        DataType::UInt32 => prim!(UInt32Type),
        DataType::UInt64 => prim!(UInt64Type),
        DataType::Float32 => prim!(Float32Type),
        DataType::Float64 => prim!(Float64Type),
        DataType::Date32 => prim!(Date32Type),
        DataType::Date64 => prim!(Date64Type),
        DataType::Timestamp(TimeUnit::Second, _) => prim!(TimestampSecondType),
        DataType::Timestamp(TimeUnit::Millisecond, _) => prim!(TimestampMillisecondType),
        DataType::Timestamp(TimeUnit::Microsecond, _) => prim!(TimestampMicrosecondType),
        DataType::Timestamp(TimeUnit::Nanosecond, _) => prim!(TimestampNanosecondType),
        DataType::Decimal128(_, _) => prim!(Decimal128Type),
        DataType::Utf8 => hash_byte_iter(array.as_string::<i32>().iter().map(|v| v.map(|s| s.as_bytes())), out, first),
        DataType::LargeUtf8 => {
            hash_byte_iter(array.as_string::<i64>().iter().map(|v| v.map(|s| s.as_bytes())), out, first)
        }
        DataType::Utf8View => {
            hash_byte_iter(array.as_string_view().iter().map(|v| v.map(|s| s.as_bytes())), out, first)
        }
        DataType::Binary => hash_byte_iter(array.as_binary::<i32>().iter(), out, first),
        DataType::LargeBinary => hash_byte_iter(array.as_binary::<i64>().iter(), out, first),
        DataType::Boolean => {
            let b = array.as_boolean();
            for (i, o) in out.iter_mut().enumerate() {
                let h = if b.is_valid(i) { hash_u64(b.value(i) as u64 + 1) } else { NULL_HASH };
                *o = if first { h } else { combine(*o, h) };
            }
        }
        DataType::Null => {
            for o in out.iter_mut() {
                *o = if first { NULL_HASH } else { combine(*o, NULL_HASH) };
            }
        }
        dt => {
            let conv = RowConverter::new(vec![SortField::new(dt.clone())])?;
            let rows = conv.convert_columns(std::slice::from_ref(array))?;
            for (i, o) in out.iter_mut().enumerate() {
                let h = hash_bytes(rows.row(i).as_ref());
                *o = if first { h } else { combine(*o, h) };
            }
        }
    }
    Ok(())
}

/// Hash a set of columns row-wise.
pub fn hash_columns(cols: &[ArrayRef], out: &mut Vec<u64>) -> Result<()> {
    let n = cols.first().map(|c| c.len()).unwrap_or(0);
    out.clear();
    out.resize(n, 0);
    for (i, c) in cols.iter().enumerate() {
        hash_array(c, out, i == 0)?;
    }
    Ok(())
}
