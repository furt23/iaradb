//! The hash table of joins on integer keys (one i64, or several packed into
//! one): an "unchained" table (Birler et al., *Simple, Efficient, and Robust
//! Hash Tables for Join Processing*, 2024).
//!
//! The entries `(key, build row)` are stored sorted by bucket; a directory
//! holds, per bucket, the end of its entries and a 16-bit bloom filter of
//! the hashes in it. A probe reads one directory word: most keys that are
//! not in the table stop there; the others scan their bucket's few
//! contiguous entries (rows with equal keys share a bucket). Probes run a
//! batch at a time, prefetching the directory words and entries of the rows
//! a few positions ahead so the cache misses overlap.
//!
//! Build: rows are radix-partitioned by the high bits of their hash (the
//! bucket's high bits) and every partition - a contiguous range of buckets
//! and of entries - is sorted into place by one task, while it fits in
//! cache. No atomics, no locks.

use rayon::prelude::*;

use arrow::buffer::NullBuffer;

use crate::hash::hash_u64;

/// Rows a partition gets about (its entries then fit in a core's cache).
const PARTITION_ROWS: usize = 1 << 15;
const MAX_PARTITION_BITS: u32 = 11;
/// Rows ahead of the probed one whose directory word is prefetched (their
/// entries are prefetched at half this distance).
const PREFETCH_AHEAD: usize = 16;
/// Build rows per histogram/scatter task.
const CHUNK_ROWS: usize = 1 << 16;

/// `[key, build row]`
type Entry = [u64; 2];

pub struct IntTable {
    /// per bucket: end of its entries `<< 16`, and a bloom filter of its hashes
    dir: Vec<u64>,
    /// sorted by bucket
    entries: Vec<Entry>,
    /// bucket of a hash: `h >> shift`
    shift: u32,
}

struct SendPtr<T>(*mut T);
unsafe impl<T> Send for SendPtr<T> {}
unsafe impl<T> Sync for SendPtr<T> {}

impl<T> SendPtr<T> {
    /// # Safety
    /// `i` is in bounds and no other thread writes the same element.
    #[inline(always)]
    unsafe fn at(&self, i: usize) -> *mut T {
        unsafe { self.0.add(i) }
    }
}

#[inline(always)]
fn prefetch<T>(p: *const T) {
    #[cfg(target_arch = "x86_64")]
    // SAFETY: a prefetch is a hint; it never faults
    unsafe {
        core::arch::x86_64::_mm_prefetch(p as *const i8, core::arch::x86_64::_MM_HINT_T0)
    }
    #[cfg(not(target_arch = "x86_64"))]
    let _ = p;
}

/// The bloom filter bit of a hash (its low bits; buckets use the high ones).
#[inline(always)]
fn tag(h: u64) -> u64 {
    1 << (h & 15)
}

impl IntTable {
    /// Index `keys` (row `i` has key `keys[i]`); rows with a null key
    /// (`valid` false) are left out: they match nothing.
    pub fn build(keys: &[i64], valid: Option<&NullBuffer>) -> Self {
        let n = keys.len();
        let bucket_bits = n.next_power_of_two().max(2).trailing_zeros();
        let shift = 64 - bucket_bits;
        let part_bits = (n / PARTITION_ROWS).max(1).next_power_of_two().trailing_zeros().clamp(1, MAX_PARTITION_BITS).min(bucket_bits);
        let pshift = 64 - part_bits;
        let np = 1usize << part_bits;
        let is_valid = |r: usize| valid.is_none_or(|v| v.is_valid(r));

        // 1. per chunk partition histograms
        let chunks: Vec<std::ops::Range<usize>> = (0..n).step_by(CHUNK_ROWS).map(|s| s..(s + CHUNK_ROWS).min(n)).collect();
        let hist: Vec<Vec<u32>> = chunks
            .par_iter()
            .map(|r| {
                let mut h = vec![0u32; np];
                for i in r.clone() {
                    if is_valid(i) {
                        h[(hash_u64(keys[i] as u64) >> pshift) as usize] += 1;
                    }
                }
                h
            })
            .collect();
        // 2. where each chunk writes the rows of each partition
        let mut starts = vec![vec![0usize; np]; chunks.len()];
        let mut part_rows = Vec::with_capacity(np);
        let mut at = 0usize;
        for p in 0..np {
            let first = at;
            for (c, h) in hist.iter().enumerate() {
                starts[c][p] = at;
                at += h[p] as usize;
            }
            part_rows.push(first..at);
        }
        // 3. entries in partition order
        let mut entries: Vec<Entry> = vec![[0, 0]; at];
        let eptr = SendPtr(entries.as_mut_ptr());
        chunks.par_iter().zip(starts.into_par_iter()).for_each(|(r, mut pos)| {
            for i in r.clone() {
                if is_valid(i) {
                    let k = keys[i] as u64;
                    let p = (hash_u64(k) >> pshift) as usize;
                    // SAFETY: the position ranges of chunks and partitions are disjoint
                    unsafe { *eptr.at(pos[p]) = [k, i as u64] };
                    pos[p] += 1;
                }
            }
        });
        // 4. every partition sorted by bucket, its directory words written, by one task
        let mut dir = vec![0u64; 1usize << bucket_bits];
        let dptr = SendPtr(dir.as_mut_ptr());
        let buckets_per_part = 1usize << (bucket_bits - part_bits);
        part_rows.into_par_iter().enumerate().for_each(|(p, rows)| {
            // SAFETY: partitions own disjoint entry ranges
            let mine = unsafe { std::slice::from_raw_parts_mut(eptr.at(rows.start), rows.len()) };
            let local = mine.to_vec();
            let first_bucket = p * buckets_per_part;
            let mut ends = vec![0u32; buckets_per_part];
            let mut tags = vec![0u16; buckets_per_part];
            for e in &local {
                let h = hash_u64(e[0]);
                let b = (h >> shift) as usize - first_bucket;
                ends[b] += 1;
                tags[b] |= tag(h) as u16;
            }
            let mut acc = 0u32;
            for c in ends.iter_mut() {
                acc += *c;
                *c = acc;
            }
            for (b, (&end, &t)) in ends.iter().zip(&tags).enumerate() {
                // SAFETY: the partition owns these buckets
                unsafe { *dptr.at(first_bucket + b) = ((rows.start as u64 + end as u64) << 16) | t as u64 };
            }
            // place entries back to front, so each bucket keeps build row order
            for e in local.iter().rev() {
                let b = (hash_u64(e[0]) >> shift) as usize - first_bucket;
                ends[b] -= 1;
                mine[ends[b] as usize] = *e;
            }
        });
        Self { dir, entries, shift }
    }

