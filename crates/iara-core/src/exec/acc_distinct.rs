//! `COUNT(DISTINCT x)`: the distinct `(group, value)` pairs seen.
//!
//! Pairs are split into hash partitions by value, so merging the states of
//! the worker threads runs one task per partition (a global count over
//! millions of distinct values used to be merged on one thread). Integers
//! (dates, timestamps) are kept as i64, strings of at most 12 bytes as their
//! 16-byte view, longer strings - and other types, in row format - as bytes
//! in an arena of the partition: no allocation per row.
//!
//! A merge of some of the groups (one partition of a partitioned finalize)
//! reads only their pairs, through an index of the pairs by group built on
//! the first such merge.

use std::any::Any;
use std::sync::{Arc, OnceLock};

use arrow::array::*;
use arrow::compute::cast;
use arrow::datatypes::*;
use arrow::row::{RowConverter, SortField};
use hashbrown::HashTable;
use rayon::prelude::*;

use crate::error::Result;
use crate::exec::accumulators::{Accumulator, downcast};
use crate::hash::{combine, hash_bytes, hash_u64, hash_u128};

const PART_BITS: u32 = 6;
const PARTS: usize = 1 << PART_BITS;
/// Merges of fewer pairs than this run on the calling thread.
const PARALLEL_MERGE: usize = 1 << 15;
/// Merges of at most this share of a state's groups (1 / n) read the pairs
/// of those groups only, through the [`ByGroup`] index.
const PARTIAL_MERGE: usize = 4;

#[derive(Default)]
struct Part {
    ints: HashTable<(u32, i64)>,
    /// strings of at most 12 bytes: their view (length and bytes)
    shorts: HashTable<(u32, u128)>,
    /// (hash of the bytes, group, index into the arena)
    longs: HashTable<(u64, u32, u32)>,
    offsets: Vec<usize>,
    data: Vec<u8>,
}

impl Part {
    fn bytes(&self, i: u32) -> &[u8] {
        let i = i as usize;
        &self.data[self.offsets[i]..self.offsets[i + 1]]
    }

    fn insert_int(&mut self, g: u32, v: i64, h: u64) {
        let h = combine(h, g as u64);
        if self.ints.find(h, |e| *e == (g, v)).is_none() {
            self.ints.insert_unique(h, (g, v), |e| combine(hash_u64(e.1 as u64), e.0 as u64));
        }
    }

    fn insert_short(&mut self, g: u32, v: u128, h: u64) {
        let h = combine(h, g as u64);
        if self.shorts.find(h, |e| *e == (g, v)).is_none() {
            self.shorts.insert_unique(h, (g, v), |e| combine(hash_u128(e.1), e.0 as u64));
        }
    }

    fn insert_long(&mut self, g: u32, b: &[u8], hb: u64) {
        let h = combine(hb, g as u64);
        let (data, offsets) = (&self.data, &self.offsets);
        let found = self.longs.find(h, |e| {
            e.0 == hb && e.1 == g && {
                let i = e.2 as usize;
                &data[offsets[i]..offsets[i + 1]] == b
            }
        });
        if found.is_some() {
            return;
        }
        if self.offsets.is_empty() {
            self.offsets.push(0);
        }
        let idx = (self.offsets.len() - 1) as u32;
        self.data.extend_from_slice(b);
        self.offsets.push(self.data.len());
        self.longs.insert_unique(h, (hb, g, idx), |e| combine(e.0, e.1 as u64));
    }

    /// Add `other`'s pairs, their groups mapped through `remap` (unmapped: dropped).
    fn merge(&mut self, other: &Part, remap: &[u32]) {
        let map = |g: u32| remap.get(g as usize).copied().filter(|&d| d != u32::MAX);
        for &(g, v) in other.ints.iter() {
            if let Some(d) = map(g) {
                self.insert_int(d, v, hash_u64(v as u64));
            }
        }
        for &(g, v) in other.shorts.iter() {
            if let Some(d) = map(g) {
                self.insert_short(d, v, hash_u128(v));
            }
        }
        for &(hb, g, i) in other.longs.iter() {
            if let Some(d) = map(g) {
                self.insert_long(d, other.bytes(i), hb);
            }
        }
    }

    fn len(&self) -> usize {
        self.ints.len() + self.shorts.len() + self.longs.len()
    }

