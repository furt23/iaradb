//! Group key interning.
//!
//! Every key column is interned on its own into a dense id space by a type
//! specialised interner (primitive keys live inline in a SwissTable, string
//! keys in a contiguous arena). Multi-column keys are then interned as
//! fixed-width tuples of those dense ids, which keeps the per-row work for
//! any combination of key types to a couple of cache-friendly probes.
//!
//! Wide keys like `(c_custkey, c_name, c_address, ...)` are usually
//! functionally dependent on one integer column. Such keys start in a
//! *dependent* mode: only the integer lead column is interned, the other
//! columns keep one representative record per group ([`dep`]) and every row
//! is checked against it. When a check fails the groups seen so far are
//! re-keyed (with the same ids) under the next candidate lead, or under full
//! interning.
//!
//! Every hash lookup goes through [`table::IdTable`], probed a batch at a
//! time with the slots of later rows prefetched: tables with millions of
//! groups are bound by cache misses, and these overlap.

mod dep;
mod table;

use std::sync::Arc;

use arrow::array::*;
use arrow::buffer::{Buffer, NullBuffer, OffsetBuffer, ScalarBuffer};
use arrow::compute::{cast, take};
use arrow::datatypes::*;
use arrow::row::{RowConverter, SortField};

use crate::error::Result;
use crate::hash::{NativeKey, combine, hash_bytes, hash_u64, hash_u128};
use dep::DepRecords;
use table::{IdTable, PREFETCH_AHEAD};

pub trait ColumnInterner: Send + Sync {
    /// Map every row of `array` to a dense id (appending unseen values).
    fn intern(&mut self, array: &ArrayRef, out: &mut Vec<u32>) -> Result<()>;
    fn len(&self) -> usize;
    /// The distinct values, in id order.
    fn values(&self) -> Result<ArrayRef>;
    /// Pre-size for about `n` distinct values.
    fn reserve(&mut self, _n: usize) {}
}

// ---------------------------------------------------------------------------
// primitive
// ---------------------------------------------------------------------------

struct PrimitiveInterner<T: ArrowPrimitiveType>
where
    T::Native: NativeKey,
{
    map: IdTable<<T::Native as NativeKey>::Key>,
    values: Vec<T::Native>,
    hashes: Vec<u64>,
    null_id: Option<u32>,
    dt: DataType,
}

impl<T: ArrowPrimitiveType> PrimitiveInterner<T>
where
    T::Native: NativeKey,
{
    fn new(dt: DataType) -> Self {
        Self { map: IdTable::new(), values: vec![], hashes: vec![], null_id: None, dt }
    }

    #[inline(always)]
    fn lookup(&mut self, h: u64, v: T::Native) -> u32 {
        let k = v.to_key();
        match self.map.find(h, |e, _| *e == k) {
            Ok(id) => id,
            Err(slot) => {
                let id = self.values.len() as u32;
                self.values.push(v);
                self.map.insert(slot, h, k, id, |e| <T::Native as NativeKey>::hash_key(*e));
                id
            }
        }
    }

    fn null(&mut self) -> u32 {
        *self.null_id.get_or_insert_with(|| {
            self.values.push(T::Native::default());
            (self.values.len() - 1) as u32
        })
    }
}

