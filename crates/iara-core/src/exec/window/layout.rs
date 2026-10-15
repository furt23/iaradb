//! The rows of a window specification in evaluation order: sorted by
//! (partition keys, order keys), split into partitions and peer groups.

use std::ops::Range;
use std::sync::OnceLock;

use arrow::array::{Array, ArrayRef, UInt32Array};
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
    perm: Option<Vec<u32>>,
    inverse: OnceLock<Vec<u32>>,
    /// partition ranges over sorted positions, covering `0..n` in order
    pub partitions: Vec<Range<usize>>,
    /// first position of each row's peer group (rows with equal order keys)
    pub peer_start: Vec<u32>,
    /// one past the last position of each row's peer group
    pub peer_end: Vec<u32>,
    /// the order key in sorted order when there is exactly one (RANGE offsets)
    pub order_key: Option<(ArrayRef, SortOptions)>,
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
        let mut partitions = vec![];
        let mut start = 0;
        for i in 1..n {
            if part_breaks[i] {
                partitions.push(start..i);
                start = i;
            }
        }
        if n > 0 {
            partitions.push(start..n);
        }
        let mut peer_start = vec![0u32; n];
        let mut s = 0;
        for i in 0..n {
            if peer_breaks[i] {
                s = i;
            }
            peer_start[i] = s as u32;
        }
        let mut peer_end = vec![0u32; n];
        let mut e = n;
        for i in (0..n).rev() {
            peer_end[i] = e as u32;
            if peer_start[i] as usize == i {
                e = i;
            }
        }
        let order_key = match (okeys.len(), &perm) {
            (1, Some(p)) => Some((take(&okeys[0], &UInt32Array::from(p.clone()), None)?, oopts[0])),
            (1, None) => Some((okeys[0].clone(), oopts[0])),
            _ => None,
        };
        Ok(Self { n, perm, inverse: OnceLock::new(), partitions, peer_start, peer_end, order_key })
    }

    /// The input row at a sorted position.
    #[inline]
    pub fn row(&self, i: usize) -> usize {
        match &self.perm {
            Some(p) => p[i] as usize,
            None => i,
        }
    }

    fn inverse(&self) -> Option<&Vec<u32>> {
        let p = self.perm.as_ref()?;
        Some(self.inverse.get_or_init(|| {
            let mut inv = vec![0u32; p.len()];
            for (i, &r) in p.iter().enumerate() {
                inv[r as usize] = i as u32;
            }
            inv
        }))
    }

    /// An input-order array in sorted order.
    pub fn sorted(&self, a: &ArrayRef) -> Result<ArrayRef> {
        Ok(match &self.perm {
            Some(p) => take(a, &UInt32Array::from(p.clone()), None)?,
            None => a.clone(),
        })
    }

    /// A sorted-order array back in input order.
    pub fn unsort(&self, a: ArrayRef) -> Result<ArrayRef> {
        Ok(match self.inverse() {
            Some(inv) => take(&a, &UInt32Array::from(inv.clone()), None)?,
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