    fn count_into(&self, counts: &mut [i64]) {
        self.ints.iter().for_each(|e| counts[e.0 as usize] += 1);
        self.shorts.iter().for_each(|e| counts[e.0 as usize] += 1);
        self.longs.iter().for_each(|e| counts[e.1 as usize] += 1);
    }

    fn state_bytes(&self) -> usize {
        self.ints.capacity() * 16 + self.shorts.capacity() * 32 + self.longs.capacity() * 16 + self.offsets.capacity() * 8 + self.data.capacity()
    }
}

#[inline(always)]
fn part_of(h: u64) -> usize {
    (h >> (64 - PART_BITS)) as usize
}

enum Kind {
    Int,
    /// Utf8View / BinaryView
    Views,
    /// any other type, compared in row format
    Rows(RowConverter),
}

pub struct CountDistinctAcc {
    parts: Vec<Part>,
    kind: Kind,
    /// groups of the table the state belongs to
    groups: usize,
    by_group: OnceLock<ByGroup>,
}

/// The pairs of each group: `(part, kind, entry)` from `starts[g]` to
/// `starts[g + 1]`, kind 0 = int, 1 = short, 2 = long.
struct ByGroup {
    starts: Vec<u32>,
    entries: Vec<(u16, u8, u128)>,
}

impl ByGroup {
    fn new(parts: &[Part]) -> Self {
        let groups = parts
            .iter()
            .flat_map(|p| {
                let ints = p.ints.iter().map(|e| e.0);
                let shorts = p.shorts.iter().map(|e| e.0);
                ints.chain(shorts).chain(p.longs.iter().map(|e| e.1))
            })
            .max()
            .map_or(0, |g| g as usize + 1);
        let mut starts = vec![0u32; groups + 1];
        let mut count = |g: u32| starts[g as usize + 1] += 1;
        for p in parts {
            p.ints.iter().for_each(|e| count(e.0));
            p.shorts.iter().for_each(|e| count(e.0));
            p.longs.iter().for_each(|e| count(e.1));
        }
        for g in 0..groups {
            starts[g + 1] += starts[g];
        }
        let mut at = starts.clone();
        let mut entries = vec![(0u16, 0u8, 0u128); starts[groups] as usize];
        let mut put = |g: u32, e: (u16, u8, u128)| {
            entries[at[g as usize] as usize] = e;
            at[g as usize] += 1;
        };
        for (pi, p) in parts.iter().enumerate() {
            let pi = pi as u16;
            p.ints.iter().for_each(|&(g, v)| put(g, (pi, 0, v as u64 as u128)));
            p.shorts.iter().for_each(|&(g, v)| put(g, (pi, 1, v)));
            p.longs.iter().for_each(|&(h, g, i)| put(g, (pi, 2, (h as u128) << 32 | i as u128)));
        }
        Self { starts, entries }
    }

    fn of(&self, g: u32) -> &[(u16, u8, u128)] {
        let g = g as usize;
        if g + 1 >= self.starts.len() {
            return &[];
        }
        &self.entries[self.starts[g] as usize..self.starts[g + 1] as usize]
    }
}

impl CountDistinctAcc {
    pub fn try_new(dt: &DataType) -> Result<Self> {
        let int_like = dt.is_integer() || matches!(dt, DataType::Date32 | DataType::Date64 | DataType::Timestamp(_, _));
        let kind = if int_like {
            Kind::Int
        } else if matches!(dt, DataType::Utf8View | DataType::BinaryView) {
            Kind::Views
        } else {
            Kind::Rows(RowConverter::new(vec![SortField::new(dt.clone())])?)
        };
        Ok(Self { parts: (0..PARTS).map(|_| Part::default()).collect(), kind, groups: 0, by_group: OnceLock::new() })
    }

    /// Add the pairs of `other`'s groups `src[i]` as groups `dst[i]`.
    fn merge_groups(&mut self, other: &CountDistinctAcc, src: &[u32], dst: &[u32]) {
        let index = other.by_group.get_or_init(|| ByGroup::new(&other.parts));
        for (&s, &d) in src.iter().zip(dst) {
            for &(p, kind, e) in index.of(s) {
                match kind {
                    0 => {
                        let v = e as u64 as i64;
                        let h = hash_u64(v as u64);
                        self.parts[part_of(h)].insert_int(d, v, h);
                    }
                    1 => {
                        let h = hash_u128(e);
                        self.parts[part_of(h)].insert_short(d, e, h);
                    }
                    _ => {
                        let (h, i) = ((e >> 32) as u64, e as u32);
                        self.parts[part_of(h)].insert_long(d, other.parts[p as usize].bytes(i), h);
                    }
                }
            }
        }
    }
}

