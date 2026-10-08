//! Per-query runtime state: cancellation and progress.
//!
//! [`with_query`] opens a [`QueryHandle`] for the calling thread. Every
//! pipeline run from that thread reports its progress into the handle and
//! checks it for cancellation between morsels. Handles of running queries are
//! kept in a global registry, so another thread (an interactive kernel, a web
//! server) can watch their progress and cancel them.

use std::cell::RefCell;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Instant;

use parking_lot::Mutex;

use crate::error::{Result, WhError};
use crate::exec::{memory, spill};

/// Live counters of one pipeline run.
pub struct PipelineProgress {
    source: String,
    operators: Vec<String>,
    sink: String,
    morsels_total: usize,
    morsels_done: AtomicUsize,
    rows_in: AtomicU64,
    rows_out: AtomicU64,
    started: Instant,
    /// elapsed microseconds once finished, `u64::MAX` while running
    elapsed_us: AtomicU64,
}

impl PipelineProgress {
    pub fn new(source: String, operators: Vec<String>, sink: String, morsels_total: usize) -> Self {
        Self {
            source,
            operators,
            sink,
            morsels_total,
            morsels_done: AtomicUsize::new(0),
            rows_in: AtomicU64::new(0),
            rows_out: AtomicU64::new(0),
            started: Instant::now(),
            elapsed_us: AtomicU64::new(u64::MAX),
        }
    }

    /// Record one finished morsel with its source and sink row counts.
    pub fn morsel_done(&self, rows_in: u64, rows_out: u64) {
        self.rows_in.fetch_add(rows_in, Ordering::Relaxed);
        self.rows_out.fetch_add(rows_out, Ordering::Relaxed);
        self.morsels_done.fetch_add(1, Ordering::Relaxed);
    }

    pub fn finish(&self) {
        self.elapsed_us.store(self.started.elapsed().as_micros() as u64, Ordering::Relaxed);
    }

    fn is_finished(&self) -> bool {
        self.elapsed_us.load(Ordering::Relaxed) != u64::MAX
    }

    /// The same source, operators and sink (another run of the pipeline).
    fn same_as(&self, other: &PipelineProgress) -> bool {
        self.source == other.source && self.operators == other.operators && self.sink == other.sink
    }

    /// A finished pipeline whose counters add up two runs of one pipeline.
    fn combined(a: &PipelineProgress, b: &PipelineProgress) -> PipelineProgress {
        let (sa, sb) = (a.stats(), b.stats());
        let p = PipelineProgress::new(a.source.clone(), a.operators.clone(), a.sink.clone(), sa.morsels_total + sb.morsels_total);
        p.morsels_done.store(sa.morsels_done + sb.morsels_done, Ordering::Relaxed);
        p.rows_in.store(sa.rows_in + sb.rows_in, Ordering::Relaxed);
        p.rows_out.store(sa.rows_out + sb.rows_out, Ordering::Relaxed);
        p.elapsed_us.store(((sa.elapsed_ms + sb.elapsed_ms) * 1000.0) as u64, Ordering::Relaxed);
        p
    }

    pub fn stats(&self) -> PipelineStats {
        let done = self.elapsed_us.load(Ordering::Relaxed);
        let finished = done != u64::MAX;
        let elapsed_us = if finished { done } else { self.started.elapsed().as_micros() as u64 };
        PipelineStats {
            source: self.source.clone(),
            operators: self.operators.clone(),
            sink: self.sink.clone(),
            morsels_total: self.morsels_total,
            morsels_done: self.morsels_done.load(Ordering::Relaxed),
            rows_in: self.rows_in.load(Ordering::Relaxed),
            rows_out: self.rows_out.load(Ordering::Relaxed),
            elapsed_ms: elapsed_us as f64 / 1000.0,
            finished,
        }
    }
}

/// Snapshot of a pipeline's progress.
#[derive(Clone, Debug)]
pub struct PipelineStats {
    pub source: String,
    pub operators: Vec<String>,
    pub sink: String,
    pub morsels_total: usize,
    pub morsels_done: usize,
    pub rows_in: u64,
    pub rows_out: u64,
    pub elapsed_ms: f64,
    pub finished: bool,
}

/// Snapshot of a query: its pipelines in execution order.
#[derive(Clone, Debug)]
pub struct QueryStats {
    pub id: u64,
    pub elapsed_ms: f64,
    pub cancelled: bool,
    pub pipelines: Vec<PipelineStats>,
    /// operator memory at its highest (process-wide when queries overlap)
    pub memory_peak: usize,
    /// bytes written to spill files
    pub spilled_bytes: u64,
}