impl<T: ArrowPrimitiveType> ColumnInterner for PrimitiveInterner<T>
where
    T::Native: NativeKey,
{
    fn intern(&mut self, array: &ArrayRef, out: &mut Vec<u32>) -> Result<()> {
        let arr = array.as_primitive::<T>();
        let vals = arr.values();
        out.clear();
        out.reserve(arr.len());
        let nulls = arr.nulls().filter(|n| n.null_count() > 0);
        if !self.map.large() {
            for (i, &v) in vals.iter().enumerate() {
                let id = if nulls.is_none_or(|n| n.is_valid(i)) {
                    self.lookup(<T::Native as NativeKey>::hash_key(v.to_key()), v)
                } else {
                    self.null()
                };
                out.push(id);
            }
            return Ok(());
        }
        let mut hashes = std::mem::take(&mut self.hashes);
        hashes.clear();
        hashes.extend(vals.iter().map(|v| <T::Native as NativeKey>::hash_key(v.to_key())));
        match nulls {
            None => {
                for (i, (&v, &h)) in vals.iter().zip(&hashes).enumerate() {
                    if let Some(&a) = hashes.get(i + PREFETCH_AHEAD) {
                        self.map.prefetch(a);
                    }
                    let id = self.lookup(h, v);
                    out.push(id);
                }
            }
            Some(nulls) => {
                for (i, (&v, &h)) in vals.iter().zip(&hashes).enumerate() {
                    if let Some(&a) = hashes.get(i + PREFETCH_AHEAD) {
                        self.map.prefetch(a);
                    }
                    let id = if nulls.is_valid(i) { self.lookup(h, v) } else { self.null() };
                    out.push(id);
                }
            }
        }
        self.hashes = hashes;
        Ok(())
    }

    fn len(&self) -> usize {
        self.values.len()
    }

    fn reserve(&mut self, n: usize) {
        self.map.reserve(n, |e| <T::Native as NativeKey>::hash_key(*e));
        self.values.reserve(n);
    }

    fn values(&self) -> Result<ArrayRef> {
        let nulls = self.null_id.map(|nid| {
            let mut v = vec![true; self.values.len()];
            v[nid as usize] = false;
            NullBuffer::from(v)
        });
        Ok(Arc::new(
            PrimitiveArray::<T>::new(ScalarBuffer::from(self.values.clone()), nulls).with_data_type(self.dt.clone()),
        ))
    }
}

// ---------------------------------------------------------------------------
// variable-length bytes (strings / binary)
// ---------------------------------------------------------------------------

struct BytesInterner {
    /// keyed by the value's hash; equal hashes compare the bytes
    map: IdTable<u64>,
    /// Utf8View strings of <= 12 bytes are fully described by their 128-bit
    /// view (length + inline bytes), which is used directly as the key
    short: IdTable<u128>,
    offsets: Vec<usize>,
    data: Vec<u8>,
    hashes: Vec<u64>,
    null_id: Option<u32>,
    dt: DataType,
}

impl BytesInterner {
    fn new(dt: DataType) -> Self {
        Self {
            map: IdTable::new(),
            short: IdTable::new(),
            offsets: vec![0],
            data: vec![],
            hashes: vec![],
            null_id: None,
            dt,
        }
    }

    #[inline(always)]
    fn lookup(&mut self, h: u64, b: &[u8]) -> u32 {
        let (data, offsets) = (&self.data, &self.offsets);
        match self.map.find(h, |&e, i| e == h && &data[offsets[i as usize]..offsets[i as usize + 1]] == b) {
            Ok(id) => id,
            Err(slot) => {
                let id = (self.offsets.len() - 1) as u32;
                self.data.extend_from_slice(b);
                self.offsets.push(self.data.len());
                self.map.insert(slot, h, h, id, |&e| e);
                id
            }
        }
    }

    /// The id of a string of up to 12 bytes, keyed by its view.
    #[inline(always)]
    fn short_id(&mut self, view: u128, a: &StringViewArray, i: usize) -> u32 {
        self.short_id_hashed(hash_u128(view), view, a, i)
    }

    #[inline(always)]
    fn short_id_hashed(&mut self, h: u64, view: u128, a: &StringViewArray, i: usize) -> u32 {
        match self.short.find(h, |&e, _| e == view) {
            Ok(id) => id,
            Err(slot) => {
                let b = a.value(i).as_bytes();
                let id = self.lookup(hash_bytes(b), b);
                self.short.insert(slot, h, view, id, |&e| hash_u128(e));
                id
            }
        }
    }

    fn null(&mut self) -> u32 {
        match self.null_id {
            Some(id) => id,
            None => {
                let id = (self.offsets.len() - 1) as u32;
                self.offsets.push(self.data.len());
                self.null_id = Some(id);
                id
            }
        }
    }

