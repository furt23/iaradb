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
//! columns keep one representative value per group and every row is checked
//! against it. When a check fails the groups seen so far are re-keyed (with
//! the same ids) under the next candidate lead, or under full interning.

use std::sync::Arc;

use arrow::array::*;
use arrow::buffer::{Buffer, NullBuffer, OffsetBuffer, ScalarBuffer};
use arrow::compute::{cast, take};
use arrow::datatypes::*;
use arrow::row::{RowConverter, SortField};
use hashbrown::HashTable;

use crate::error::Result;
use crate::hash::{NativeKey, combine, hash_bytes, hash_u64};

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
    map: HashTable<(<T::Native as NativeKey>::Key, u32)>,
    values: Vec<T::Native>,
    null_id: Option<u32>,
    dt: DataType,
}

impl<T: ArrowPrimitiveType> PrimitiveInterner<T>
where
    T::Native: NativeKey,
{
    fn new(dt: DataType) -> Self {
        Self { map: HashTable::with_capacity(1024), values: vec![], null_id: None, dt }
    }

    #[inline(always)]
    fn lookup(&mut self, v: T::Native) -> u32 {
        let k = v.to_key();
        let h = <T::Native as NativeKey>::hash_key(k);
        if let Some(e) = self.map.find(h, |e| e.0 == k) {
            return e.1;
        }
        let id = self.values.len() as u32;
        self.values.push(v);
        self.map.insert_unique(h, (k, id), |e| <T::Native as NativeKey>::hash_key(e.0));
        id
    }
}

