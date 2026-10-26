//! Multi-column keys packed into one to four 64-bit words: fixed-width
//! columns by their bits, other columns by the dense id of their column
//! interner, plus a NULL bit per fixed-width column when there is room.
//! Each row then costs one probe of one table, where interning every column
//! and then the tuple of ids costs a probe per column more (each a cache
//! miss once there are millions of groups). Small tables keep the column ids
//! (two small ids are a direct lookup); keys move here once a table is
//! large.

use std::sync::Arc;

use arrow::array::*;
use arrow::buffer::{BooleanBuffer, NullBuffer, ScalarBuffer};
use arrow::compute::take;
use arrow::datatypes::*;

use super::ColumnInterner;
use super::table::{IdTable, PREFETCH_AHEAD};
use crate::error::Result;
use crate::hash::{NativeKey, combine, hash_u64, hash_u128};

const MAX_WORDS: usize = 4;

#[derive(Clone, Copy, Debug)]
enum Place {
    /// the value's bits, `bits` wide at `shift` in `word` (128-bit values
    /// take `word` and the next one), and the NULL bit `(word, shift)` if any
    Raw { word: usize, shift: u32, bits: u32, null: Option<(usize, u32)> },
    /// the column interner's id
    Id { word: usize, shift: u32 },
}

/// Bits of a column kept by value (None: kept as its interned id).
pub fn raw_bits(dt: &DataType) -> Option<u32> {
    Some(match dt {
        DataType::Boolean => 1,
        DataType::Int8 | DataType::UInt8 => 8,
        DataType::Int16 | DataType::UInt16 => 16,
        DataType::Int32 | DataType::UInt32 | DataType::Float32 | DataType::Date32 => 32,
        DataType::Int64 | DataType::UInt64 | DataType::Float64 | DataType::Date64 | DataType::Timestamp(_, _) => 64,
        DataType::Decimal128(_, _) => 128,
        _ => return None,
    })
}

pub struct Layout {
    places: Vec<Place>,
    words: usize,
}

impl Layout {
    /// Some column is kept by value (otherwise packing saves no probe).
    pub fn has_raw(&self) -> bool {
        self.places.iter().any(|p| matches!(p, Place::Raw { .. }))
    }

    /// None: the key takes more than four words.
    pub fn new(types: &[DataType]) -> Option<Self> {
        Self::place(types, true).or_else(|| Self::place(types, false))
    }

    fn place(types: &[DataType], nulls: bool) -> Option<Self> {
        let mut used: Vec<u32> = vec![];
        let mut places: Vec<Option<Place>> = vec![None; types.len()];
        // widest first: 64 and 128-bit values take whole words, narrower ones share
        let mut order: Vec<(usize, u32)> = types.iter().enumerate().map(|(j, t)| (j, raw_bits(t).unwrap_or(32))).collect();
        order.sort_by_key(|&(j, b)| (std::cmp::Reverse(b), j));
        for (j, bits) in order {
            let (word, shift) = if bits >= 64 {
                used.extend(std::iter::repeat_n(64, bits as usize / 64));
                (used.len() - bits as usize / 64, 0)
            } else {
                alloc(&mut used, bits)
            };
            places[j] = Some(match raw_bits(&types[j]) {
                Some(_) => Place::Raw { word, shift, bits, null: None },
                None => Place::Id { word, shift },
            });
        }
        if nulls {
            for p in places.iter_mut().flatten() {
                if let Place::Raw { null, .. } = p {
                    *null = Some(alloc(&mut used, 1));
                }
            }
        }
        (used.len() <= MAX_WORDS).then(|| Self { places: places.into_iter().map(|p| p.expect("placed")).collect(), words: used.len() })
    }
}

/// `(word, shift)` of `bits` free bits: the first word with room, else a new one.
fn alloc(used: &mut Vec<u32>, bits: u32) -> (usize, u32) {
    match used.iter().position(|&u| u + bits <= 64) {
        Some(w) => {
            let shift = used[w];
            used[w] += bits;
            (w, shift)
        }
        None => {
            used.push(bits);
            (used.len() - 1, 0)
        }
    }
}