    /// Look every value up; in a large table hash them all first, then
    /// probe with later rows' slots prefetched.
    fn run<'a>(&mut self, values: impl Fn(usize) -> Option<&'a [u8]>, n: usize, out: &mut Vec<u32>) {
        if !self.map.large() {
            for i in 0..n {
                let id = match values(i) {
                    Some(b) => self.lookup(hash_bytes(b), b),
                    None => self.null(),
                };
                out.push(id);
            }
            return;
        }
        let mut hashes = std::mem::take(&mut self.hashes);
        hashes.clear();
        hashes.extend((0..n).map(|i| values(i).map_or(0, hash_bytes)));
        for (i, &h) in hashes.iter().enumerate() {
            if let Some(&a) = hashes.get(i + PREFETCH_AHEAD) {
                self.map.prefetch(a);
            }
            let id = match values(i) {
                Some(b) => self.lookup(h, b),
                None => self.null(),
            };
            out.push(id);
        }
        self.hashes = hashes;
    }

    fn run_view(&mut self, a: &StringViewArray, out: &mut Vec<u32>) {
        let views = a.views();
        let nulls = a.nulls().filter(|n| n.null_count() > 0);
        if !self.short.large() && !self.map.large() {
            for (i, &view) in views.iter().enumerate() {
                let id = if nulls.is_some_and(|n| n.is_null(i)) {
                    self.null()
                } else if view as u32 <= 12 {
                    self.short_id(view, a, i)
                } else {
                    let b = a.value(i).as_bytes();
                    self.lookup(hash_bytes(b), b)
                };
                out.push(id);
            }
            return;
        }
        let mut hashes = std::mem::take(&mut self.hashes);
        hashes.clear();
        hashes.extend(views.iter().enumerate().map(|(i, &view)| {
            if view as u32 <= 12 { hash_u128(view) } else { hash_bytes(a.value(i).as_bytes()) }
        }));
        for (i, (&view, &h)) in views.iter().zip(&hashes).enumerate() {
            if let Some(&a) = hashes.get(i + PREFETCH_AHEAD) {
                if views[i + PREFETCH_AHEAD] as u32 <= 12 { self.short.prefetch(a) } else { self.map.prefetch(a) }
            }
            if nulls.is_some_and(|n| n.is_null(i)) {
                let id = self.null();
                out.push(id);
                continue;
            }
            let id = if view as u32 <= 12 {
                self.short_id_hashed(h, view, a, i)
            } else {
                self.lookup(h, a.value(i).as_bytes())
            };
            out.push(id);
        }
        self.hashes = hashes;
    }
}

impl ColumnInterner for BytesInterner {
    fn intern(&mut self, array: &ArrayRef, out: &mut Vec<u32>) -> Result<()> {
        out.clear();
        out.reserve(array.len());
        let n = array.len();
        macro_rules! run {
            ($a:expr, $f:expr) => {{
                let a = $a;
                match a.nulls().filter(|x| x.null_count() > 0).cloned() {
                    None => self.run(|i| Some($f(a.value(i))), n, out),
                    Some(nulls) => self.run(|i| nulls.is_valid(i).then(|| $f(a.value(i))), n, out),
                }
            }};
        }
        match array.data_type() {
            DataType::Utf8 => run!(array.as_string::<i32>(), str::as_bytes),
            DataType::LargeUtf8 => run!(array.as_string::<i64>(), str::as_bytes),
            DataType::Utf8View => self.run_view(array.as_string_view(), out),
            DataType::Binary => run!(array.as_binary::<i32>(), std::convert::identity),
            DataType::LargeBinary => run!(array.as_binary::<i64>(), std::convert::identity),
            DataType::BinaryView => run!(array.as_binary_view(), std::convert::identity),
            dt => unreachable!("bytes interner for {dt}"),
        }
        Ok(())
    }

    fn len(&self) -> usize {
        self.offsets.len() - 1
    }

    fn reserve(&mut self, n: usize) {
        self.map.reserve(n, |&e| e);
        self.offsets.reserve(n);
    }

    fn values(&self) -> Result<ArrayRef> {
        let n = self.len();
        let nulls = self.null_id.map(|nid| {
            let mut v = vec![true; n];
            v[nid as usize] = false;
            NullBuffer::from(v)
        });
        bytes_array(&self.dt, &self.data, &self.offsets, nulls)
    }
}