impl<T: ArrowPrimitiveType> ColumnInterner for PrimitiveInterner<T>
where
    T::Native: NativeKey,
{
    fn intern(&mut self, array: &ArrayRef, out: &mut Vec<u32>) -> Result<()> {
        let arr = array.as_primitive::<T>();
        out.clear();
        out.reserve(arr.len());
        match arr.nulls().filter(|n| n.null_count() > 0) {
            None => {
                for &v in arr.values().iter() {
                    let id = self.lookup(v);
                    out.push(id);
                }
            }
            Some(nulls) => {
                for (i, &v) in arr.values().iter().enumerate() {
                    let id = if nulls.is_valid(i) {
                        self.lookup(v)
                    } else {
                        match self.null_id {
                            Some(id) => id,
                            None => {
                                let id = self.values.len() as u32;
                                self.values.push(T::Native::default());
                                self.null_id = Some(id);
                                id
                            }
                        }
                    };
                    out.push(id);
                }
            }
        }
        Ok(())
    }

    fn len(&self) -> usize {
        self.values.len()
    }

    fn reserve(&mut self, n: usize) {
        self.map.reserve(n, |e| <T::Native as NativeKey>::hash_key(e.0));
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
    map: HashTable<(u64, u32)>,
    /// Utf8View strings of <= 12 bytes are fully described by their 128-bit
    /// view (length + inline bytes), which is used directly as the key
    short: HashTable<(u128, u32)>,
    offsets: Vec<usize>,
    data: Vec<u8>,
    null_id: Option<u32>,
    dt: DataType,
}

impl BytesInterner {
    fn new(dt: DataType) -> Self {
        Self { map: HashTable::with_capacity(1024), short: HashTable::new(), offsets: vec![0], data: vec![], null_id: None, dt }
    }

    #[inline(always)]
    fn lookup(&mut self, b: &[u8]) -> u32 {
        let h = hash_bytes(b);
        let (data, offsets) = (&self.data, &self.offsets);
        if let Some(e) = self.map.find(h, |e| {
            e.0 == h && {
                let i = e.1 as usize;
                &data[offsets[i]..offsets[i + 1]] == b
            }
        }) {
            return e.1;
        }
        let id = (self.offsets.len() - 1) as u32;
        self.data.extend_from_slice(b);
        self.offsets.push(self.data.len());
        self.map.insert_unique(h, (h, id), |e| e.0);
        id
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

    fn run<'a>(&mut self, it: impl Iterator<Item = Option<&'a [u8]>>, out: &mut Vec<u32>) {
        for v in it {
            let id = match v {
                Some(b) => self.lookup(b),
                None => self.null(),
            };
            out.push(id);
        }
    }
}

impl ColumnInterner for BytesInterner {
    fn intern(&mut self, array: &ArrayRef, out: &mut Vec<u32>) -> Result<()> {
        out.clear();
        out.reserve(array.len());
        match array.data_type() {
            DataType::Utf8 => {
                let a = array.as_string::<i32>();
                if a.null_count() == 0 {
                    for i in 0..a.len() {
                        let id = self.lookup(a.value(i).as_bytes());
                        out.push(id);
                    }
                } else {
                    self.run(a.iter().map(|v| v.map(|s| s.as_bytes())), out)
                }
            }
            DataType::LargeUtf8 => self.run(array.as_string::<i64>().iter().map(|v| v.map(|s| s.as_bytes())), out),
            DataType::Utf8View => {
                let a = array.as_string_view();
                let views = a.views();
                let nulls = a.nulls().filter(|n| n.null_count() > 0).cloned();
                for (i, &view) in views.iter().enumerate() {
                    if nulls.as_ref().is_some_and(|n| n.is_null(i)) {
                        let id = self.null();
                        out.push(id);
                        continue;
                    }
                    let len = view as u32;
                    let id = if len <= 12 {
                        let h = crate::hash::hash_u128(view);
                        match self.short.find(h, |e| e.0 == view) {
                            Some(e) => e.1,
                            None => {
                                let b = a.value(i).as_bytes();
                                let id = self.lookup(b);
                                self.short.insert_unique(h, (view, id), |e| crate::hash::hash_u128(e.0));
                                id
                            }
                        }
                    } else {
                        self.lookup(a.value(i).as_bytes())
                    };
                    out.push(id);
                }
            }
            DataType::Binary => self.run(array.as_binary::<i32>().iter(), out),
            DataType::LargeBinary => self.run(array.as_binary::<i64>().iter(), out),
            DataType::BinaryView => self.run(array.as_binary_view().iter(), out),
            dt => unreachable!("bytes interner for {dt}"),
        }
        Ok(())
    }

    fn len(&self) -> usize {
        self.offsets.len() - 1
    }

    fn reserve(&mut self, n: usize) {
        self.map.reserve(n, |e| e.0);
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
            let id = self.bytes.lookup(rows.row(i).as_ref());
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

// ---------------------------------------------------------------------------
// dependent key columns
// ---------------------------------------------------------------------------

/// One representative value per group of a key column that is (so far)
/// functionally dependent on the lead key column.
enum DepStore {
    Fixed { w: usize, bytes: Vec<u8>, valid: Vec<bool>, dt: DataType },
    Bool { vals: Vec<Option<bool>> },
    Bytes { data: Vec<u8>, offsets: Vec<usize>, valid: Vec<bool>, dt: DataType },
}

impl DepStore {
    fn supports(dt: &DataType) -> bool {
        Self::new(dt).is_some()
    }

    fn new(dt: &DataType) -> Option<Self> {
        Some(match dt {
            DataType::Boolean => DepStore::Bool { vals: vec![] },
            DataType::Utf8
            | DataType::LargeUtf8
            | DataType::Utf8View
            | DataType::Binary
            | DataType::LargeBinary
            | DataType::BinaryView => DepStore::Bytes { data: vec![], offsets: vec![0], valid: vec![], dt: dt.clone() },
            dt if dt.is_primitive() => {
                DepStore::Fixed { w: dt.primitive_width()?, bytes: vec![], valid: vec![], dt: dt.clone() }
            }
            _ => return None,
        })
    }

    /// Check every row against its group's representative (`gids` are dense
    /// ids in first-occurrence order, so a row of a new group carries the
    /// next id). Returns false on the first disagreement, and on an id past
    /// the next one (the caller then falls back to keying on these columns).
    fn check(&mut self, array: &ArrayRef, gids: &[u32]) -> bool {
        let nulls = array.nulls().filter(|n| n.null_count() > 0);
        let is_valid = |i: usize| nulls.is_none_or(|n| n.is_valid(i));
        match self {
            DepStore::Fixed { w, bytes, valid, .. } => {
                let w = *w;
                let data = array.to_data();
                let src = &data.buffers()[0].as_slice()[data.offset() * w..];
                for (i, &g) in gids.iter().enumerate() {
                    let g = g as usize;
                    let ok = is_valid(i);
                    let v = &src[i * w..(i + 1) * w];
                    if g > valid.len() {
                        return false;
                    }
                    if g == valid.len() {
                        valid.push(ok);
                        bytes.extend_from_slice(v);
                    } else if valid[g] != ok || (ok && bytes[g * w..(g + 1) * w] != *v) {
                        return false;
                    }
                }
                true
            }
            DepStore::Bool { vals } => {
                let a = array.as_boolean();
                for (i, &g) in gids.iter().enumerate() {
                    let v = is_valid(i).then(|| a.value(i));
                    let g = g as usize;
                    if g > vals.len() {
                        return false;
                    }
                    if g == vals.len() {
                        vals.push(v);
                    } else if vals[g] != v {
                        return false;
                    }
                }
                true
            }
            DepStore::Bytes { data, offsets, valid, .. } => {
                let mut step = |g: u32, v: Option<&[u8]>| -> bool {
                    let g = g as usize;
                    if g > valid.len() {
                        return false;
                    }
                    if g == valid.len() {
                        valid.push(v.is_some());
                        data.extend_from_slice(v.unwrap_or_default());
                        offsets.push(data.len());
                        true
                    } else {
                        match v {
                            None => !valid[g],
                            Some(b) => valid[g] && data[offsets[g]..offsets[g + 1]] == *b,
                        }
                    }
                };
                macro_rules! run {
                    ($a:expr, $f:expr) => {{
                        let a = $a;
                        gids.iter().enumerate().all(|(i, &g)| step(g, is_valid(i).then(|| $f(a.value(i)))))
                    }};
                }
                match array.data_type() {
                    DataType::Utf8 => run!(array.as_string::<i32>(), str::as_bytes),
                    DataType::LargeUtf8 => run!(array.as_string::<i64>(), str::as_bytes),
                    DataType::Utf8View => run!(array.as_string_view(), str::as_bytes),
                    DataType::Binary => run!(array.as_binary::<i32>(), std::convert::identity),
                    DataType::LargeBinary => run!(array.as_binary::<i64>(), std::convert::identity),
                    DataType::BinaryView => run!(array.as_binary_view(), std::convert::identity),
                    _ => false,
                }
            }
        }
    }

    fn reserve(&mut self, n: usize) {
        match self {
            DepStore::Fixed { w, bytes, valid, .. } => {
                bytes.reserve(n * *w);
                valid.reserve(n);
            }
            DepStore::Bool { vals } => vals.reserve(n),
            DepStore::Bytes { offsets, valid, .. } => {
                offsets.reserve(n);
                valid.reserve(n);
            }
        }
    }

    /// The representatives of groups `0..n`.
    fn values(&self, n: usize) -> Result<ArrayRef> {
        let nulls = |valid: &[bool]| {
            let v = &valid[..n];
            (!v.iter().all(|&b| b)).then(|| NullBuffer::from(v.to_vec()))
        };
        match self {
            DepStore::Fixed { w, bytes, valid, dt } => {
                let data = ArrayData::builder(dt.clone())
                    .len(n)
                    .add_buffer(Buffer::from_slice_ref(&bytes[..n * w]))
                    .nulls(nulls(valid))
                    .build()?;
                Ok(make_array(data))
            }
            DepStore::Bool { vals } => Ok(Arc::new(BooleanArray::from(vals[..n].to_vec()))),
            DepStore::Bytes { data, offsets, valid, dt } => bytes_array(dt, data, &offsets[..=n], nulls(valid)),
        }
    }
}

struct Dependent {
    lead: usize,
    stores: Vec<(usize, DepStore)>,
}

// ---------------------------------------------------------------------------
// multi-column keys
// ---------------------------------------------------------------------------

enum Composite {
    Two { map: HashTable<(u64, u32)>, keys: Vec<u64> },
    Many { k: usize, map: HashTable<(u64, u32)>, ids: Vec<u32> },
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
        let candidates = if types.len() >= 2 && types.iter().all(DepStore::supports) {
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
            let stores = (0..self.types.len())
                .filter(|&j| j != lead)
                .map(|j| (j, DepStore::new(&self.types[j]).expect("supported")))
                .collect();
            self.dep = Some(Dependent { lead, stores });
            self.composite = None;
        } else {
            self.dep = None;
            self.composite = match self.types.len() {
                0 | 1 => None,
                2 => Some(Composite::Two { map: HashTable::with_capacity(1024), keys: vec![] }),
                k => Some(Composite::Many { k, map: HashTable::with_capacity(1024), ids: vec![] }),
            };
        }
        Ok(())
    }

    pub fn reserve(&mut self, n: usize) {
        if let Some(d) = &mut self.dep {
            self.interners[d.lead].reserve(n);
            for (_, s) in &mut d.stores {
                s.reserve(n);
            }
            return;
        }
        for i in &mut self.interners {
            i.reserve(n);
        }
        match &mut self.composite {
            Some(Composite::Two { map, keys }) => {
                map.reserve(n, |e| hash_u64(e.0));
                keys.reserve(n);
            }
            Some(Composite::Many { map, .. }) => map.reserve(n, |e| e.0),
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

    pub fn intern(&mut self, cols: &[ArrayRef], out: &mut Vec<u32>) -> Result<()> {
        if let Some(d) = &mut self.dep {
            let lead = &mut self.interners[d.lead];
            let before = lead.len();
            lead.intern(&cols[d.lead], out)?;
            if d.stores.iter_mut().all(|(j, s)| s.check(&cols[*j], out)) {
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
                for i in 0..n {
                    let key = ((a[i] as u64) << 32) | b[i] as u64;
                    let h = hash_u64(key);
                    let id = match map.find(h, |e| e.0 == key) {
                        Some(e) => e.1,
                        None => {
                            let id = keys.len() as u32;
                            keys.push(key);
                            map.insert_unique(h, (key, id), |e| hash_u64(e.0));
                            id
                        }
                    };
                    out.push(id);
                }
            }
            Composite::Many { k, map, ids } => {
                let k = *k;
                let mut tuple = vec![0u32; k];
                for i in 0..n {
                    let mut h = 0u64;
                    for j in 0..k {
                        tuple[j] = self.scratch[j][i];
                        h = combine(h, hash_u64(tuple[j] as u64));
                    }
                    let found = map.find(h, |e| e.0 == h && ids[e.1 as usize * k..(e.1 as usize + 1) * k] == tuple[..]);
                    let id = match found {
                        Some(e) => e.1,
                        None => {
                            let id = (ids.len() / k) as u32;
                            ids.extend_from_slice(&tuple);
                            map.insert_unique(h, (h, id), |e| e.0);
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
                    d.stores.iter().find(|(c, _)| *c == j).expect("store").1.values(n)
                }
            })
            .collect()
    }
}

#[cfg(test)]
mod dep_tests;
