//! The rows of a window specification in evaluation order: sorted by
//! (partition keys, order keys), split into partitions and peer groups.

use std::ops::Range;
use std::sync::OnceLock;

use arrow::array::{Array, ArrayRef, UInt32Array};
use arrow::buffer::ScalarBuffer;
use arrow::compute::{SortOptions, take};
use arrow::row::{RowConverter, SortField};
use rayon::prelude::*;

use crate::error::Result;
use crate::exec::packed_sort;
use crate::exec::sort::sort_indices;
use crate::physical::expr::{PhysExpr, PhysSortExpr};

/// Marks a missing position in index outputs.
pub const NO_ROW: u32 = u32::MAX;

pub struct Layout {
    pub n: usize,
    /// sorted position -> input row (`None`: the input order is kept)
    perm: Option<ScalarBuffer<u32>>,
    /// input row -> sorted position
    inverse: OnceLock<ScalarBuffer<u32>>,
    /// partition ranges over sorted positions, covering `0..n` in order
    pub partitions: Vec<Range<usize>>,
    /// positions where the (partition, order) keys change
    peer_breaks: Vec<bool>,
    /// first and one past the last position of each row's peer group (rows
    /// with equal order keys): built on first use (ranking, RANGE / GROUPS frames)
    peers: OnceLock<(Vec<u32>, Vec<u32>)>,
    /// the order keys (input order) and their options
    okeys: Vec<ArrayRef>,
    oopts: Vec<SortOptions>,
    /// the order key in sorted order when there is exactly one (RANGE offsets)
    order_key: OnceLock<Option<(ArrayRef, SortOptions)>>,
}

/// The sort permutation (`None`: no keys) with the positions where the
/// partition keys change and where the (partition, order) keys change.
type Sorted = (Option<Vec<u32>>, Vec<bool>, Vec<bool>);

fn sort_rows(n: usize, pkeys: &[ArrayRef], okeys: &[ArrayRef], oopts: &[SortOptions]) -> Result<Sorted> {
    if pkeys.is_empty() && okeys.is_empty() {
        return Ok((None, vec![false; n], vec![false; n]));
    }
    let mut keys = pkeys.to_vec();
    keys.extend(okeys.iter().cloned());
    let mut opts = vec![SortOptions::default(); pkeys.len()];
    opts.extend(oopts.iter().copied());
    // stable: ties keep their input order
    if let Some(p) = packed_sort::sort(&keys, &opts) {
        let (part, peer) = (p.breaks(pkeys.len()), p.breaks(keys.len()));
        return Ok((Some(p.perm), part, peer));
    }
    let perm = sort_indices(&keys, &opts, None)?;
    let order: Vec<usize> = perm.iter().map(|&r| r as usize).collect();
    let part = key_breaks(pkeys, &order)?;
    let mut peer = key_breaks(okeys, &order)?;
    peer.par_iter_mut().zip(&part).for_each(|(b, p)| *b |= *p);
    Ok((Some(perm), part, peer))
}

/// `true` at each position whose keys differ from the previous position's.
fn key_breaks(keys: &[ArrayRef], order: &[usize]) -> Result<Vec<bool>> {
    let n = order.len();
    if keys.is_empty() {
        return Ok(vec![false; n]);
    }
    let fields = keys.iter().map(|k| SortField::new(k.data_type().clone())).collect();
    let rows = RowConverter::new(fields)?.convert_columns(keys)?;
    Ok((0..n).into_par_iter().map(|i| i > 0 && rows.row(order[i]) != rows.row(order[i - 1])).collect())
}