/// An array of type `dt` from an arena of values delimited by `offsets`.
fn bytes_array(dt: &DataType, data: &[u8], offsets: &[usize], nulls: Option<NullBuffer>) -> Result<ArrayRef> {
    let n = offsets.len() - 1;
    {
        if matches!(dt, DataType::Utf8View | DataType::BinaryView) && data.len() < u32::MAX as usize {
            // views straight into (a copy of) the arena: no StringArray + cast round trip
            let views: Vec<u128> = (0..n)
                .map(|i| {
                    let (s, e) = (offsets[i], offsets[i + 1]);
                    let b = &data[s..e];
                    let mut x = [0u8; 16];
                    x[0..4].copy_from_slice(&(b.len() as u32).to_le_bytes());
                    if b.len() <= 12 {
                        x[4..4 + b.len()].copy_from_slice(b);
                    } else {
                        x[4..8].copy_from_slice(&b[..4]);
                        x[12..16].copy_from_slice(&(s as u32).to_le_bytes());
                    }
                    u128::from_le_bytes(x)
                })
                .collect();
            let buffers: Arc<[Buffer]> = Arc::from(vec![Buffer::from_vec(data.to_vec())]);
            return Ok(if dt == &DataType::Utf8View {
                // SAFETY: views describe valid UTF-8 slices of the buffer
                Arc::new(unsafe { StringViewArray::new_unchecked(ScalarBuffer::from(views), buffers, nulls) })
            } else {
                Arc::new(unsafe { BinaryViewArray::new_unchecked(ScalarBuffer::from(views), buffers, nulls) })
            });
        }
        let is_utf8 = matches!(dt, DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View);
        let base: ArrayRef = if data.len() < i32::MAX as usize {
            let offs: Vec<i32> = offsets.iter().map(|&o| o as i32).collect();
            let offs = OffsetBuffer::new(ScalarBuffer::from(offs));
            let data = Buffer::from_vec(data.to_vec());
            if is_utf8 {
                // SAFETY: bytes were copied from valid UTF-8 values
                Arc::new(unsafe { StringArray::new_unchecked(offs, data, nulls) })
            } else {
                Arc::new(BinaryArray::new(offs, data, nulls))
            }
        } else {
            let offs: Vec<i64> = offsets.iter().map(|&o| o as i64).collect();
            let offs = OffsetBuffer::new(ScalarBuffer::from(offs));
            let data = Buffer::from_vec(data.to_vec());
            if is_utf8 {
                Arc::new(unsafe { LargeStringArray::new_unchecked(offs, data, nulls) })
            } else {
                Arc::new(LargeBinaryArray::new(offs, data, nulls))
            }
        };
        if base.data_type() == dt { Ok(base) } else { Ok(cast(&base, dt)?) }
    }
}

// ---------------------------------------------------------------------------
// boolean
// ---------------------------------------------------------------------------

struct BoolInterner {
    ids: [Option<u32>; 3],
    order: Vec<Option<bool>>,
}

impl ColumnInterner for BoolInterner {
    fn intern(&mut self, array: &ArrayRef, out: &mut Vec<u32>) -> Result<()> {
        let a = array.as_boolean();
        out.clear();
        out.reserve(a.len());
        for v in a.iter() {
            let slot = match v {
                Some(false) => 0,
                Some(true) => 1,
                None => 2,
            };
            let id = match self.ids[slot] {
                Some(id) => id,
                None => {
                    let id = self.order.len() as u32;
                    self.order.push(v);
                    self.ids[slot] = Some(id);
                    id
                }
            };
            out.push(id);
        }
        Ok(())
    }
    fn len(&self) -> usize {
        self.order.len()
    }
    fn values(&self) -> Result<ArrayRef> {
        Ok(Arc::new(BooleanArray::from(self.order.clone())))
    }
}

// ---------------------------------------------------------------------------
// generic fallback through the Arrow row format
// ---------------------------------------------------------------------------

struct RowInterner {
    conv: RowConverter,
    bytes: BytesInterner,
    rows: Option<arrow::row::Rows>,
}

impl ColumnInterner for RowInterner {
    fn intern(&mut self, array: &ArrayRef, out: &mut Vec<u32>) -> Result<()> {
        let rows = self.conv.convert_columns(std::slice::from_ref(array))?;
        out.clear();
        out.reserve(array.len());
        let before = self.bytes.len();
        for i in 0..rows.num_rows() {
            let b = rows.row(i);
            let id = self.bytes.lookup(hash_bytes(b.as_ref()), b.as_ref());
            out.push(id);
        }
        if self.bytes.len() > before || self.rows.is_none() {
            self.rows = None;
        }
        Ok(())
    }
    fn len(&self) -> usize {
        self.bytes.len()
    }
    fn values(&self) -> Result<ArrayRef> {
        let parser = self.conv.parser();
        let rows: Vec<_> = (0..self.bytes.len())
            .map(|i| parser.parse(&self.bytes.data[self.bytes.offsets[i]..self.bytes.offsets[i + 1]]))
            .collect();
        let mut out = self.conv.convert_rows(rows)?;
        Ok(out.remove(0))
    }
}