impl Accumulator for CountDistinctAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], num_groups: usize) -> Result<()> {
        self.groups = self.groups.max(num_groups);
        let a = &values[0];
        let nulls = a.logical_nulls().filter(|n| n.null_count() > 0);
        let valid = |i: usize| nulls.as_ref().is_none_or(|n| n.is_valid(i));
        match &self.kind {
            Kind::Int => {
                let c = if a.data_type() == &DataType::Int64 { a.clone() } else { cast(a, &DataType::Int64)? };
                let vals = c.as_primitive::<Int64Type>().values();
                for (i, (&g, &v)) in gids.iter().zip(vals.iter()).enumerate() {
                    if valid(i) {
                        let h = hash_u64(v as u64);
                        self.parts[part_of(h)].insert_int(g, v, h);
                    }
                }
            }
            Kind::Views => {
                let (views, buffers) = match a.data_type() {
                    DataType::Utf8View => (a.as_string_view().views(), a.as_string_view().data_buffers()),
                    _ => (a.as_binary_view().views(), a.as_binary_view().data_buffers()),
                };
                for (i, (&g, &v)) in gids.iter().zip(views.iter()).enumerate() {
                    if !valid(i) {
                        continue;
                    }
                    let len = v as u32 as usize;
                    if len <= 12 {
                        let h = hash_u128(v);
                        self.parts[part_of(h)].insert_short(g, v, h);
                    } else {
                        let (buf, off) = ((v >> 64) as u32 as usize, (v >> 96) as u32 as usize);
                        let b = &buffers[buf].as_slice()[off..off + len];
                        let h = hash_bytes(b);
                        self.parts[part_of(h)].insert_long(g, b, h);
                    }
                }
            }
            Kind::Rows(conv) => {
                let rows = conv.convert_columns(std::slice::from_ref(a))?;
                let keep: Vec<(u32, usize)> = gids.iter().enumerate().filter(|(i, _)| valid(*i)).map(|(i, &g)| (g, i)).collect();
                for (g, i) in keep {
                    let b = rows.row(i);
                    let h = hash_bytes(b.as_ref());
                    self.parts[part_of(h)].insert_long(g, b.as_ref(), h);
                }
            }
        }
        Ok(())
    }

    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], num_groups: usize) -> Result<()> {
        let o = downcast::<CountDistinctAcc>(other)?;
        self.groups = self.groups.max(num_groups);
        if src.len().saturating_mul(PARTIAL_MERGE) < o.groups {
            self.merge_groups(o, src, dst);
            return Ok(());
        }
        let mut remap = vec![u32::MAX; src.iter().map(|&s| s as usize + 1).max().unwrap_or(0)];
        for (&s, &d) in src.iter().zip(dst) {
            remap[s as usize] = d;
        }
        let pairs: usize = o.parts.iter().map(|p| p.len()).sum();
        if pairs >= PARALLEL_MERGE {
            self.parts.par_iter_mut().zip(o.parts.par_iter()).for_each(|(a, b)| a.merge(b, &remap));
        } else {
            self.parts.iter_mut().zip(&o.parts).for_each(|(a, b)| a.merge(b, &remap));
        }
        Ok(())
    }

    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        let mut counts = vec![0i64; num_groups];
        for p in &self.parts {
            p.count_into(&mut counts);
        }
        Ok(Arc::new(Int64Array::from(counts)))
    }

    fn state_bytes(&self) -> usize {
        self.parts.iter().map(|p| p.state_bytes()).sum()
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn counts(acc: &mut CountDistinctAcc, n: usize) -> Vec<i64> {
        let r = acc.finish(n).unwrap();
        r.as_primitive::<Int64Type>().values().to_vec()
    }

    #[test]
    fn ints_strings_and_merge() {
        let mut a = CountDistinctAcc::try_new(&DataType::Int32).unwrap();
        let v: ArrayRef = Arc::new(Int32Array::from(vec![Some(1), Some(1), None, Some(2), Some(1)]));
        a.update(&[v], &[0, 0, 0, 0, 1], 2).unwrap();
        let mut b = CountDistinctAcc::try_new(&DataType::Int32).unwrap();
        let w: ArrayRef = Arc::new(Int32Array::from(vec![2, 3, 9]));
        b.update(&[w], &[0, 0, 1], 2).unwrap();
        // b's group 0 -> a's group 0, b's group 1 dropped
        a.merge(&b, &[0], &[0], 2).unwrap();
        assert_eq!(counts(&mut a, 2), vec![3, 1]);

        let long = "a string longer than twelve bytes";
        let mut s = CountDistinctAcc::try_new(&DataType::Utf8View).unwrap();
        let x: ArrayRef = Arc::new(StringViewArray::from(vec![Some("a"), Some(long), Some("a"), Some(long), None, Some("b")]));
        s.update(&[x], &[0, 0, 0, 0, 0, 1], 2).unwrap();
        assert_eq!(counts(&mut s, 2), vec![2, 1]);

        let mut f = CountDistinctAcc::try_new(&DataType::Float64).unwrap();
        let y: ArrayRef = Arc::new(Float64Array::from(vec![0.0, -0.0, 1.5, 1.5]));
        f.update(&[y], &[0, 0, 0, 0], 1).unwrap();
        assert_eq!(counts(&mut f, 1)[0], 3, "row format keeps -0.0 apart like the previous version");
    }

    #[test]
    fn partial_merges_read_their_groups() {
        // 100 groups of ints, shorts and longs; merged a few groups at a time
        let mut a = CountDistinctAcc::try_new(&DataType::Utf8View).unwrap();
        let vals: Vec<String> = (0..3000).map(|i| if i % 2 == 0 { format!("{}", i % 700) } else { format!("a longer string number {}", i % 900) }).collect();
        let gids: Vec<u32> = (0..3000).map(|i| (i % 100) as u32).collect();
        let x: ArrayRef = Arc::new(StringViewArray::from_iter_values(vals.iter()));
        a.update(&[x], &gids, 100).unwrap();
        let mut whole = CountDistinctAcc::try_new(&DataType::Utf8View).unwrap();
        let all: Vec<u32> = (0..100).collect();
        whole.merge(&a, &all, &all, 100).unwrap();
        let mut parts = CountDistinctAcc::try_new(&DataType::Utf8View).unwrap();
        for chunk in all.chunks(7) {
            parts.merge(&a, chunk, chunk, 100).unwrap();
        }
        assert!(a.by_group.get().is_some(), "partial merges use the index");
        assert_eq!(counts(&mut parts, 100), counts(&mut whole, 100));

        let mut b = CountDistinctAcc::try_new(&DataType::Int64).unwrap();
        let y: ArrayRef = Arc::new(Int64Array::from_iter_values((0..5000).map(|i| i % 1234)));
        let g: Vec<u32> = (0..5000).map(|i| (i % 50) as u32).collect();
        b.update(&[y], &g, 50).unwrap();
        let mut c = CountDistinctAcc::try_new(&DataType::Int64).unwrap();
        // groups 3 and 9 into 0 and 1
        c.merge(&b, &[3, 9], &[0, 1], 2).unwrap();
        let mut d = CountDistinctAcc::try_new(&DataType::Int64).unwrap();
        d.merge(&b, &(0..50).collect::<Vec<_>>(), &(0..50).collect::<Vec<_>>(), 50).unwrap();
        let full = counts(&mut d, 50);
        assert_eq!(counts(&mut c, 2), vec![full[3], full[9]]);
    }

    #[test]
    fn parallel_merge_of_large_sets() {
        let mut a = CountDistinctAcc::try_new(&DataType::Int64).unwrap();
        let mut b = CountDistinctAcc::try_new(&DataType::Int64).unwrap();
        let x: ArrayRef = Arc::new(Int64Array::from_iter_values(0..100_000));
        let y: ArrayRef = Arc::new(Int64Array::from_iter_values(50_000..150_000));
        a.update_single(&[x], 100_000).unwrap();
        b.update_single(&[y], 100_000).unwrap();
        a.merge(&b, &[0], &[0], 1).unwrap();
        assert_eq!(counts(&mut a, 1)[0], 150_000);
    }
}
