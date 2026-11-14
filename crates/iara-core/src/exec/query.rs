//! Per-query runtime state: cancellation and progress.
//!
//! [`with_query`] opens a [`QueryHandle`] for the calling thread. Every
//! pipeline run from that thread reports its progress into the handle and
//! checks it for cancellation between morsels. Handles of running queries are
//! kept in a global registry, so another thread (an interactive kernel, a web
//! server) can watch their progress and cancel them.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::time::Instant;

use parking_lot::Mutex;

use crate::error::{Result, WhError};
use crate::exec::{memory, spill};
use crate::io::object::{StorageRequests, storage_requests};

/// Live counters of one pipeline run.
pub struct PipelineProgress {
    source: String,
    operators: Vec<String>,
    sink: String,
    morsels_total: usize,
    /// the plan nodes it runs for, source first (a measured run's; empty otherwise)
    nodes: Vec<usize>,
    morsels_done: AtomicUsize,
    rows_in: AtomicU64,
    rows_out: AtomicU64,
    started: Instant,
    /// elapsed microseconds once finished, `u64::MAX` while running
    elapsed_us: AtomicU64,
}

impl PipelineProgress {
    pub fn new(source: String, operators: Vec<String>, sink: String, morsels_total: usize, nodes: Vec<usize>) -> Self {
        Self {
            source,
            operators,
            sink,
            morsels_total,
            nodes,
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
        let p = PipelineProgress::new(a.source.clone(), a.operators.clone(), a.sink.clone(), sa.morsels_total + sb.morsels_total, a.nodes.clone());
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
            nodes: self.nodes.clone(),
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
    /// the plan nodes it ran for (pre-order ids), source first: only measured runs know them
    pub nodes: Vec<usize>,
    pub morsels_done: usize,
    pub rows_in: u64,
    pub rows_out: u64,
    pub elapsed_ms: f64,
    pub finished: bool,
}

/// A pipeline a query will run, listed before it starts.
#[derive(Clone, Debug)]
pub struct PlannedPipeline {
    pub source: String,
    pub sink: String,
    /// `None` when only the run knows it (the output of an earlier pipeline)
    pub morsels: Option<usize>,
}

/// Snapshot of a query: its pipelines in execution order.
#[derive(Clone, Debug)]
pub struct QueryStats {
    pub id: u64,
    pub elapsed_ms: f64,
    pub cancelled: bool,
    pub pipelines: Vec<PipelineStats>,
    /// the pipelines planned and not started yet, in order
    pub pending: Vec<PlannedPipeline>,
    /// operator memory at its highest (process-wide when queries overlap)
    pub memory_peak: usize,
    /// bytes written to spill files
    pub spilled_bytes: u64,
    /// requests made to object stores (process-wide when queries overlap)
    pub requests: StorageRequests,
    /// the tables the query planned a scan of
    pub reads: Vec<TableRead>,
    /// the result depends on when it ran or on chance (`now()`, `current_date`, `random()`), not only on what it read
    pub volatile: bool,
}

/// A table a query read: where it lives and, for Delta, the version scanned.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableRead {
    pub location: String,
    pub version: Option<u64>,
}

pub struct QueryHandle {
    reads: Mutex<Vec<TableRead>>,
    volatile: AtomicBool,
    id: u64,
    started: Instant,
    spilled_before: u64,
    requests_before: StorageRequests,
    cancelled: AtomicBool,
    pipelines: Mutex<Vec<Arc<PipelineProgress>>>,
    planned: Mutex<VecDeque<PlannedPipeline>>,
    /// plan executions in flight (a nested one runs inside another)
    executions: AtomicUsize,
}

/// A plan execution counted as in flight on its query until dropped.
pub struct Execution<'a> {
    /// no other execution of the query was in flight when this one began
    pub outer: bool,
    count: &'a AtomicUsize,
}

impl Drop for Execution<'_> {
    fn drop(&mut self) {
        self.count.fetch_sub(1, Ordering::AcqRel);
    }
}