pub fn make_interner(dt: &DataType) -> Result<Box<dyn ColumnInterner>> {
    macro_rules! prim {
        ($t:ty) => {
            Box::new(PrimitiveInterner::<$t>::new(dt.clone())) as Box<dyn ColumnInterner>
        };
    }
    Ok(match dt {
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
        DataType::Utf8
        | DataType::LargeUtf8
        | DataType::Utf8View
        | DataType::Binary
        | DataType::LargeBinary
        | DataType::BinaryView => Box::new(BytesInterner::new(dt.clone())),
        DataType::Boolean => Box::new(BoolInterner { ids: [None; 3], order: vec![] }),
        other => Box::new(RowInterner {
            conv: RowConverter::new(vec![SortField::new(other.clone())])?,
            bytes: BytesInterner::new(DataType::Binary),
            rows: None,
        }),
    })
}

/// Dependent mode: groups are keyed by `lead` alone, the other columns
/// (`cols`, in the order of the record's fields) are checked against it.
struct Dependent {
    lead: usize,
    cols: Vec<usize>,
    recs: DepRecords,
}

// ---------------------------------------------------------------------------
// multi-column keys
// ---------------------------------------------------------------------------

enum Composite {
    /// two column ids packed into one u64
    Two { map: IdTable<u64>, keys: Vec<u64> },
    /// keyed by the hash of the tuple of column ids; equal hashes compare the tuples
    Many { k: usize, map: IdTable<u64>, ids: Vec<u32>, hashes: Vec<u64> },
}

pub struct GroupKeys {
    types: Vec<DataType>,
    interners: Vec<Box<dyn ColumnInterner>>,
    composite: Option<Composite>,
    scratch: Vec<Vec<u32>>,
    /// Some: dependent mode (only `interners[lead]` is used)
    dep: Option<Dependent>,
    /// integer key columns not yet tried as the dependent-mode lead
    candidates: Vec<usize>,
}

impl GroupKeys {
    pub fn try_new(types: &[DataType]) -> Result<Self> {
        let candidates = if types.len() >= 2 && types.iter().all(DepRecords::supports) {
            types.iter().enumerate().filter(|(_, t)| t.is_integer()).map(|(i, _)| i).collect()
        } else {
            vec![]
        };
        let mut keys = Self {
            types: types.to_vec(),
            interners: vec![],
            composite: None,
            scratch: vec![vec![]; types.len()],
            dep: None,
            candidates,
        };
        keys.next_mode()?;
        Ok(keys)
    }

    /// Reset to the next mode: dependent on the next lead candidate, else
    /// full interning.
    fn next_mode(&mut self) -> Result<()> {
        self.interners = self.types.iter().map(make_interner).collect::<Result<Vec<_>>>()?;
        if !self.candidates.is_empty() {
            let lead = self.candidates.remove(0);
            let cols: Vec<usize> = (0..self.types.len()).filter(|&j| j != lead).collect();
            let types: Vec<DataType> = cols.iter().map(|&j| self.types[j].clone()).collect();
            self.dep = Some(Dependent { lead, cols, recs: DepRecords::new(&types) });
            self.composite = None;
        } else {
            self.dep = None;
            self.composite = match self.types.len() {
                0 | 1 => None,
                2 => Some(Composite::Two { map: IdTable::new(), keys: vec![] }),
                k => Some(Composite::Many { k, map: IdTable::new(), ids: vec![], hashes: vec![] }),
            };
        }
        Ok(())
    }

    pub fn reserve(&mut self, n: usize) {
        if let Some(d) = &mut self.dep {
            self.interners[d.lead].reserve(n);
            d.recs.reserve(n);
            return;
        }
        for i in &mut self.interners {
            i.reserve(n);
        }
        match &mut self.composite {
            Some(Composite::Two { map, keys }) => {
                map.reserve(n, |&e| hash_u64(e));
                keys.reserve(n);
            }
            Some(Composite::Many { map, .. }) => map.reserve(n, |&e| e),
            None => {}
        }
    }

