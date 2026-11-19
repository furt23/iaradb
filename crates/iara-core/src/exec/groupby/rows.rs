//! Multi-column keys as one encoded row each, for keys too wide for the
//! packed words of [`super::packed`]: many columns, or several strings.
//!
//! A row is the columns' NULL bits, then the fixed-width values (floats by
//! their canonical bits, so `-0.0` meets `0.0` and NaN meets NaN, as the
//! column interners compare them), then each variable-width value as its
//! length and its bytes. Equal keys are equal rows, so a lookup is one probe
//! and one comparison of bytes.
//!
//! The table keeps each group's row and its hash, which is
//! [`hash_columns`] of the key columns: the hash the aggregation partitions
//! rows by. A table is so merged into another, or split among partitions, by
//! copying rows ([`RowKeys::intern_from`]), without decoding, hashing or
//! comparing their values again. Interning the columns one by one and then
//! the tuple of their ids (`Composite::Many`) probes a table per column, and
//! its merge emits every group's strings to intern them again.

use std::sync::Arc;

use arrow::array::*;
use arrow::buffer::{BooleanBuffer, NullBuffer, ScalarBuffer};
use arrow::datatypes::*;

use super::bytes_array;
use super::table::{IdTable, PREFETCH_AHEAD};
use crate::error::Result;
use crate::hash::{NativeKey, hash_columns};

/// Where a key column is in a row.
#[derive(Clone, Copy, Debug)]
enum Place {
    /// `width` bytes at `at`
    Fixed { at: usize, width: usize },
    /// a `u32` length and the bytes, after the fixed part, in [`RowKeys::vars`] order
    Var,
}

/// Bytes of a fixed-width value (`None`: variable width, or not supported).
fn fixed_width(dt: &DataType) -> Option<usize> {
    Some(match dt {
        DataType::Boolean | DataType::Int8 | DataType::UInt8 => 1,
        DataType::Int16 | DataType::UInt16 => 2,
        DataType::Int32 | DataType::UInt32 | DataType::Float32 | DataType::Date32 => 4,
        DataType::Int64 | DataType::UInt64 | DataType::Float64 | DataType::Date64 | DataType::Timestamp(_, _) => 8,
        DataType::Decimal128(_, _) => 16,
        _ => return None,
    })
}

fn variable(dt: &DataType) -> bool {
    matches!(dt, DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View | DataType::Binary | DataType::LargeBinary | DataType::BinaryView)
}

/// Whether keys of these columns can be kept as rows.
pub fn supports(types: &[DataType]) -> bool {
    types.len() <= 64 && types.iter().all(|t| fixed_width(t).is_some() || variable(t))
}

/// The bytes of value `i` of a variable-width array, and their length.
trait Bytes {
    fn bytes(&self, i: usize) -> &[u8];
    fn len_of(&self, i: usize) -> usize;
}

impl<T: ByteArrayType> Bytes for GenericByteArray<T> {
    #[inline(always)]
    fn bytes(&self, i: usize) -> &[u8] {
        let offsets = self.value_offsets();
        &self.value_data()[offsets[i].as_usize()..offsets[i + 1].as_usize()]
    }
    #[inline(always)]
    fn len_of(&self, i: usize) -> usize {
        let offsets = self.value_offsets();
        (offsets[i + 1] - offsets[i]).as_usize()
    }
}

impl<T: ByteViewType + ?Sized> Bytes for GenericByteViewArray<T> {
    #[inline(always)]
    fn bytes(&self, i: usize) -> &[u8] {
        // SAFETY: callers ask for `i` below the array's length
        unsafe { self.value_unchecked(i).as_ref() }
    }
    #[inline(always)]
    fn len_of(&self, i: usize) -> usize {
        self.views()[i] as u32 as usize
    }
}

