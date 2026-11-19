//! Fetching the bytes of upcoming morsels while workers decode current ones.
//!
//! Morsels are claimed roughly in order, so a background task fetches them
//! in order, a window of them at a time, under a memory budget: each fetched
//! morsel holds its share of the budget until the worker that takes it is
//! done with it. Workers block only when their morsel has not arrived yet.
//!
//! Consecutive morsels of one object can be fetched as a group (one
//! `get_ranges` call, whose ranges then coalesce into a few big requests,
//! see [`FetchGroups`]): fewer requests, billed per request, for the same bytes.

use std::ops::Range;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures::StreamExt;
use parking_lot::{Condvar, Mutex};
use tokio::sync::{Semaphore, watch};
use tokio::task::JoinHandle;

use super::file::ObjectFile;
use super::runtime::runtime;
use crate::error::{Result, WhError};
use crate::exec::query::QueryHandle;
use crate::io::blob::RangeChunks;

/// Ranges of one object a morsel needs.
pub struct FetchJob {
    pub file: ObjectFile,
    pub ranges: Vec<Range<u64>>,
}

/// The ranges of consecutive morsels of one object, fetched together.
pub struct FetchGroup {
    file: ObjectFile,
    /// the ranges of each morsel of the group
    parts: Vec<Vec<Range<u64>>>,
    bytes: u64,
}

impl FetchGroup {
    fn new(file: ObjectFile) -> Self {
        Self { file, parts: vec![], bytes: 0 }
    }

    fn push(&mut self, ranges: Vec<Range<u64>>) {
        self.bytes += ranges.iter().map(|r| r.end - r.start).sum::<u64>();
        self.parts.push(ranges);
    }

    /// One fetch for the whole group, cut back into its morsels' bytes.
    async fn run(&self) -> Result<Vec<RangeChunks>> {
        let all: Vec<Range<u64>> = self.parts.iter().flatten().cloned().collect();
        let mut bytes = self.file.get_ranges(&all).await?.into_iter();
        Ok(self
            .parts
            .iter()
            .map(|ranges| RangeChunks::new(self.file.size, ranges.iter().map(|r| r.start).zip(bytes.by_ref()).collect()))
            .collect())
    }
}

/// Builds the groups for morsels given in order: a morsel joins the group
/// of the one before it when they read the same object and the group stays
/// within `target` bytes (a target of 0 makes every morsel its own group).
pub struct FetchGroups {
    target: u64,
    last_file: Option<usize>,
    groups: Vec<FetchGroup>,
}

impl FetchGroups {
    pub fn new(target: u64) -> Self {
        Self { target, last_file: None, groups: vec![] }
    }

    /// The next morsel, reading `ranges` of `file` (`file_id` tells objects apart).
    pub fn push(&mut self, file_id: usize, file: &ObjectFile, ranges: Vec<Range<u64>>) {
        let bytes: u64 = ranges.iter().map(|r| r.end - r.start).sum();
        let joins = self.last_file == Some(file_id) && self.groups.last().is_some_and(|g| g.bytes + bytes <= self.target);
        if !joins {
            self.groups.push(FetchGroup::new(file.clone()));
        }
        self.groups.last_mut().expect("a group").push(ranges);
        self.last_file = Some(file_id);
    }

    pub fn finish(self) -> Vec<FetchGroup> {
        self.groups
    }
}

/// A fetched group's share of the prefetch budget, given back when the last
/// of its morsels is done with its bytes.
pub(crate) struct Held {
    sem: Arc<Semaphore>,
    kib: usize,
}

impl Held {
    /// Take `bytes` of the budget behind `sem` (in KiB; all of it for more than `budget`),
    /// waiting until that much is free. `None` once the semaphore is closed.
    pub(crate) async fn acquire(sem: &Arc<Semaphore>, bytes: u64, budget: u64) -> Option<Arc<Held>> {
        let kib = (bytes.min(budget) >> 10).max(1) as u32;
        let permit = sem.clone().acquire_many_owned(kib).await.ok()?;
        permit.forget();
        Some(Arc::new(Held { sem: sem.clone(), kib: kib as usize }))
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        self.sem.add_permits(self.kib);
    }
}

