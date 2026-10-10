//! Per-operator metrics of an analyzed run (`EXPLAIN ANALYZE`).
//!
//! The nodes of a physical plan are numbered in pre-order (the order of
//! `PhysicalPlan::tree`), and an analyzed run keeps one set of atomic
//! counters per node in a [`PlanMetrics`]. The operators, sources and sinks
//! built for a node report into it through the wrappers of
//! [`crate::exec::measured`]; a run that is not analyzed builds no wrappers,
//! so it pays nothing.
//!
//! Times are *self* times: an operator is timed around its own call minus
//! the time spent in what it hands its output to (see [`Meter`]). They are
//! summed over the worker threads, so a node can show more time than the
//! query took.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::time::{Duration, Instant};

use arrow::record_batch::RecordBatch;

use crate::error::Result;

/// What one operator did in a run (a snapshot of its counters).
#[derive(Clone, Debug, PartialEq)]
pub struct OperatorMetrics {
    pub rows_out: u64,
    /// self time, summed over threads
    pub elapsed_ms: f64,
    pub batches: u64,
    /// most memory the operator's pipeline added to the pool (None: none)
    pub memory_peak: Option<u64>,
    /// bytes its pipeline wrote to spill files (None: none)
    pub spilled_bytes: Option<u64>,
}

#[derive(Default)]
struct NodeCounters {
    ran: AtomicBool,
    rows_out: AtomicU64,
    batches: AtomicU64,
    nanos: AtomicU64,
    memory_peak: AtomicU64,
    spilled_bytes: AtomicU64,
}

/// The counters of every node of one plan.
pub struct PlanMetrics {
    nodes: Vec<NodeCounters>,
}

impl PlanMetrics {
    pub fn new(nodes: usize) -> Self {
        Self { nodes: (0..nodes).map(|_| NodeCounters::default()).collect() }
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    /// The metrics of node `id`; None if nothing of it was built for the run.
    pub fn snapshot(&self, id: usize) -> Option<OperatorMetrics> {
        let n = self.nodes.get(id).filter(|n| n.ran.load(Relaxed))?;
        let some = |v: u64| (v > 0).then_some(v);
        Some(OperatorMetrics {
            rows_out: n.rows_out.load(Relaxed),
            elapsed_ms: n.nanos.load(Relaxed) as f64 / 1e6,
            batches: n.batches.load(Relaxed),
            memory_peak: some(n.memory_peak.load(Relaxed)),
            spilled_bytes: some(n.spilled_bytes.load(Relaxed)),
        })
    }
}

/// One node's counters, as the measuring wrappers hold them.
#[derive(Clone)]
pub struct NodeRef {
    metrics: Arc<PlanMetrics>,
    id: usize,
}

impl NodeRef {
    /// A node taking part in the run (it then has metrics, even if empty).
    pub fn new(metrics: Arc<PlanMetrics>, id: usize) -> Self {
        let node = Self { metrics, id };
        node.counters().ran.store(true, Relaxed);
        node
    }

    fn counters(&self) -> &NodeCounters {
        &self.metrics.nodes[self.id]
    }

    pub fn add_time(&self, d: Duration) {
        self.counters().nanos.fetch_add(d.as_nanos() as u64, Relaxed);
    }

    pub fn add_output(&self, rows: u64, batches: u64) {
        let c = self.counters();
        c.rows_out.fetch_add(rows, Relaxed);
        c.batches.fetch_add(batches, Relaxed);
    }

    /// Own time and output of one call.
    pub fn record(&self, time: Duration, rows: u64, batches: u64) {
        self.add_time(time);
        self.add_output(rows, batches);
    }

    /// What a pipeline run added: peak pool memory (the highest of its runs)
    /// and spilled bytes.
    pub fn add_resources(&self, memory_peak: u64, spilled_bytes: u64) {
        let c = self.counters();
        c.memory_peak.fetch_max(memory_peak, Relaxed);
        c.spilled_bytes.fetch_add(spilled_bytes, Relaxed);
    }

    /// Run `f` and record its self time (its duration minus what the batches
    /// it handed through the [`Meter`] took downstream) and the output it
    /// passed on.
    pub fn measure<T>(&self, f: impl FnOnce(&mut Meter) -> T) -> T {
        let start = Instant::now();
        let mut meter = Meter::default();
        let out = f(&mut meter);
        self.record(start.elapsed().saturating_sub(meter.downstream), meter.rows, meter.batches);
        out
    }
}

/// Counts what a measured call emits and times the work downstream of it,
/// which is not the call's own.
#[derive(Default)]
pub struct Meter {
    rows: u64,
    batches: u64,
    downstream: Duration,
}

impl Meter {
    /// Hand a batch to `emit`, counting it and the time `emit` takes.
    pub fn through(&mut self, batch: RecordBatch, emit: &mut dyn FnMut(RecordBatch) -> Result<()>) -> Result<()> {
        self.rows += batch.num_rows() as u64;
        self.batches += 1;
        let start = Instant::now();
        let out = emit(batch);
        self.downstream += start.elapsed();
        out
    }
}

pub fn rows_of(batches: &[RecordBatch]) -> u64 {
    batches.iter().map(|b| b.num_rows() as u64).sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_node_has_metrics_once_it_took_part() {
        let m = Arc::new(PlanMetrics::new(2));
        assert_eq!(m.snapshot(0), None);
        let n = NodeRef::new(m.clone(), 0);
        assert_eq!(m.snapshot(0).map(|s| (s.rows_out, s.batches)), Some((0, 0)));
        n.record(Duration::from_millis(3), 10, 2);
        n.record(Duration::from_millis(2), 5, 1);
        n.add_resources(100, 0);
        n.add_resources(40, 7);
        let s = m.snapshot(0).unwrap();
        assert_eq!((s.rows_out, s.batches), (15, 3));
        assert!((s.elapsed_ms - 5.0).abs() < 1e-9);
        assert_eq!((s.memory_peak, s.spilled_bytes), (Some(100), Some(7)));
        assert_eq!(m.snapshot(1), None);
        assert_eq!(m.snapshot(9), None);
    }

    #[test]
    fn self_time_excludes_what_runs_downstream() {
        let m = Arc::new(PlanMetrics::new(1));
        let n = NodeRef::new(m.clone(), 0);
        let batch = RecordBatch::new_empty(Arc::new(arrow::datatypes::Schema::empty()));
        n.measure(|meter| {
            meter.through(batch, &mut |_| {
                std::thread::sleep(Duration::from_millis(30));
                Ok(())
            })
            .unwrap();
        });
        let s = m.snapshot(0).unwrap();
        assert_eq!(s.batches, 1);
        assert!(s.elapsed_ms < 15.0, "downstream time leaked into the node: {}", s.elapsed_ms);
    }
}