/// Run `$body` with `$arr` bound to `$a` as its concrete variable-width array type.
macro_rules! with_bytes {
    ($a:expr, |$arr:ident| $body:expr) => {
        match $a.data_type() {
            DataType::Utf8 => {
                let $arr = $a.as_string::<i32>();
                $body
            }
            DataType::LargeUtf8 => {
                let $arr = $a.as_string::<i64>();
                $body
            }
            DataType::Utf8View => {
                let $arr = $a.as_string_view();
                $body
            }
            DataType::Binary => {
                let $arr = $a.as_binary::<i32>();
                $body
            }
            DataType::LargeBinary => {
                let $arr = $a.as_binary::<i64>();
                $body
            }
            DataType::BinaryView => {
                let $arr = $a.as_binary_view();
                $body
            }
            dt => unreachable!("not a variable-width type: {dt}"),
        }
    };
}

/// Rows encoded at a time before they are looked up.
const ENCODE_ROWS: usize = 512;

pub struct RowKeys {
    /// where each key column is
    places: Vec<Place>,
    /// the variable-width columns, in the order their values follow the fixed part
    vars: Vec<usize>,
    /// bytes of a row's NULL bits: 1, 2, 4 or 8 (a key has 64 columns at most)
    null_bytes: usize,
    /// bytes of a row before its variable-width values: NULL bits and fixed-width values
    fixed: usize,
    map: IdTable<u64>,
    /// the rows of the groups, one after the other
    data: Vec<u8>,
    /// where group `g`'s row starts (and, at `g + 1`, ends)
    offsets: Vec<usize>,
    /// the hash of each group's key
    hashes: Vec<u64>,
    /// scratch: a batch's rows, where each starts, and their hashes
    rows: Vec<u8>,
    starts: Vec<usize>,
    row_hashes: Vec<u64>,
    bits: Vec<u64>,
}

impl RowKeys {
    /// Keys of columns of these types (see [`supports`]).
    pub fn new(types: &[DataType]) -> Self {
        let null_bytes = types.len().div_ceil(8).next_power_of_two();
        let mut at = null_bytes;
        let mut vars = vec![];
        let places = types
            .iter()
            .enumerate()
            .map(|(j, t)| match fixed_width(t) {
                Some(width) => {
                    at += width;
                    Place::Fixed { at: at - width, width }
                }
                None => {
                    vars.push(j);
                    Place::Var
                }
            })
            .collect();
        Self {
            places,
            vars,
            null_bytes,
            fixed: at,
            map: IdTable::new(),
            data: vec![],
            offsets: vec![0],
            hashes: vec![],
            rows: vec![],
            starts: vec![],
            row_hashes: vec![],
            bits: vec![],
        }
    }

    pub fn len(&self) -> usize {
        self.hashes.len()
    }

    /// The hash of each group's key: [`hash_columns`] of its key columns.
    pub fn hashes(&self) -> &[u64] {
        &self.hashes
    }

    fn row(&self, g: usize) -> &[u8] {
        &self.data[self.offsets[g]..self.offsets[g + 1]]
    }

    /// Pre-size for about `n` groups in all.
    pub fn reserve(&mut self, n: usize) {
        self.map.reserve(n, |&e| e);
        let more = n.saturating_sub(self.len());
        self.hashes.reserve(more);
        self.offsets.reserve(more);
        self.data.reserve(more * self.fixed);
    }

    /// The id of the key of `row`, hashing to `h` (a new group if it is new).
    #[inline(always)]
    fn lookup(&mut self, h: u64, row: &[u8]) -> u32 {
        let (data, offsets) = (&self.data, &self.offsets);
        let found = self.map.find(h, |&e, g| e == h && &data[offsets[g as usize]..offsets[g as usize + 1]] == row);
        match found {
            Ok(id) => id,
            Err(slot) => {
                let id = self.hashes.len() as u32;
                self.data.extend_from_slice(row);
                self.offsets.push(self.data.len());
                self.hashes.push(h);
                self.map.insert(slot, h, h, id, |&e| e);
                id
            }
        }
    }

