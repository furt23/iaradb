//! Wrappers that measure the operators, sources and sinks of an analyzed
//! run (see [`crate::exec::metrics`]). They are only built when a run is
//! analyzed: the other runs never see them.

use std::sync::Arc;
use std::time::Instant;

use arrow::datatypes::SchemaRef;
use arrow::record_batch::RecordBatch;

use crate::error::Result;
use crate::exec::metrics::{NodeRef, rows_of};
use crate::exec::pipeline::{Emit, Operator, Pipeline, Sink, Source, run_pipeline};
use crate::exec::{memory, spill};

/// An operator reporting its own time and output to a plan node.
pub struct MeasuredOp {
    inner: Arc<dyn Operator>,
    node: NodeRef,
}

impl MeasuredOp {
    pub fn new(inner: Arc<dyn Operator>, node: NodeRef) -> Self {
        Self { inner, node }
    }
}

impl Operator for MeasuredOp {
    fn execute(&self, batch: RecordBatch, emit: Emit<'_>) -> Result<()> {
        self.node.measure(|m| self.inner.execute(batch, &mut |b| m.through(b, &mut *emit)))
    }

    fn finish(&self) -> Result<Vec<RecordBatch>> {
        let start = Instant::now();
        let out = self.inner.finish()?;
        self.node.record(start.elapsed(), rows_of(&out), out.len() as u64);
        Ok(out)
    }

    fn describe(&self) -> String {
        self.inner.describe()
    }
}

/// A source (a scan: fetching and decoding) reporting to a plan node.
pub struct MeasuredSource {
    inner: Arc<dyn Source>,
    node: NodeRef,
}

impl MeasuredSource {
    pub fn new(inner: Arc<dyn Source>, node: NodeRef) -> Self {
        Self { inner, node }
    }
}

impl Source for MeasuredSource {
    fn num_morsels(&self) -> usize {
        self.inner.num_morsels()
    }

    fn run_morsel(&self, morsel: usize, emit: Emit<'_>) -> Result<()> {
        self.node.measure(|m| self.inner.run_morsel(morsel, &mut |b| m.through(b, &mut *emit)))
    }

    fn schema(&self) -> SchemaRef {
        self.inner.schema()
    }

    fn describe(&self) -> String {
        self.inner.describe()
    }
}

/// A sink timed around what it does with its input (`push`, `morsel_done`,
/// `finalize`). Its output is counted by whoever turns it into batches.
struct MeasuredSink<'a, S> {
    inner: &'a S,
    node: &'a NodeRef,
}

impl<S: Sink> MeasuredSink<'_, S> {
    fn timed<T>(&self, f: impl FnOnce() -> T) -> T {
        let start = Instant::now();
        let out = f();
        self.node.add_time(start.elapsed());
        out
    }
}

impl<S: Sink> Sink for MeasuredSink<'_, S> {
    type Local = S::Local;
    type Output = S::Output;

    fn make_local(&self) -> Self::Local {
        self.inner.make_local()
    }

    fn push(&self, local: &mut Self::Local, morsel: usize, batch: RecordBatch) -> Result<()> {
        self.timed(|| self.inner.push(local, morsel, batch))
    }

    fn morsel_done(&self, local: &mut Self::Local, morsel: usize) -> Result<()> {
        self.timed(|| self.inner.morsel_done(local, morsel))
    }

    fn should_stop(&self) -> bool {
        self.inner.should_stop()
    }

    fn finalize(&self, locals: Vec<Self::Local>) -> Result<Self::Output> {
        self.timed(|| self.inner.finalize(locals))
    }

    fn name(&self) -> String {
        self.inner.name()
    }
}

/// Run a pipeline whose sink belongs to `node`: the sink is timed, and the
/// memory the pool held on top of what it held before and the bytes spilled
/// meanwhile are the node's. (Pipelines of a query run one after the other;
/// with other queries running at once these numbers include theirs, like the
/// query-wide ones.)
pub fn run_measured<S: Sink>(node: &NodeRef, pipeline: &Pipeline, sink: &S) -> Result<S::Output> {
    let pool = memory::pool();
    let saved_peak = pool.peak();
    pool.reset_peak();
    let (used_before, spilled_before) = (pool.used(), spill::spilled_bytes());
    let out = run_pipeline(pipeline, &MeasuredSink { inner: sink, node });
    let growth = pool.peak().saturating_sub(used_before) as u64;
    pool.raise_peak(saved_peak);
    node.add_resources(growth, spill::spilled_bytes().saturating_sub(spilled_before));
    out
}