#[inline(always)]
fn hash_words<const N: usize>(k: &[u64; N]) -> u64 {
    let mut h = if N == 1 { hash_u64(k[0]) } else { hash_u128(k[0] as u128 | (k[1] as u128) << 64) };
    for &w in k.iter().skip(2) {
        h = combine(h, hash_u64(w));
    }
    h
}

#[inline(always)]
fn mask(bits: u32) -> u64 {
    if bits >= 64 { u64::MAX } else { (1u64 << bits) - 1 }
}

struct Words<const N: usize>
where
    [u64; N]: Default,
{
    map: IdTable<[u64; N]>,
    /// the key of each group, by id
    keys: Vec<[u64; N]>,
    /// scratch: the keys and hashes of the batch's rows
    rows: Vec<[u64; N]>,
    hashes: Vec<u64>,
}

impl<const N: usize> Words<N>
where
    [u64; N]: Default,
{
    fn new() -> Self {
        Self { map: IdTable::new(), keys: vec![], rows: vec![], hashes: vec![] }
    }

    fn fill(&mut self, places: &[Place], cols: &[ArrayRef], ids: &[Vec<u32>]) {
        self.rows.clear();
        self.rows.resize(cols[0].len(), [0u64; N]);
        for (j, place) in places.iter().enumerate() {
            match *place {
                Place::Id { word, shift } => {
                    for (r, &id) in self.rows.iter_mut().zip(&ids[j]) {
                        r[word] |= (id as u64) << shift;
                    }
                }
                Place::Raw { word, shift, bits, null } => fill_raw(&cols[j], &mut self.rows, word, shift, bits, null),
            }
        }
    }

    fn probe(&mut self, selected: Option<&BooleanBuffer>, out: &mut Vec<u32>) {
        let n = self.rows.len();
        out.clear();
        out.reserve(n);
        self.hashes.clear();
        self.hashes.extend(self.rows.iter().map(hash_words));
        let large = self.map.large();
        for i in 0..n {
            if large && let Some(&a) = self.hashes.get(i + PREFETCH_AHEAD) {
                self.map.prefetch(a);
            }
            if selected.is_some_and(|m| !m.value(i)) {
                out.push(u32::MAX);
                continue;
            }
            let (k, h) = (self.rows[i], self.hashes[i]);
            let id = match self.map.find(h, |e, _| *e == k) {
                Ok(id) => id,
                Err(slot) => {
                    let id = self.keys.len() as u32;
                    self.keys.push(k);
                    self.map.insert(slot, h, k, id, hash_words);
                    id
                }
            };
            out.push(id);
        }
    }

    fn emit(&self, places: &[Place], types: &[DataType], interners: &[Box<dyn ColumnInterner>]) -> Result<Vec<ArrayRef>> {
        places
            .iter()
            .zip(types)
            .enumerate()
            .map(|(j, (place, dt))| match *place {
                Place::Id { word, shift } => {
                    let ids: UInt32Array = self.keys.iter().map(|k| (k[word] >> shift) as u32).collect();
                    Ok(take(&interners[j].values()?, &ids, None)?)
                }
                Place::Raw { word, shift, bits, null } => Ok(emit_raw(dt, &self.keys, word, shift, bits, null)),
            })
            .collect()
    }
}