    pub fn len(&self) -> usize {
        if let Some(d) = &self.dep {
            return self.interners[d.lead].len();
        }
        match &self.composite {
            None => self.interners[0].len(),
            Some(Composite::Two { keys, .. }) => keys.len(),
            Some(Composite::Many { k, ids, .. }) => ids.len() / k,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Dependent mode: the column the others depend on (so far).
    pub fn lead(&self) -> Option<usize> {
        self.dep.as_ref().map(|d| d.lead)
    }

    pub fn intern(&mut self, cols: &[ArrayRef], out: &mut Vec<u32>) -> Result<()> {
        if let Some(d) = &mut self.dep {
            let lead = &mut self.interners[d.lead];
            let before = lead.len();
            lead.intern(&cols[d.lead], out)?;
            d.recs.grow_to(lead.len());
            if d.cols.iter().enumerate().all(|(f, &j)| d.recs.check(f, &cols[j], out, before)) {
                return Ok(());
            }
            // dependency broken: re-key the groups seen so far, keeping their ids
            let reps = self.emit_prefix(before)?;
            self.next_mode()?;
            if before > 0 {
                let mut ids = vec![];
                self.intern(&reps, &mut ids)?;
                debug_assert!(ids.iter().enumerate().all(|(i, &g)| g as usize == i));
            }
            return self.intern(cols, out);
        }
        let Some(comp) = &mut self.composite else {
            return self.interners[0].intern(&cols[0], out);
        };
        for (j, c) in cols.iter().enumerate() {
            self.interners[j].intern(c, &mut self.scratch[j])?;
        }
        let n = cols[0].len();
        out.clear();
        out.reserve(n);
        match comp {
            Composite::Two { map, keys } => {
                let (a, b) = (&self.scratch[0], &self.scratch[1]);
                let key = |i: usize| ((a[i] as u64) << 32) | b[i] as u64;
                let large = map.large();
                for i in 0..n {
                    if large && i + PREFETCH_AHEAD < n {
                        map.prefetch(hash_u64(key(i + PREFETCH_AHEAD)));
                    }
                    let k = key(i);
                    let h = hash_u64(k);
                    let id = match map.find(h, |&e, _| e == k) {
                        Ok(id) => id,
                        Err(slot) => {
                            let id = keys.len() as u32;
                            keys.push(k);
                            map.insert(slot, h, k, id, |&e| hash_u64(e));
                            id
                        }
                    };
                    out.push(id);
                }
            }
            Composite::Many { k, map, ids, hashes } => {
                let k = *k;
                let scratch = &self.scratch;
                hashes.clear();
                hashes.extend((0..n).map(|i| (0..k).fold(0u64, |h, j| combine(h, hash_u64(scratch[j][i] as u64)))));
                let mut tuple = vec![0u32; k];
                let large = map.large();
                for (i, &h) in hashes.iter().enumerate() {
                    if let Some(&a) = hashes.get(i + PREFETCH_AHEAD).filter(|_| large) {
                        map.prefetch(a);
                    }
                    for (j, t) in tuple.iter_mut().enumerate() {
                        *t = scratch[j][i];
                    }
                    let found = map.find(h, |&e, g| e == h && ids[g as usize * k..(g as usize + 1) * k] == tuple[..]);
                    let id = match found {
                        Ok(id) => id,
                        Err(slot) => {
                            let id = (ids.len() / k) as u32;
                            ids.extend_from_slice(&tuple);
                            map.insert(slot, h, h, id, |&e| e);
                            id
                        }
                    };
                    out.push(id);
                }
            }
        }
        Ok(())
    }

    /// Materialise the key columns of all groups (in group id order).
    pub fn emit(&self) -> Result<Vec<ArrayRef>> {
        if self.dep.is_some() {
            return self.emit_prefix(self.len());
        }
        let Some(comp) = &self.composite else {
            return Ok(vec![self.interners[0].values()?]);
        };
        let k = self.interners.len();
        let mut out = Vec::with_capacity(k);
        for (j, interner) in self.interners.iter().enumerate() {
            let vals = interner.values()?;
            let idx: Vec<u32> = match comp {
                Composite::Two { keys, .. } => keys
                    .iter()
                    .map(|key| if j == 0 { (key >> 32) as u32 } else { *key as u32 })
                    .collect(),
                Composite::Many { ids, .. } => ids.iter().skip(j).step_by(k).copied().collect(),
            };
            out.push(take(&vals, &UInt32Array::from(idx), None)?);
        }
        Ok(out)
    }

    /// Dependent mode: the key columns of groups `0..n`.
    fn emit_prefix(&self, n: usize) -> Result<Vec<ArrayRef>> {
        let d = self.dep.as_ref().expect("dependent mode");
        (0..self.types.len())
            .map(|j| {
                if j == d.lead {
                    Ok(self.interners[j].values()?.slice(0, n))
                } else {
                    d.recs.values(d.cols.iter().position(|&c| c == j).expect("dependent column"), n)
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod dep_tests;