    /// Bytes the table holds.
    pub fn bytes(&self) -> usize {
        self.dir.len() * 8 + self.entries.len() * std::mem::size_of::<Entry>()
    }

    /// Bytes a table of `rows` rows needs (an upper bound).
    pub fn bytes_for(rows: usize) -> usize {
        rows.next_power_of_two() * 8 + rows * std::mem::size_of::<Entry>()
    }

    /// Entries of bucket `b`, given its directory word `d`.
    #[inline(always)]
    fn range(&self, b: usize, d: u64) -> (usize, usize) {
        // SAFETY: b - 1 is a bucket when b > 0
        let start = if b == 0 { 0 } else { (unsafe { *self.dir.get_unchecked(b - 1) }) >> 16 };
        (start as usize, (d >> 16) as usize)
    }

    /// Call `on_match(probe_row, build_row)` for every build row whose key
    /// equals a valid probe key; returning false skips that probe row's
    /// remaining matches.
    #[inline]
    pub fn probe(&self, keys: &[i64], valid: Option<&[bool]>, mut on_match: impl FnMut(usize, usize) -> bool) {
        let n = keys.len();
        let hashes: Vec<u64> = keys.iter().map(|&k| hash_u64(k as u64)).collect();
        let dir = self.dir.as_ptr();
        let entries = self.entries.as_ptr();
        let half = PREFETCH_AHEAD / 2;
        for i in 0..n {
            if i + PREFETCH_AHEAD < n {
                // SAFETY: buckets are < dir.len()
                prefetch(unsafe { dir.add((hashes[i + PREFETCH_AHEAD] >> self.shift) as usize) });
            }
            if i + half < n {
                let h = hashes[i + half];
                let b = (h >> self.shift) as usize;
                // SAFETY: as above; the entry range is in bounds
                let d = unsafe { *dir.add(b) };
                if d & tag(h) != 0 {
                    prefetch(unsafe { entries.add(self.range(b, d).0) });
                }
            }
            if valid.is_some_and(|v| !v[i]) {
                continue;
            }
            let h = hashes[i];
            let b = (h >> self.shift) as usize;
            let d = unsafe { *dir.add(b) };
            if d & tag(h) == 0 {
                continue;
            }
            let (start, end) = self.range(b, d);
            let k = keys[i] as u64;
            for e in &self.entries[start..end] {
                if e[0] == k && !on_match(i, e[1] as usize) {
                    break;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn matches(t: &IntTable, keys: &[i64]) -> Vec<(usize, usize)> {
        let mut out = vec![];
        t.probe(keys, None, |i, b| {
            out.push((i, b));
            true
        });
        out.sort();
        out
    }

    #[test]
    fn unique_and_duplicate_keys() {
        let build = [5i64, 7, 5, -1, 9, 5];
        let t = IntTable::build(&build, None);
        assert_eq!(matches(&t, &[5, 8, 9, -1]), vec![(0, 0), (0, 2), (0, 5), (2, 4), (3, 3)]);
        assert!(matches(&IntTable::build(&[], None), &[1, 2]).is_empty());
    }

    #[test]
    fn null_build_keys_never_match() {
        let build = [1i64, 2, 3];
        let nulls = NullBuffer::from(vec![true, false, true]);
        let t = IntTable::build(&build, Some(&nulls));
        assert_eq!(matches(&t, &[1, 2, 3]), vec![(0, 0), (2, 2)]);
    }

    #[test]
    fn invalid_probe_rows_and_early_stop() {
        let t = IntTable::build(&[4i64, 4, 4], None);
        let mut seen = vec![];
        t.probe(&[4, 4], Some(&[false, true]), |i, b| {
            seen.push((i, b));
            false
        });
        assert_eq!(seen, vec![(1, 0)], "first build row first");
    }

    #[test]
    fn many_partitions_match_a_reference() {
        let n = 300_000usize;
        let build: Vec<i64> = (0..n as i64).map(|i| (i * 7919) % 200_003).collect();
        let t = IntTable::build(&build, None);
        let probe: Vec<i64> = (0..50_000i64).map(|i| i * 3).collect();
        let mut want = vec![];
        let mut by_key: std::collections::HashMap<i64, Vec<usize>> = Default::default();
        for (r, &k) in build.iter().enumerate() {
            by_key.entry(k).or_default().push(r);
        }
        for (i, k) in probe.iter().enumerate() {
            for &r in by_key.get(k).map(|v| v.as_slice()).unwrap_or(&[]) {
                want.push((i, r));
            }
        }
        want.sort();
        assert_eq!(matches(&t, &probe), want);
    }
}