/// OR a fixed-width column's bits (and NULL bits) into the rows' keys.
fn fill_raw<const N: usize>(a: &ArrayRef, rows: &mut [[u64; N]], word: usize, shift: u32, bits: u32, null: Option<(usize, u32)>) {
    macro_rules! prim {
        ($t:ty) => {
            put(a.as_primitive::<$t>(), rows, word, shift, bits, null)
        };
    }
    match a.data_type() {
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
        DataType::Decimal128(_, _) => {
            let arr = a.as_primitive::<Decimal128Type>();
            let nulls = arr.nulls().filter(|n| n.null_count() > 0);
            for (i, (r, &v)) in rows.iter_mut().zip(arr.values().iter()).enumerate() {
                if nulls.is_none_or(|n| n.is_valid(i)) {
                    r[word] = v as u64;
                    r[word + 1] = (v as u128 >> 64) as u64;
                } else {
                    let (nw, ns) = null.expect("a NULL has a bit");
                    r[nw] |= 1 << ns;
                }
            }
        }
        DataType::Boolean => {
            let b = a.as_boolean();
            for (i, r) in rows.iter_mut().enumerate() {
                if b.is_valid(i) {
                    r[word] |= (b.value(i) as u64) << shift;
                } else {
                    let (nw, ns) = null.expect("a NULL has a bit");
                    r[nw] |= 1 << ns;
                }
            }
        }
        dt => unreachable!("{dt} is not kept by value"),
    }
}

fn put<T, const N: usize>(arr: &PrimitiveArray<T>, rows: &mut [[u64; N]], word: usize, shift: u32, bits: u32, null: Option<(usize, u32)>)
where
    T: ArrowPrimitiveType,
    T::Native: NativeKey<Key = u64>,
{
    let m = mask(bits);
    let vals = arr.values();
    match arr.nulls().filter(|n| n.null_count() > 0) {
        None => {
            for (r, &v) in rows.iter_mut().zip(vals.iter()) {
                r[word] |= (v.to_key() & m) << shift;
            }
        }
        Some(nulls) => {
            let (nw, ns) = null.expect("a NULL has a bit");
            for (i, (r, &v)) in rows.iter_mut().zip(vals.iter()).enumerate() {
                if nulls.is_valid(i) {
                    r[word] |= (v.to_key() & m) << shift;
                } else {
                    r[nw] |= 1 << ns;
                }
            }
        }
    }
}

fn emit_raw<const N: usize>(dt: &DataType, keys: &[[u64; N]], word: usize, shift: u32, bits: u32, null: Option<(usize, u32)>) -> ArrayRef {
    let nulls = null.and_then(|(w, s)| {
        let valid: BooleanBuffer = keys.iter().map(|k| (k[w] >> s) & 1 == 0).collect();
        Some(NullBuffer::new(valid)).filter(|n| n.null_count() > 0)
    });
    let m = mask(bits);
    let get = |k: &[u64; N]| (k[word] >> shift) & m;
    macro_rules! prim {
        ($t:ty, $conv:expr) => {{
            let vals: Vec<<$t as ArrowPrimitiveType>::Native> = keys.iter().map(|k| $conv(get(k))).collect();
            Arc::new(PrimitiveArray::<$t>::new(ScalarBuffer::from(vals), nulls).with_data_type(dt.clone())) as ArrayRef
        }};
    }
    match dt {
        DataType::Int8 => prim!(Int8Type, |x: u64| x as u8 as i8),
        DataType::Int16 => prim!(Int16Type, |x: u64| x as u16 as i16),
        DataType::Int32 => prim!(Int32Type, |x: u64| x as u32 as i32),
        DataType::Int64 => prim!(Int64Type, |x: u64| x as i64),
        DataType::UInt8 => prim!(UInt8Type, |x: u64| x as u8),
        DataType::UInt16 => prim!(UInt16Type, |x: u64| x as u16),
        DataType::UInt32 => prim!(UInt32Type, |x: u64| x as u32),
        DataType::UInt64 => prim!(UInt64Type, |x: u64| x),
        DataType::Float32 => prim!(Float32Type, |x: u64| f32::from_bits(x as u32)),
        DataType::Float64 => prim!(Float64Type, f64::from_bits),
        DataType::Date32 => prim!(Date32Type, |x: u64| x as u32 as i32),
        DataType::Date64 => prim!(Date64Type, |x: u64| x as i64),
        DataType::Timestamp(TimeUnit::Second, _) => prim!(TimestampSecondType, |x: u64| x as i64),
        DataType::Timestamp(TimeUnit::Millisecond, _) => prim!(TimestampMillisecondType, |x: u64| x as i64),
        DataType::Timestamp(TimeUnit::Microsecond, _) => prim!(TimestampMicrosecondType, |x: u64| x as i64),
        DataType::Timestamp(TimeUnit::Nanosecond, _) => prim!(TimestampNanosecondType, |x: u64| x as i64),
        DataType::Decimal128(_, _) => {
            let vals: Vec<i128> = keys.iter().map(|k| (k[word] as u128 | (k[word + 1] as u128) << 64) as i128).collect();
            Arc::new(Decimal128Array::new(ScalarBuffer::from(vals), nulls).with_data_type(dt.clone()))
        }
        DataType::Boolean => Arc::new(BooleanArray::new(keys.iter().map(|k| get(k) != 0).collect(), nulls)),
        dt => unreachable!("{dt} is not kept by value"),
    }
}