    /// Map every row of `cols` to the id of its key (appending unseen keys);
    /// rows that `mask` leaves out map to `u32::MAX`.
    pub fn intern(&mut self, cols: &[ArrayRef], mask: Option<&BooleanBuffer>, out: &mut Vec<u32>) -> Result<()> {
        let mut hashes = std::mem::take(&mut self.row_hashes);
        hash_columns(cols, &mut hashes)?;
        let interned = self.intern_hashed(cols, &hashes, mask, out);
        self.row_hashes = hashes;
        interned
    }

    /// [`Self::intern`] given each row's [`hash_columns`] value of `cols`.
    pub fn intern_hashed(&mut self, cols: &[ArrayRef], hashes: &[u64], mask: Option<&BooleanBuffer>, out: &mut Vec<u32>) -> Result<()> {
        let n = cols.first().map_or(0, |c| c.len());
        debug_assert_eq!(hashes.len(), n);
        out.clear();
        out.reserve(n);
        let large = self.map.large();
        // rows are encoded a chunk at a time, so that they are still in cache when looked up
        for from in (0..n).step_by(ENCODE_ROWS) {
            let len = ENCODE_ROWS.min(n - from);
            let chunk: Vec<ArrayRef> = cols.iter().map(|c| c.slice(from, len)).collect();
            self.encode(&chunk, len);
            let (rows, starts) = (std::mem::take(&mut self.rows), std::mem::take(&mut self.starts));
            for i in 0..len {
                let at = from + i;
                if large {
                    if let Some(&a) = hashes.get(at + PREFETCH_AHEAD) {
                        self.map.prefetch(a);
                    }
                }
                if mask.is_some_and(|m| !m.value(at)) {
                    out.push(u32::MAX);
                    continue;
                }
                out.push(self.lookup(hashes[at], &rows[starts[i]..starts[i + 1]]));
            }
            (self.rows, self.starts) = (rows, starts);
        }
        Ok(())
    }

    /// The ids here of groups `groups` of `other` (all of them, in order, for
    /// `None`), a table of the same key types: their rows and hashes are
    /// copied, nothing is decoded or hashed again.
    pub fn intern_from(&mut self, other: &RowKeys, groups: Option<&[u32]>, out: &mut Vec<u32>) {
        let n = groups.map_or(other.len(), |g| g.len());
        let group = |i: usize| groups.map_or(i, |g| g[i] as usize);
        out.clear();
        out.reserve(n);
        let large = self.map.large();
        for i in 0..n {
            if i + PREFETCH_AHEAD < n {
                let ahead = group(i + PREFETCH_AHEAD);
                // the other's row, read when its key is new here or compared (groups taken out of order miss)
                super::table::prefetch(other.data.as_ptr().wrapping_add(other.offsets[ahead]));
                if large {
                    self.map.prefetch(other.hashes[ahead]);
                }
            }
            let g = group(i);
            out.push(self.lookup(other.hashes[g], other.row(g)));
        }
    }