impl QueryHandle {
    fn new() -> Self {
        static NEXT_ID: AtomicU64 = AtomicU64::new(1);
        Self {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            started: Instant::now(),
            spilled_before: spill::spilled_bytes(),
            requests_before: storage_requests(),
            cancelled: AtomicBool::new(false),
            pipelines: Mutex::new(vec![]),
            planned: Mutex::new(VecDeque::new()),
            executions: AtomicUsize::new(0),
            reads: Mutex::new(vec![]),
            volatile: AtomicBool::new(false),
        }
    }

    /// Note that the query's result is not a function of its tables alone.
    pub fn note_volatile(&self) {
        self.volatile.store(true, Ordering::Relaxed);
    }

    /// Note a table the query reads (once).
    pub fn note_read(&self, read: TableRead) {
        let mut reads = self.reads.lock();
        if !reads.contains(&read) {
            reads.push(read);
        }
    }

    /// Count an execution of a plan as in flight, from any thread of the query.
    pub fn enter_execution(&self) -> Execution<'_> {
        Execution { outer: self.executions.fetch_add(1, Ordering::AcqRel) == 0, count: &self.executions }
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

    /// List the pipelines about to run, in order. They go ahead of those still
    /// planned: a nested execution runs before what the outer plan has left.
    pub fn plan(&self, pipelines: Vec<PlannedPipeline>) {
        let mut planned = self.planned.lock();
        for p in pipelines.into_iter().rev() {
            planned.push_front(p);
        }
    }

    pub fn track(&self, pipeline: PipelineProgress) -> Arc<PipelineProgress> {
        let p = Arc::new(pipeline);
        let mut pipelines = self.pipelines.lock();
        pipelines.push(p.clone());
        // shortcut: a starting pipeline takes the next planned one, so a run that diverges (a spill, a recursive CTE) leaves the queue approximate
        self.planned.lock().pop_front();
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
        // under the same lock `track` holds: a pipeline is never in both lists, or in neither
        let pipelines = self.pipelines.lock();
        QueryStats {
            id: self.id,
            elapsed_ms: self.started.elapsed().as_secs_f64() * 1000.0,
            cancelled: self.is_cancelled(),
            pipelines: pipelines.iter().map(|p| p.stats()).collect(),
            pending: self.planned.lock().iter().cloned().collect(),
            memory_peak: memory::pool().peak(),
            spilled_bytes: spill::spilled_bytes() - self.spilled_before,
            requests: storage_requests().since(self.requests_before),
            reads: self.reads.lock().clone(),
            volatile: self.volatile.load(Ordering::Relaxed),
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
        let idle = {
            let mut reg = registry().lock();
            reg.retain(|h| !Arc::ptr_eq(h, &self.0));
            reg.is_empty()
        };
        // memory the query freed goes back to the system unless another
        // query follows soon (short queries free little)
        if idle && self.0.started.elapsed() >= std::time::Duration::from_millis(200) {
            memory::release_later(|| registry().lock().is_empty());
        }
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
            memory::cancel_release();
            // what earlier queries and results freed counts as free: given
            // back first when the free memory would cut the limit
            if !memory::pool().fits_free_memory() {
                memory::release_freed();
            }
        }
        memory::pool().fit_to_free_memory();
        reg.push(h.clone());
    }
    CURRENT.with(|c| *c.borrow_mut() = Some(h.clone()));
    let _running = Running(h.clone());
    f(&h)
}

/// Run `f` on this thread as part of query `h` (work a query hands to
/// another thread, like a source that executes a plan of its own).
pub fn joined<T>(h: Option<Arc<QueryHandle>>, f: impl FnOnce() -> T) -> T {
    struct Restore(Option<Arc<QueryHandle>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            CURRENT.with(|c| *c.borrow_mut() = self.0.take());
        }
    }
    let _restore = Restore(CURRENT.with(|c| std::mem::replace(&mut *c.borrow_mut(), h)));
    f()
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
