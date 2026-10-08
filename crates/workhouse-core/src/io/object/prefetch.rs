//! Fetching the bytes of upcoming morsels while workers decode current ones.
//!
//! Morsels are claimed roughly in order, so a background task fetches them
//! in order, a window of them at a time, under a memory budget: each fetched
//! morsel holds its share of the budget until the worker that takes it is
//! done with it. Workers block only when their morsel has not arrived yet.

use std::ops::Range;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures::StreamExt;
use parking_lot::{Condvar, Mutex};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
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

impl FetchJob {
    fn bytes(&self) -> u64 {
        self.ranges.iter().map(|r| r.end - r.start).sum()
    }

    async fn run(&self) -> Result<RangeChunks> {
        let bytes = self.file.get_ranges(&self.ranges).await?;
        Ok(RangeChunks::new(self.file.size, self.ranges.iter().map(|r| r.start).zip(bytes).collect()))
    }
}

/// A morsel's bytes; its share of the prefetch budget is released on drop.
pub struct Fetched {
    pub chunks: RangeChunks,
    _permit: Option<OwnedSemaphorePermit>,
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

/// `WORKHOUSE_REMOTE_PREFETCH`: morsels fetched concurrently (0 disables
/// prefetching: workers fetch their own morsel when they claim it).
pub fn window() -> usize {
    std::env::var("WORKHOUSE_REMOTE_PREFETCH").ok().and_then(|v| v.parse().ok()).unwrap_or(16)
}

/// `WORKHOUSE_REMOTE_PREFETCH_MB`: bytes fetched but not yet decoded.
pub fn budget_bytes() -> u64 {
    let mb: u64 = std::env::var("WORKHOUSE_REMOTE_PREFETCH_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(256);
    mb.max(1) << 20
}

pub struct Prefetcher {
    jobs: Arc<Vec<FetchJob>>,
    slots: Arc<Vec<Slot>>,
    window: usize,
    started: AtomicBool,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl Prefetcher {
    pub fn new(jobs: Vec<FetchJob>, window: usize) -> Self {
        let slots = (0..jobs.len()).map(|_| Slot { state: Mutex::new(SlotState::Pending), ready: Condvar::new() }).collect();
        Self { jobs: Arc::new(jobs), slots: Arc::new(slots), window: window.max(1), started: AtomicBool::new(false), task: Mutex::new(None) }
    }

    /// The bytes of morsel `i` (waiting for them if needed). Each morsel is
    /// taken once.
    pub fn take(&self, i: usize, cancel: Option<&QueryHandle>) -> Result<Fetched> {
        self.start();
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
        let (jobs, slots, window) = (self.jobs.clone(), self.slots.clone(), self.window);
        let budget = budget_bytes();
        let sem = Arc::new(Semaphore::new((budget >> 10) as usize));
        let handle = runtime().spawn(async move {
            futures::stream::iter(0..jobs.len())
                .for_each_concurrent(window, |i| {
                    let (jobs, slots, sem) = (jobs.clone(), slots.clone(), sem.clone());
                    async move {
                        let job = &jobs[i];
                        // a morsel larger than the whole budget goes alone
                        let kib = (job.bytes().min(budget) >> 10).max(1) as u32;
                        let permit = sem.acquire_many_owned(kib).await.ok();
                        let r = job.run().await.map(|chunks| Fetched { chunks, _permit: permit });
                        slots[i].fill(r);
                    }
                })
                .await
        });
        *self.task.lock() = Some(handle);
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