    /// Encode the `n` rows of `cols` into `self.rows`, row `i` starting at `self.starts[i]`.
    fn encode(&mut self, cols: &[ArrayRef], n: usize) {
        let (rows, starts) = (&mut self.rows, &mut self.starts);
        // each row's length, then where it starts
        starts.clear();
        starts.resize(n + 1, self.fixed);
        for &j in &self.vars {
            let a = &cols[j];
            let nulls = a.nulls().filter(|x| x.null_count() > 0);
            with_bytes!(a, |arr| {
                for (i, len) in starts[..n].iter_mut().enumerate() {
                    *len += 4 + if nulls.is_some_and(|x| x.is_null(i)) { 0 } else { arr.len_of(i) };
                }
            });
        }
        let mut at = 0;
        for s in starts.iter_mut() {
            let len = *s;
            *s = at;
            at += len;
        }
        // every byte of a row is written below: what the buffer held before is not cleared
        if rows.len() < starts[n] {
            rows.resize(starts[n], 0);
        }
        // NULL bits (a NULL's value is written as zeros), as one word of `null_bytes` bytes
        let mut bits = std::mem::take(&mut self.bits);
        bits.clear();
        bits.resize(n, 0);
        for (j, c) in cols.iter().enumerate() {
            let Some(nulls) = c.nulls().filter(|x| x.null_count() > 0) else { continue };
            for i in nulls.iter().enumerate().filter(|(_, valid)| !valid).map(|(i, _)| i) {
                bits[i] |= 1 << j;
            }
        }
        let null_bytes = self.null_bytes;
        macro_rules! put_bits {
            ($n:literal) => {
                for (&s, &b) in starts[..n].iter().zip(&bits) {
                    rows[s..s + $n].copy_from_slice(&b.to_le_bytes()[..$n]);
                }
            };
        }
        match null_bytes {
            1 => put_bits!(1),
            2 => put_bits!(2),
            4 => put_bits!(4),
            _ => put_bits!(8),
        }
        self.bits = bits;
        for (j, place) in self.places.iter().enumerate() {
            if let Place::Fixed { at, .. } = *place {
                write_fixed(rows, &starts[..n], at, &cols[j]);
            }
        }
        if self.vars.is_empty() {
            return;
        }
        let mut cursor: Vec<usize> = starts[..n].iter().map(|&s| s + self.fixed).collect();
        for &j in &self.vars {
            let a = &cols[j];
            let nulls = a.nulls().filter(|x| x.null_count() > 0);
            with_bytes!(a, |arr| {
                for (i, c) in cursor.iter_mut().enumerate() {
                    let b: &[u8] = if nulls.is_some_and(|x| x.is_null(i)) { &[] } else { arr.bytes(i) };
                    let dst = &mut rows[*c..*c + 4 + b.len()];
                    dst[..4].copy_from_slice(&(b.len() as u32).to_le_bytes());
                    copy_bytes(&mut dst[4..], b);
                    *c += 4 + b.len();
                }
            });
        }
    }

    /// The key columns of all groups (in id order), of types `types`. The rows are read
    /// a block of groups at a time, column by column within the block: a pass per column
    /// over all the rows would read each row once per column from memory, and a row at a
    /// time would switch between the columns' types at every value.
    pub fn emit(&self, types: &[DataType]) -> Result<Vec<ArrayRef>> {
        let all = vec![true; types.len()];
        Ok(self.emit_some(types, &all)?.into_iter().map(|c| c.expect("every column decoded")).collect())
    }