pub struct QueryHandle {
    id: u64,
    started: Instant,
    spilled_before: u64,
    cancelled: AtomicBool,
    pipelines: Mutex<Vec<Arc<PipelineProgress>>>,
}

impl QueryHandle {
    fn new() -> Self {
        static NEXT_ID: AtomicU64 = AtomicU64::new(1);
        Self {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            started: Instant::now(),
            spilled_before: spill::spilled_bytes(),
            cancelled: AtomicBool::new(false),
            pipelines: Mutex::new(vec![]),
        }
    }

    pub fn id(&self) -> u64 {
        self.id
    }

    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    /// `Err(Cancelled)` once the query was cancelled.
    pub fn check(&self) -> Result<()> {
        if self.is_cancelled() { Err(WhError::Cancelled) } else { Ok(()) }
    }

    pub fn track(&self, pipeline: PipelineProgress) -> Arc<PipelineProgress> {
        let p = Arc::new(pipeline);
        self.pipelines.lock().push(p.clone());
        p
    }

    pub fn pipeline_count(&self) -> usize {
        self.pipelines.lock().len()
    }

    /// Fold the finished pipelines tracked after `since` into identical ones
    /// tracked earlier (from `since` on): the iterations of a loop (recursive
    /// CTEs) show as one pipeline each, with summed counters.
    pub fn fold_repeats(&self, since: usize) {
        let mut ps = self.pipelines.lock();
        let mut i = since;
        while i < ps.len() {
            match (since..i).find(|&j| ps[j].same_as(&ps[i])) {
                Some(j) if ps[i].is_finished() && ps[j].is_finished() => {
                    ps[j] = Arc::new(PipelineProgress::combined(&ps[j], &ps[i]));
                    ps.remove(i);
                }
                _ => i += 1,
            }
        }
    }

    pub fn stats(&self) -> QueryStats {
        QueryStats {
            id: self.id,
            elapsed_ms: self.started.elapsed().as_secs_f64() * 1000.0,
            cancelled: self.is_cancelled(),
            pipelines: self.pipelines.lock().iter().map(|p| p.stats()).collect(),
            memory_peak: memory::pool().peak(),
            spilled_bytes: spill::spilled_bytes() - self.spilled_before,
        }
    }
}

fn registry() -> &'static Mutex<Vec<Arc<QueryHandle>>> {
    static REGISTRY: Mutex<Vec<Arc<QueryHandle>>> = Mutex::new(Vec::new());
    &REGISTRY
}

thread_local! {
    static CURRENT: RefCell<Option<Arc<QueryHandle>>> = const { RefCell::new(None) };
}

/// The query running on this thread, if any.
pub fn current() -> Option<Arc<QueryHandle>> {
    CURRENT.with(|c| c.borrow().clone())
}

/// Unregisters the query when it ends, even by panic.
struct Running(Arc<QueryHandle>);

impl Drop for Running {
    fn drop(&mut self) {
        CURRENT.with(|c| *c.borrow_mut() = None);
        registry().lock().retain(|h| !Arc::ptr_eq(h, &self.0));
    }
}

/// Run `f` as a query. Nested executions (materialized CTEs, subplans) join
/// the query already running on this thread.
pub fn with_query<T>(f: impl FnOnce(&Arc<QueryHandle>) -> T) -> T {
    if let Some(h) = current() {
        return f(&h);
    }
    let h = Arc::new(QueryHandle::new());
    {
        let mut reg = registry().lock();
        if reg.is_empty() {
            memory::pool().reset_peak(); // the peak of this query alone
        }
        reg.push(h.clone());
    }
    CURRENT.with(|c| *c.borrow_mut() = Some(h.clone()));
    let _running = Running(h.clone());
    f(&h)
}

/// Progress of every running query.
pub fn running() -> Vec<QueryStats> {
    registry().lock().iter().map(|h| h.stats()).collect()
}

/// Cancel every running query; returns how many were cancelled.
pub fn cancel_all() -> usize {
    let reg = registry().lock();
    reg.iter().for_each(|h| h.cancel());
    reg.len()
}

/// Cancel one running query by id.
pub fn cancel(id: u64) -> bool {
    match registry().lock().iter().find(|h| h.id == id) {
        Some(h) => {
            h.cancel();
            true
        }
        None => false,
    }
}
