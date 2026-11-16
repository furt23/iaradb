//! Opening and fetching the splits of a remote scan ahead of the workers.
//!
//! A background task goes through the splits in order. It requests the
//! footers of the files of many splits at once (a footer is one small
//! request, and the scan cannot know what else to read before it has it),
//! and then, in order and under the prefetch memory budget, the column
//! chunks of the row groups each split keeps. A worker waits only when its
//! split has not arrived yet. A file as small as the footer request arrives
//! whole with it, and costs that one request. A file the build keys of a
//! join rule out costs none.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::task::{Context, Poll};
use std::time::Duration;

use futures::StreamExt;
use parking_lot::{Condvar, Mutex};
use tokio::sync::{Semaphore, watch};
use tokio::task::{JoinError, JoinHandle, JoinSet};

use super::file::{ParquetFile, remote_file};
use super::footer;
use super::split_scan::{Gate, Scan, Split, SplitPlan, gated_out};
use super::table_files::FileList;
use crate::error::{Result, WhError};
use crate::exec::query::QueryHandle;
use crate::io::DataFile;
use crate::io::blob::RangeChunks;
use crate::io::object::prefetch::{Held, budget_bytes};
use crate::io::object::runtime::runtime;

/// `IARA_REMOTE_FILES` (default 128): files of a scan whose footers are
/// requested at once.
pub fn open_window() -> usize {
    std::env::var("IARA_REMOTE_FILES").ok().and_then(|v| v.parse().ok()).filter(|&n| n > 0).unwrap_or(128)
}

/// A split ready to decode: its file, the row groups to read and their
/// bytes. The memory budget they take is given back on drop.
pub struct Fetched {
    /// `None`: the build keys of a join ruled the file out, and nothing was read
    pub plan: Option<SplitPlan>,
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

struct Shared {
    list: FileList,
    /// the scanned files (indexes into `list`): a split's `file` is a position here
    kept: Arc<Vec<usize>>,
    splits: Arc<Vec<Split>>,
    scan: Arc<Scan>,
    gates: Arc<Vec<Gate>>,
    /// a file's footer, from its first split to its last
    opened: Vec<tokio::sync::Mutex<Option<Arc<ParquetFile>>>>,
    /// one per split
    slots: Vec<Slot>,
}

impl Shared {
    /// Open the file of split `i` (once for all its splits) and choose the row groups
    /// to read. `None`: a join's build keys rule the file out.
    async fn plan(&self, i: usize) -> Result<Option<SplitPlan>> {
        let split = &self.splits[i];
        if gated_out(&self.gates, split.file) {
            return Ok(None);
        }
        let mut cell = self.opened[split.file].lock().await;
        let file = match &*cell {
            Some(f) => f.clone(),
            None => {
                let DataFile::Object(object) = self.list.source(self.kept[split.file]) else {
                    return Err(WhError::Execution(format!("{} is not on an object store", self.list.name(self.kept[split.file]))));
                };
                let footer = footer::load(object).await?;
                let object = match footer.content {
                    Some(data) => object.clone().with_content(data),
                    None => object.clone(),
                };
                Arc::new(remote_file(object, footer.meta)?)
            }
        };
        // the footer is dropped with the file's last split
        let last = self.splits.get(i + 1).is_none_or(|next| next.file != split.file);
        *cell = (!last).then(|| file.clone());
        drop(cell);
        Ok(Some(self.scan.plan(file, &split.bytes)))
    }

    /// The bytes of the column chunks `plan` reads (no request for a file held whole).
    async fn fetch(plan: Option<SplitPlan>, held: Option<Arc<Held>>) -> Result<Fetched> {
        let Some(plan) = plan else { return Ok(Fetched { plan: None, chunks: RangeChunks::new(0, vec![]), _held: held }) };
        let ranges = plan.ranges();
        let size = plan.file.blob.len();
        let bytes = match plan.file.blob.object() {
            Some(object) if !ranges.is_empty() => object.get_ranges(&ranges).await?,
            _ => vec![],
        };
        let chunks = RangeChunks::new(size, ranges.iter().map(|r| r.start).zip(bytes).collect());
        Ok(Fetched { plan: Some(plan), chunks, _held: held })
    }
}

/// A spawned task that stops when it is dropped.
struct Task<T>(JoinHandle<T>);

impl<T> Drop for Task<T> {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl<T> Future for Task<T> {
    type Output = std::result::Result<T, JoinError>;