/// A morsel's bytes; the budget they take is released on drop (when all the
/// morsels fetched with it are dropped).
pub struct Fetched {
    pub chunks: RangeChunks,
    _held: Option<Arc<Held>>,
}

enum SlotState {
    Pending,
    Ready(Result<Fetched>),
    Taken,
}

struct Slot {
    state: Mutex<SlotState>,
    ready: Condvar,
}

impl Slot {
    fn fill(&self, r: Result<Fetched>) {
        *self.state.lock() = SlotState::Ready(r);
        self.ready.notify_all();
    }
}

/// `IARA_REMOTE_PREFETCH`: groups of morsels fetched concurrently (0
/// disables prefetching: workers fetch their own morsel when they claim it).
pub fn window() -> usize {
    std::env::var("IARA_REMOTE_PREFETCH").ok().and_then(|v| v.parse().ok()).unwrap_or(16)
}

/// `IARA_REMOTE_PREFETCH_MB`: bytes fetched but not yet decoded.
pub fn budget_bytes() -> u64 {
    let mb: u64 = std::env::var("IARA_REMOTE_PREFETCH_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(256);
    mb.max(1) << 20
}

pub struct Prefetcher {
    groups: Arc<Vec<FetchGroup>>,
    /// one slot per morsel, in group order
    slots: Arc<Vec<Slot>>,
    /// the first morsel of each group
    firsts: Arc<Vec<usize>>,
    window: usize,
    /// fetch no more than this many groups past the last one a worker took
    /// (`None`: as many as the budget holds)
    lookahead: Option<usize>,
    /// groups with a morsel taken, counting from the first
    taken: watch::Sender<usize>,
    started: AtomicBool,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Prefetcher {
    /// One morsel per job.
    pub fn new(jobs: Vec<FetchJob>, window: usize) -> Self {
        let groups = jobs
            .into_iter()
            .map(|j| {
                let mut g = FetchGroup::new(j.file);
                g.push(j.ranges);
                g
            })
            .collect();
        Self::grouped(groups, window)
    }

    /// The morsels of `groups`, numbered in order.
    pub fn grouped(groups: Vec<FetchGroup>, window: usize) -> Self {
        let firsts: Vec<usize> = groups.iter().scan(0, |n, g| Some(std::mem::replace(n, *n + g.parts.len()))).collect();
        let morsels = groups.iter().map(|g| g.parts.len()).sum::<usize>();
        let slots = (0..morsels).map(|_| Slot { state: Mutex::new(SlotState::Pending), ready: Condvar::new() }).collect();
        Self {
            groups: Arc::new(groups),
            slots: Arc::new(slots),
            firsts: Arc::new(firsts),
            window: window.max(1),
            lookahead: None,
            taken: watch::channel(0).0,
            started: AtomicBool::new(false),
            task: Mutex::new(None),
        }
    }

    /// Fetch at most `groups` groups past the last one a worker took: a
    /// query that stops early (a LIMIT) leaves few fetched, unread groups behind.
    pub fn with_lookahead(mut self, groups: usize) -> Self {
        self.lookahead = Some(groups.max(1));
        self
    }

    /// The bytes of morsel `i` (waiting for them if needed). Each morsel is
    /// taken once.
    pub fn take(&self, i: usize, cancel: Option<&QueryHandle>) -> Result<Fetched> {
        self.start();
        let group = self.firsts.partition_point(|&first| first <= i);
        self.taken.send_if_modified(|n| std::mem::replace(n, (*n).max(group)) < group);
        let slot = &self.slots[i];
        let mut st = slot.state.lock();
        loop {
            match std::mem::replace(&mut *st, SlotState::Taken) {
                SlotState::Ready(r) => return r,
                SlotState::Taken => return Err(WhError::Execution(format!("morsel {i} was already taken"))),
                SlotState::Pending => *st = SlotState::Pending,
            }
            if cancel.is_some_and(|q| q.is_cancelled()) {
                return Err(WhError::Cancelled);
            }
            slot.ready.wait_for(&mut st, Duration::from_millis(50));
        }
    }

    /// Start fetching on first use (planning alone fetches nothing).
    fn start(&self) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let (groups, slots, firsts, window) = (self.groups.clone(), self.slots.clone(), self.firsts.clone(), self.window);
        let (lookahead, taken) = (self.lookahead, self.taken.subscribe());
        let budget = budget_bytes();
        let sem = Arc::new(Semaphore::new((budget >> 10) as usize));
        let handle = runtime().spawn(async move {
            futures::stream::iter(0..groups.len())
                .for_each_concurrent(window, |g| {
                    let (groups, slots, firsts, sem, mut taken) = (groups.clone(), slots.clone(), firsts.clone(), sem.clone(), taken.clone());
                    async move {
                        if let Some(ahead) = lookahead {
                            // not before the workers are close (the sender is gone: the query is over)
                            if taken.wait_for(|&taken| g < taken + ahead).await.is_err() {
                                return;
                            }
                        }
                        let group = &groups[g];
                        // a group larger than the whole budget goes alone
                        let held = Held::acquire(&sem, group.bytes, budget).await;
                        fill(&slots[firsts[g]..firsts[g] + group.parts.len()], group.run().await, held);
                    }
                })
                .await
        });
        *self.task.lock() = Some(handle);
    }
}

/// Hand a group's morsels (their `slots`) their bytes, or its error.
fn fill(slots: &[Slot], fetched: Result<Vec<RangeChunks>>, held: Option<Arc<Held>>) {
    match fetched {
        Ok(chunks) => {
            for (slot, chunks) in slots.iter().zip(chunks) {
                slot.fill(Ok(Fetched { chunks, _held: held.clone() }));
            }
        }
        Err(e) => {
            // errors are not clonable: the first morsel gets this one, the others its message
            let message = e.to_string();
            let mut first = Some(e);
            for slot in slots {
                slot.fill(Err(first.take().unwrap_or_else(|| WhError::Storage(message.clone()))));
            }
        }
    }
}

impl Drop for Prefetcher {
    fn drop(&mut self) {
        // the query is over (or stopped early): stop fetching
        if let Some(t) = self.task.lock().take() {
            t.abort();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::io::location::ObjectUrl;
    use bytes::Bytes;
    use object_store::memory::InMemory;

    fn file() -> ObjectFile {
        let url = ObjectUrl { scheme: "memory".into(), bucket: "prefetch-unit".into(), key: "f".into() };
        let store = Arc::new(InMemory::new());
        ObjectFile { url, path: "f".into(), size: 1000, store, store_id: 0, stamp: String::new(), content: Some(Bytes::from(vec![9u8; 1000])) }
    }

    fn shape(g: &[FetchGroup]) -> Vec<usize> {
        g.iter().map(|g| g.parts.len()).collect()
    }

    #[test]
    fn groups_stay_within_the_target_and_one_file() {
        let (f, mut b) = (file(), FetchGroups::new(100));
        for (id, len) in [(0, 40), (0, 40), (0, 40), (0, 40), (1, 10), (1, 10), (0, 10)] {
            b.push(id, &f, vec![0..len]);
        }
        assert_eq!(shape(&b.finish()), vec![2, 2, 2, 1]);
    }

    #[test]
    fn target_zero_and_oversized_morsels_make_single_groups() {
        let (f, mut zero) = (file(), FetchGroups::new(0));
        (0..3).for_each(|_| zero.push(0, &f, vec![0..10]));
        assert_eq!(shape(&zero.finish()), vec![1, 1, 1]);
        let mut big = FetchGroups::new(100);
        (0..2).for_each(|_| big.push(0, &f, vec![0..500]));
        assert_eq!(shape(&big.finish()), vec![1, 1]);
    }

    #[test]
    fn every_morsel_gets_its_own_bytes_from_a_group() {
        let (f, mut b) = (file(), FetchGroups::new(1 << 20));
        b.push(0, &f, vec![0..10, 20..30]);
        b.push(0, &f, vec![100..150]);
        b.push(0, &f, vec![200..201]);
        let p = Prefetcher::grouped(b.finish(), 2);
        let sizes: Vec<usize> = (0..3).map(|i| p.take(i, None).unwrap().chunks.held()).collect();
        assert_eq!(sizes, vec![20, 50, 1]);
        assert!(p.take(1, None).is_err(), "a morsel is taken once");
    }
}