impl Layout {
    pub fn new(batch: &arrow::record_batch::RecordBatch, partition_by: &[PhysExpr], order_by: &[PhysSortExpr]) -> Result<Self> {
        let n = batch.num_rows();
        let pkeys = partition_by.iter().map(|e| e.evaluate_array(batch)).collect::<Result<Vec<_>>>()?;
        let okeys = order_by.iter().map(|e| e.expr.evaluate_array(batch)).collect::<Result<Vec<_>>>()?;
        let oopts: Vec<SortOptions> =
            order_by.iter().map(|k| SortOptions { descending: k.descending, nulls_first: k.nulls_first }).collect();
        let (perm, part_breaks, peer_breaks) = sort_rows(n, &pkeys, &okeys, &oopts)?;
        let starts: Vec<usize> = part_breaks.par_iter().enumerate().with_min_len(1 << 16).filter(|&(i, &b)| b && i > 0).map(|(i, _)| i).collect();
        let mut partitions = Vec::with_capacity(starts.len() + 1);
        let mut start = 0;
        for i in starts {
            partitions.push(start..i);
            start = i;
        }
        if n > 0 {
            partitions.push(start..n);
        }
        Ok(Self {
            n,
            perm: perm.map(ScalarBuffer::from),
            inverse: OnceLock::new(),
            partitions,
            peer_breaks,
            peers: OnceLock::new(),
            okeys,
            oopts,
            order_key: OnceLock::new(),
        })
    }

    /// First position of each row's peer group.
    pub fn peer_start(&self) -> &[u32] {
        &self.peers().0
    }

    /// One past the last position of each row's peer group.
    pub fn peer_end(&self) -> &[u32] {
        &self.peers().1
    }

    /// The lazy values are built outside their cells: building runs rayon
    /// tasks, and a thread waiting for those can run a sibling task that reads
    /// the same cell, which would then wait for the build it is nested in. Two
    /// threads may build the same value; window functions that read the peer
    /// groups build them before their parallel tasks (see `evaluate_function`).
    fn peers(&self) -> &(Vec<u32>, Vec<u32>) {
        if let Some(p) = self.peers.get() {
            return p;
        }
        let built = self.build_peers();
        self.peers.get_or_init(|| built)
    }

    fn build_peers(&self) -> (Vec<u32>, Vec<u32>) {
        // in parallel chunks: each chunk's first group starts where the
        // last break before the chunk is (and its last ends at the first after)
        const CHUNK: usize = 1 << 16;
        let n = self.n;
        let breaks = &self.peer_breaks;
        let firsts: Vec<Option<usize>> = breaks.par_chunks(CHUNK).enumerate().map(|(c, b)| b.iter().position(|&x| x).map(|i| c * CHUNK + i)).collect();
        let lasts: Vec<Option<usize>> = breaks.par_chunks(CHUNK).enumerate().map(|(c, b)| b.iter().rposition(|&x| x).map(|i| c * CHUNK + i)).collect();
        let mut carry_in = vec![0usize; firsts.len()];
        for c in 1..firsts.len() {
            carry_in[c] = lasts[c - 1].unwrap_or(carry_in[c - 1]);
        }
        let mut carry_out = vec![n; firsts.len()];
        for c in (0..firsts.len().saturating_sub(1)).rev() {
            carry_out[c] = firsts[c + 1].unwrap_or(carry_out[c + 1]);
        }
        let mut peer_start = vec![0u32; n];
        peer_start.par_chunks_mut(CHUNK).enumerate().for_each(|(c, out)| {
            let mut s = carry_in[c];
            for (k, o) in out.iter_mut().enumerate() {
                let i = c * CHUNK + k;
                if breaks[i] {
                    s = i;
                }
                *o = s as u32;
            }
        });
        let mut peer_end = vec![0u32; n];
        peer_end.par_chunks_mut(CHUNK).enumerate().for_each(|(c, out)| {
            let mut e = carry_out[c];
            for k in (0..out.len()).rev() {
                out[k] = e as u32;
                let i = c * CHUNK + k;
                if peer_start[i] as usize == i {
                    e = i;
                }
            }
        });
        (peer_start, peer_end)
    }