    fn poll(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Self::Output> {
        Pin::new(&mut self.0).poll(cx)
    }
}

pub struct SplitFetcher {
    shared: Arc<Shared>,
    /// fetch no more than this many splits past the last one a worker took
    /// (`None`: as many as the window and the budget hold)
    lookahead: Option<usize>,
    /// splits taken, counting from the first
    taken: watch::Sender<usize>,
    started: AtomicBool,
    task: Mutex<Option<JoinHandle<()>>>,
}

impl SplitFetcher {
    /// The `splits` of the files `kept` of `list`, all on an object store. With a
    /// `lookahead`, a scan that stops early (a LIMIT) leaves few fetched, unread splits behind.
    pub(super) fn new(list: FileList, kept: Arc<Vec<usize>>, splits: Arc<Vec<Split>>, scan: Arc<Scan>, gates: Arc<Vec<Gate>>, lookahead: Option<usize>) -> Self {
        let opened = kept.iter().map(|_| tokio::sync::Mutex::new(None)).collect();
        let slots = splits.iter().map(|_| Slot { state: Mutex::new(SlotState::Pending), ready: Condvar::new() }).collect();
        Self {
            shared: Arc::new(Shared { list, kept, splits, scan, gates, opened, slots }),
            lookahead: lookahead.map(|n| n.max(1)),
            taken: watch::channel(0).0,
            started: AtomicBool::new(false),
            task: Mutex::new(None),
        }
    }

    /// Split `i`, opened and fetched (waiting for it if needed). Each split is taken once.
    pub fn take(&self, i: usize, cancel: Option<&QueryHandle>) -> Result<Fetched> {
        self.start();
        self.taken.send_if_modified(|n| std::mem::replace(n, (*n).max(i + 1)) < i + 1);
        let slot = &self.shared.slots[i];
        let mut st = slot.state.lock();
        loop {
            match std::mem::replace(&mut *st, SlotState::Taken) {
                SlotState::Ready(r) => return r,
                SlotState::Taken => return Err(WhError::Execution(format!("split {i} was already taken"))),
                SlotState::Pending => *st = SlotState::Pending,
            }
            if cancel.is_some_and(|q| q.is_cancelled()) {
                return Err(WhError::Cancelled);
            }
            slot.ready.wait_for(&mut st, Duration::from_millis(50));
        }
    }

    /// Start fetching on first use (planning alone requests nothing).
    fn start(&self) {
        if self.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let handle = runtime().spawn(drive(self.shared.clone(), self.lookahead, self.taken.subscribe()));
        *self.task.lock() = Some(handle);
    }
}

async fn drive(shared: Arc<Shared>, lookahead: Option<usize>, mut taken: watch::Receiver<usize>) {
    let budget = budget_bytes();
    let sem = Arc::new(Semaphore::new((budget >> 10) as usize));
    let window = lookahead.unwrap_or_else(open_window);
    let plan = |i: usize| {
        let shared = shared.clone();
        Task(runtime().spawn(async move { shared.plan(i).await }))
    };
    // footers arrive in any order; splits get their share of the budget in the scan's order,
    // so the one a worker waits for is never behind later ones
    let mut planned = futures::stream::iter(0..shared.splits.len()).map(plan).buffered(window);
    let mut fetches = JoinSet::new();
    let mut i = 0;
    while let Some(plan) = planned.next().await {
        let slot = i;
        i += 1;
        if let Some(ahead) = lookahead {
            // not before the workers are close (the sender is gone: the query is over)
            if taken.wait_for(|&taken| slot < taken + ahead).await.is_err() {
                return;
            }
        }
        let plan = match plan {
            Ok(Ok(plan)) => plan,
            Ok(Err(e)) => {
                shared.slots[slot].fill(Err(e));
                continue;
            }
            Err(e) => {
                shared.slots[slot].fill(Err(WhError::Execution(format!("opening a file failed: {e}"))));
                continue;
            }
        };
        let held = match &plan {
            Some(plan) => Held::acquire(&sem, plan.bytes(), budget).await,
            None => None,
        };
        let shared = shared.clone();
        fetches.spawn(async move { shared.slots[slot].fill(Shared::fetch(plan, held).await) });
        // finished fetches need no bookkeeping
        while fetches.try_join_next().is_some() {}
    }
    while fetches.join_next().await.is_some() {}
}

impl Drop for SplitFetcher {
    fn drop(&mut self) {
        // the query is over (or stopped early): stop opening and fetching
        if let Some(t) = self.task.lock().take() {
            t.abort();
        }
    }
}