enum Table {
    W1(Words<1>),
    W2(Words<2>),
    W3(Words<3>),
    W4(Words<4>),
}

macro_rules! each {
    ($t:expr, $w:ident => $e:expr) => {
        match $t {
            Table::W1($w) => $e,
            Table::W2($w) => $e,
            Table::W3($w) => $e,
            Table::W4($w) => $e,
        }
    };
}

pub struct PackedKeys {
    places: Vec<Place>,
    table: Table,
}

impl PackedKeys {
    pub fn new(layout: Layout) -> Self {
        let table = match layout.words {
            0 | 1 => Table::W1(Words::new()),
            2 => Table::W2(Words::new()),
            3 => Table::W3(Words::new()),
            _ => Table::W4(Words::new()),
        };
        Self { places: layout.places, table }
    }

    /// Column `j` is kept as its interned id.
    pub fn by_id(&self, j: usize) -> bool {
        matches!(self.places[j], Place::Id { .. })
    }

    /// False when a column without a NULL bit has NULLs in `cols`.
    pub fn accepts(&self, cols: &[ArrayRef]) -> bool {
        self.places.iter().zip(cols).all(|(p, c)| !matches!(p, Place::Raw { null: None, .. }) || c.null_count() == 0)
    }

    pub fn len(&self) -> usize {
        each!(&self.table, w => w.keys.len())
    }

    pub fn reserve(&mut self, n: usize) {
        each!(&mut self.table, w => {
            w.map.reserve(n, hash_words);
            w.keys.reserve(n);
        })
    }

    /// Ids of the rows' keys (`u32::MAX` for unselected rows); `ids` holds
    /// the interned ids of the columns kept by id.
    pub fn intern(&mut self, cols: &[ArrayRef], ids: &[Vec<u32>], selected: Option<&BooleanBuffer>, out: &mut Vec<u32>) {
        let places = &self.places;
        each!(&mut self.table, w => {
            w.fill(places, cols, ids);
            w.probe(selected, out);
        })
    }

    pub fn emit(&self, types: &[DataType], interners: &[Box<dyn ColumnInterner>]) -> Result<Vec<ArrayRef>> {
        each!(&self.table, w => w.emit(&self.places, types, interners))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layouts() {
        let l = Layout::new(&[DataType::Int64, DataType::Int32]).unwrap();
        assert_eq!(l.words, 2, "i64 | i32 + two NULL bits");
        let l = Layout::new(&[DataType::Int64, DataType::Int64]).unwrap();
        assert_eq!(l.words, 3);
        let l = Layout::new(&[DataType::Int64, DataType::Int64, DataType::Decimal128(15, 2)]).unwrap();
        assert_eq!(l.words, 4, "no room for NULL bits");
        assert!(matches!(l.places[0], Place::Raw { null: None, .. }));
        let l = Layout::new(&[DataType::Int64, DataType::Utf8, DataType::Int16]).unwrap();
        assert_eq!(l.words, 2);
        assert!(matches!(l.places[1], Place::Id { .. }));
        assert!(Layout::new(&[DataType::Decimal128(38, 0), DataType::Decimal128(38, 0), DataType::Int8]).is_none());
    }
}