    /// The order key in sorted order when there is exactly one.
    pub fn order_key(&self) -> Result<Option<&(ArrayRef, SortOptions)>> {
        if let Some(k) = self.order_key.get() {
            return Ok(k.as_ref());
        }
        let k = match (self.okeys.len(), &self.perm) {
            (1, Some(p)) => Some((par_take(&self.okeys[0], p)?, self.oopts[0])),
            (1, None) => Some((self.okeys[0].clone(), self.oopts[0])),
            _ => None,
        };
        Ok(self.order_key.get_or_init(|| k).as_ref())
    }

    /// The input row at a sorted position.
    #[inline]
    pub fn row(&self, i: usize) -> usize {
        match &self.perm {
            Some(p) => p[i] as usize,
            None => i,
        }
    }

    /// Built outside its cell, as [`Layout::peers`].
    fn inverse(&self) -> Option<&ScalarBuffer<u32>> {
        let p = self.perm.as_ref()?;
        if let Some(inv) = self.inverse.get() {
            return Some(inv);
        }
        let mut inv = vec![0u32; p.len()];
        let out = Out(inv.as_mut_ptr());
        p.par_chunks(1 << 16).enumerate().for_each(|(c, rows)| {
            let out = out;
            for (k, &r) in rows.iter().enumerate() {
                // SAFETY: `p` is a permutation of 0..n: every row is written once
                unsafe { out.0.add(r as usize).write((c * (1 << 16) + k) as u32) };
            }
        });
        Some(self.inverse.get_or_init(|| ScalarBuffer::from(inv)))
    }

    /// An input-order array in sorted order.
    pub fn sorted(&self, a: &ArrayRef) -> Result<ArrayRef> {
        Ok(match &self.perm {
            Some(p) => par_take(a, p)?,
            None => a.clone(),
        })
    }

    /// A sorted-order array back in input order.
    pub fn unsort(&self, a: ArrayRef) -> Result<ArrayRef> {
        Ok(match self.inverse() {
            Some(inv) => par_take(&a, inv)?,
            None => a,
        })
    }

    /// For every row, the value of `values` (input order) at the sorted
    /// position `idx[pos]` ([`NO_ROW`] = null). Returns the values in input
    /// order and which rows had no position.
    pub fn gather(&self, values: &ArrayRef, idx: &[u32]) -> Result<(ArrayRef, Vec<bool>)> {
        let mut rows: Vec<Option<u32>> = vec![None; self.n];
        for (i, &j) in idx.iter().enumerate() {
            if j != NO_ROW {
                rows[self.row(i)] = Some(self.row(j as usize) as u32);
            }
        }
        let missing = rows.iter().map(|r| r.is_none()).collect();
        Ok((take(values, &UInt32Array::from(rows), None)?, missing))
    }

    /// Run `f` over every partition (in parallel, a few partitions per task);
    /// `f` fills the outputs of the partition's sorted positions.
    pub fn for_partitions<T, F>(&self, init: T, f: F) -> Result<Vec<T>>
    where
        T: Clone + Send + Sync,
        F: Fn(Range<usize>, &mut [T]) -> Result<()> + Sync,
    {
        self.for_chunks(init, false, |p, _, out| f(p, out))
    }

    /// Like [`Layout::for_partitions`], but with `split` a large partition is
    /// cut into chunks of rows that run in parallel: `f(partition, rows, out)`
    /// fills the outputs of `rows`, a sub-range of `partition`.
    pub fn for_chunks<T, F>(&self, init: T, split: bool, f: F) -> Result<Vec<T>>
    where
        T: Clone + Send + Sync,
        F: Fn(Range<usize>, Range<usize>, &mut [T]) -> Result<()> + Sync,
    {
        let mut out = vec![init; self.n];
        let target = (self.n / (rayon::current_num_threads() * 4)).max(4096);
        let units = self.units(split, target);
        // consecutive units grouped into tasks of about `target` rows
        let mut tasks: Vec<(&[Unit], &mut [T])> = vec![];
        let mut rest: &mut [T] = &mut out;
        let mut i = 0;
        while i < units.len() {
            let first = i;
            let start = units[i].1.start;
            while i < units.len() && (i == first || units[i].1.end - start <= target) {
                i += 1;
            }
            let len = units[i - 1].1.end - start;
            let (head, tail) = std::mem::take(&mut rest).split_at_mut(len);
            tasks.push((&units[first..i], head));
            rest = tail;
        }
        tasks.into_par_iter().try_for_each(|(units, slice)| {
            let base = units[0].1.start;
            units.iter().try_for_each(|(p, r)| f(p.clone(), r.clone(), &mut slice[r.start - base..r.end - base]))
        })?;
        Ok(out)
    }