    /// The key columns `wanted` marks, of all groups (`None` for the others).
    pub fn emit_some(&self, types: &[DataType], wanted: &[bool]) -> Result<Vec<Option<ArrayRef>>> {
        let n = self.len();
        let (data, offsets) = (&self.data, &self.offsets[..n]);
        let mut bits: Vec<u64> = Vec::with_capacity(n);
        let mut lanes: Vec<Lane> = self
            .places
            .iter()
            .zip(wanted)
            .map(|(p, &w)| match *p {
                _ if !w => Lane::Skip,
                Place::Fixed { width: 1, .. } => Lane::W1(Vec::with_capacity(n)),
                Place::Fixed { width: 2, .. } => Lane::W2(Vec::with_capacity(n)),
                Place::Fixed { width: 4, .. } => Lane::W4(Vec::with_capacity(n)),
                Place::Fixed { width: 8, .. } => Lane::W8(Vec::with_capacity(n)),
                Place::Fixed { .. } => Lane::W16(Vec::with_capacity(n)),
                Place::Var => Lane::Var(Vec::with_capacity(data.len() / types.len().max(1)), {
                    let mut ends = Vec::with_capacity(n + 1);
                    ends.push(0);
                    ends
                }),
            })
            .collect();
        let mut cursor: Vec<usize> = Vec::with_capacity(EMIT_GROUPS);
        for block in offsets.chunks(EMIT_GROUPS) {
            match self.null_bytes {
                1 => bits.extend(block.iter().map(|&o| data[o] as u64)),
                2 => bits.extend(block.iter().map(|&o| u16::from_le_bytes([data[o], data[o + 1]]) as u64)),
                4 => bits.extend(block.iter().map(|&o| u32::from_le_bytes(data[o..o + 4].try_into().expect("4 bytes")) as u64)),
                _ => bits.extend(block.iter().map(|&o| u64::from_le_bytes(data[o..o + 8].try_into().expect("8 bytes")))),
            }
            for (lane, place) in lanes.iter_mut().zip(&self.places) {
                let Place::Fixed { at, .. } = *place else { continue };
                let read = |o: usize| &data[o + at..];
                match lane {
                    Lane::W1(v) => v.extend(block.iter().map(|&o| read(o)[0])),
                    Lane::W2(v) => v.extend(block.iter().map(|&o| u16::from_le_bytes(read(o)[..2].try_into().expect("2 bytes")))),
                    Lane::W4(v) => v.extend(block.iter().map(|&o| u32::from_le_bytes(read(o)[..4].try_into().expect("4 bytes")))),
                    Lane::W8(v) => v.extend(block.iter().map(|&o| u64::from_le_bytes(read(o)[..8].try_into().expect("8 bytes")))),
                    Lane::W16(v) => v.extend(block.iter().map(|&o| u128::from_le_bytes(read(o)[..16].try_into().expect("16 bytes")))),
                    Lane::Skip => {}
                    Lane::Var(..) => unreachable!("a fixed-width column"),
                }
            }
            cursor.clear();
            cursor.extend(block.iter().map(|&o| o + self.fixed));
            for &j in &self.vars {
                let Lane::Var(values, ends) = &mut lanes[j] else {
                    // a column not wanted: only stepped over
                    for c in cursor.iter_mut() {
                        *c += 4 + u32::from_le_bytes(data[*c..*c + 4].try_into().expect("4 bytes")) as usize;
                    }
                    continue;
                };
                for c in cursor.iter_mut() {
                    let len = u32::from_le_bytes(data[*c..*c + 4].try_into().expect("4 bytes")) as usize;
                    let at = values.len();
                    values.reserve(len);
                    // SAFETY: `len` bytes are reserved past `at`, and written before they count
                    unsafe {
                        copy_to(values.as_mut_ptr().add(at), &data[*c + 4..*c + 4 + len]);
                        values.set_len(at + len);
                    }
                    ends.push(values.len());
                    *c += 4 + len;
                }
            }
        }
        // the columns with a NULL in some group
        let any = bits.iter().fold(0u64, |a, &b| a | b);
        lanes
            .into_iter()
            .enumerate()
            .map(|(j, lane)| {
                if let Lane::Skip = lane {
                    return Ok(None);
                }
                let nulls = (any >> j & 1 != 0).then(|| NullBuffer::new(BooleanBuffer::collect_bool(n, |g| bits[g] >> j & 1 == 0)));
                lane.finish(&types[j], nulls).map(Some)
            })
            .collect()
    }
}

/// Groups whose rows are read together by [`RowKeys::emit`] (their rows stay in cache).
const EMIT_GROUPS: usize = 1024;

/// The values of one key column read from the rows: fixed-width ones by their bits.
enum Lane {
    W1(Vec<u8>),
    W2(Vec<u16>),
    W4(Vec<u32>),
    W8(Vec<u64>),
    W16(Vec<u128>),
    Var(Vec<u8>, Vec<usize>),
    /// a column not asked for
    Skip,
}

impl Lane {
    /// The column of type `dt`.
    fn finish(self, dt: &DataType, nulls: Option<NullBuffer>) -> Result<ArrayRef> {
        /// The bits of `values` as an array of `T` (of the same width: the buffer is reused).
        fn typed<T: ArrowPrimitiveType, B: arrow::datatypes::ArrowNativeType>(values: Vec<B>, dt: &DataType, nulls: Option<NullBuffer>) -> ArrayRef {
            debug_assert_eq!(std::mem::size_of::<B>(), std::mem::size_of::<T::Native>());
            let n = values.len();
            let buffer = arrow::buffer::Buffer::from_vec(values);
            Arc::new(PrimitiveArray::<T>::new(ScalarBuffer::new(buffer, 0, n), nulls).with_data_type(dt.clone()))
        }
        Ok(match (self, dt) {
            (Lane::Skip, _) => unreachable!("a column not asked for"),
            (Lane::Var(values, ends), dt) => bytes_array(dt, std::borrow::Cow::Owned(values), &ends, nulls)?,
            (Lane::W1(v), DataType::Boolean) => Arc::new(BooleanArray::new(BooleanBuffer::collect_bool(v.len(), |g| v[g] != 0), nulls)),
            (Lane::W1(v), DataType::Int8) => typed::<Int8Type, u8>(v, dt, nulls),
            (Lane::W1(v), _) => typed::<UInt8Type, u8>(v, dt, nulls),
            (Lane::W2(v), DataType::Int16) => typed::<Int16Type, u16>(v, dt, nulls),
            (Lane::W2(v), _) => typed::<UInt16Type, u16>(v, dt, nulls),
            (Lane::W4(v), DataType::Int32) => typed::<Int32Type, u32>(v, dt, nulls),
            (Lane::W4(v), DataType::Date32) => typed::<Date32Type, u32>(v, dt, nulls),
            (Lane::W4(v), DataType::Float32) => typed::<Float32Type, u32>(v, dt, nulls),
            (Lane::W4(v), _) => typed::<UInt32Type, u32>(v, dt, nulls),
            (Lane::W8(v), DataType::Int64) => typed::<Int64Type, u64>(v, dt, nulls),
            (Lane::W8(v), DataType::Float64) => typed::<Float64Type, u64>(v, dt, nulls),
            (Lane::W8(v), DataType::Date64) => typed::<Date64Type, u64>(v, dt, nulls),
            (Lane::W8(v), DataType::Timestamp(TimeUnit::Second, _)) => typed::<TimestampSecondType, u64>(v, dt, nulls),
            (Lane::W8(v), DataType::Timestamp(TimeUnit::Millisecond, _)) => typed::<TimestampMillisecondType, u64>(v, dt, nulls),
            (Lane::W8(v), DataType::Timestamp(TimeUnit::Microsecond, _)) => typed::<TimestampMicrosecondType, u64>(v, dt, nulls),
            (Lane::W8(v), DataType::Timestamp(TimeUnit::Nanosecond, _)) => typed::<TimestampNanosecondType, u64>(v, dt, nulls),
            (Lane::W8(v), _) => typed::<UInt64Type, u64>(v, dt, nulls),
            (Lane::W16(v), _) => typed::<Decimal128Type, u128>(v, dt, nulls),
        })
    }
}

/// `dst.copy_from_slice(src)`, inline for the few bytes of most keys: a call to copy
/// costs more than the copy (and the compiler turns plain small copies back into calls).
#[inline(always)]
fn copy_bytes(dst: &mut [u8], src: &[u8]) {
    assert_eq!(dst.len(), src.len());
    // SAFETY: `dst` has room for `src`
    unsafe { copy_to(dst.as_mut_ptr(), src) }
}

/// Copy `src` to `d`.
///
/// # Safety
/// `d` is valid for writes of `src.len()` bytes, and does not overlap `src`.
#[inline(always)]
unsafe fn copy_to(d: *mut u8, src: &[u8]) {
    let (n, s) = (src.len(), src.as_ptr());
    // SAFETY: every read and write below is inside the `n` bytes of `src` and `d`
    unsafe {
        if n > 16 {
            std::ptr::copy_nonoverlapping(s, d, n);
        } else if n >= 8 {
            let (a, b) = ((s as *const u64).read_unaligned(), (s.add(n - 8) as *const u64).read_unaligned());
            (d as *mut u64).write_unaligned(a);
            (d.add(n - 8) as *mut u64).write_unaligned(b);
        } else if n >= 4 {
            let (a, b) = ((s as *const u32).read_unaligned(), (s.add(n - 4) as *const u32).read_unaligned());
            (d as *mut u32).write_unaligned(a);
            (d.add(n - 4) as *mut u32).write_unaligned(b);
        } else if n > 0 {
            // the first, middle and last bytes: all of them, for up to three
            *d = *s;
            *d.add(n / 2) = *s.add(n / 2);
            *d.add(n - 1) = *s.add(n - 1);
        }
    }
}