    /// (partition, rows) work units covering `0..n` in order.
    fn units(&self, split: bool, target: usize) -> Vec<Unit> {
        let mut units = Vec::with_capacity(self.partitions.len());
        for p in &self.partitions {
            if !split || p.len() <= target {
                units.push((p.clone(), p.clone()));
                continue;
            }
            let mut s = p.start;
            while s < p.end {
                let e = (s + target).min(p.end);
                units.push((p.clone(), s..e));
                s = e;
            }
        }
        units
    }
}

/// A partition and the rows of it that one call fills.
type Unit = (Range<usize>, Range<usize>);

/// A pointer written from several threads at disjoint positions.
#[derive(Clone, Copy)]
struct Out(*mut u32);
// SAFETY: every thread writes positions no other thread writes
unsafe impl Send for Out {}
unsafe impl Sync for Out {}

/// `take(a, idx)` in parallel chunks (the indices are shared, not copied).
fn par_take(a: &ArrayRef, idx: &ScalarBuffer<u32>) -> Result<ArrayRef> {
    const CHUNK: usize = 1 << 18;
    if idx.len() <= CHUNK {
        return Ok(take(a, &UInt32Array::new(idx.clone(), None), None)?);
    }
    let parts = (0..idx.len().div_ceil(CHUNK))
        .into_par_iter()
        .map(|c| {
            let s = c * CHUNK;
            let part = UInt32Array::new(idx.slice(s, CHUNK.min(idx.len() - s)), None);
            take(a, &part, None)
        })
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let refs: Vec<&dyn Array> = parts.iter().map(|p| p.as_ref()).collect();
    Ok(arrow::compute::concat(&refs)?)
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// `n` rows in input order, a peer group every 3 rows.
    fn layout(n: usize) -> Layout {
        Layout {
            n,
            perm: Some(ScalarBuffer::from((0..n as u32).rev().collect::<Vec<_>>())),
            inverse: OnceLock::new(),
            partitions: vec![0..n],
            peer_breaks: (0..n).map(|i| i % 3 == 0).collect(),
            peers: OnceLock::new(),
            okeys: vec![],
            oopts: vec![],
            order_key: OnceLock::new(),
        }
    }

    /// A thread building a lazy value waits for its rayon tasks; while one of
    /// them runs elsewhere it steals other work, here a reader of the same
    /// value queued behind a slow task. That reader must not wait for the
    /// build it is nested in.
    #[test]
    fn lazy_values_read_from_parallel_tasks_do_not_deadlock() {
        let (done, finished) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let pool = rayon::ThreadPoolBuilder::new().num_threads(3).build().unwrap();
            let slow = || std::thread::sleep(Duration::from_millis(20));
            pool.install(|| {
                for _ in 0..50 {
                    let l = layout(1 << 21);
                    // one thread builds, another queues a reader behind `slow`, the third steals
                    rayon::join(|| l.peer_start()[7], || rayon::join(slow, || l.peer_start()[7]));
                    let l = layout(1 << 21);
                    rayon::join(|| l.inverse().map(|i| i[0]), || rayon::join(slow, || l.inverse().map(|i| i[0])));
                }
            });
            let _ = done.send(());
        });
        finished.recv_timeout(Duration::from_secs(120)).expect("reading the lazy values from parallel tasks deadlocked");
    }
}