/// Write the values of a fixed-width column at `at` of each row (zeros for a NULL).
fn write_fixed(rows: &mut [u8], starts: &[usize], at: usize, a: &ArrayRef) {
    /// `values[i]` at `starts[i] + at`, as `N` bytes (a constant: one store, not a call to copy)
    #[inline(always)]
    fn put<const N: usize, T: Copy>(rows: &mut [u8], starts: &[usize], at: usize, values: &[T], nulls: Option<&NullBuffer>, bytes: impl Fn(T) -> [u8; N]) {
        match nulls {
            None => {
                for (&s, &v) in starts.iter().zip(values) {
                    let p = s + at;
                    rows[p..p + N].copy_from_slice(&bytes(v));
                }
            }
            Some(nulls) => {
                for (i, (&s, &v)) in starts.iter().zip(values).enumerate() {
                    let p = s + at;
                    rows[p..p + N].copy_from_slice(&if nulls.is_valid(i) { bytes(v) } else { [0; N] });
                }
            }
        }
    }
    macro_rules! prim {
        ($t:ty, $bytes:expr) => {{
            let a = a.as_primitive::<$t>();
            put(rows, starts, at, a.values(), a.nulls().filter(|x| x.null_count() > 0), $bytes)
        }};
    }
    match a.data_type() {
        DataType::Boolean => {
            let b = a.as_boolean();
            for (i, &s) in starts.iter().enumerate() {
                rows[s + at] = (b.is_valid(i) && b.value(i)) as u8;
            }
        }
        DataType::Int8 => prim!(Int8Type, |v: i8| v.to_le_bytes()),
        DataType::UInt8 => prim!(UInt8Type, |v: u8| v.to_le_bytes()),
        DataType::Int16 => prim!(Int16Type, |v: i16| v.to_le_bytes()),
        DataType::UInt16 => prim!(UInt16Type, |v: u16| v.to_le_bytes()),
        DataType::Int32 => prim!(Int32Type, |v: i32| v.to_le_bytes()),
        DataType::UInt32 => prim!(UInt32Type, |v: u32| v.to_le_bytes()),
        DataType::Date32 => prim!(Date32Type, |v: i32| v.to_le_bytes()),
        DataType::Float32 => prim!(Float32Type, |v: f32| (v.to_key() as u32).to_le_bytes()),
        DataType::Int64 => prim!(Int64Type, |v: i64| v.to_le_bytes()),
        DataType::UInt64 => prim!(UInt64Type, |v: u64| v.to_le_bytes()),
        DataType::Date64 => prim!(Date64Type, |v: i64| v.to_le_bytes()),
        DataType::Float64 => prim!(Float64Type, |v: f64| v.to_key().to_le_bytes()),
        DataType::Timestamp(TimeUnit::Second, _) => prim!(TimestampSecondType, |v: i64| v.to_le_bytes()),
        DataType::Timestamp(TimeUnit::Millisecond, _) => prim!(TimestampMillisecondType, |v: i64| v.to_le_bytes()),
        DataType::Timestamp(TimeUnit::Microsecond, _) => prim!(TimestampMicrosecondType, |v: i64| v.to_le_bytes()),
        DataType::Timestamp(TimeUnit::Nanosecond, _) => prim!(TimestampNanosecondType, |v: i64| v.to_le_bytes()),
        DataType::Decimal128(_, _) => prim!(Decimal128Type, |v: i128| v.to_le_bytes()),
        dt => unreachable!("not a fixed-width key type: {dt}"),
    }
}
