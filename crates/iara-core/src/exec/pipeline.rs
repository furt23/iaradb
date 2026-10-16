//! Morsel-driven push pipelines.
//!
//! A pipeline is `Source -> [Operator]* -> Sink`. Worker threads repeatedly
//! claim the next morsel (a row group, a chunk of an in-memory table, a byte
//! range of a CSV file, ...) from an atomic counter, push every batch of that
//! morsel through the fused operator chain while it is hot in cache, and fold
//! the result into a thread-local sink state. Pipeline breakers (aggregation,
//! join build, sort) combine the thread-local states once all morsels are done.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

use arrow::datatypes::SchemaRef;
use arrow::record_batch::RecordBatch;
use parking_lot::Mutex;
use rayon::prelude::*;

use crate::error::Result;
use crate::exec::metrics::NodeRef;
use crate::exec::query::{PipelineProgress, QueryHandle};

/// Target number of rows per morsel for in-memory sources.
pub const MORSEL_ROWS: usize = 1 << 17;

pub type Emit<'a> = &'a mut dyn FnMut(RecordBatch) -> Result<()>;

pub trait Source: Send + Sync {
    fn num_morsels(&self) -> usize;
    fn run_morsel(&self, morsel: usize, emit: Emit<'_>) -> Result<()>;
    fn schema(&self) -> SchemaRef;
    fn describe(&self) -> String;
}

pub trait Operator: Send + Sync {
    fn execute(&self, batch: RecordBatch, emit: Emit<'_>) -> Result<()>;
    /// Trailing output produced after all input was processed (e.g. the
    /// unmatched build rows of a full outer join).
    fn finish(&self) -> Result<Vec<RecordBatch>> {
        Ok(vec![])
    }
    fn describe(&self) -> String;
}

pub struct Pipeline {
    pub source: Arc<dyn Source>,
    pub ops: Vec<Arc<dyn Operator>>,
}

impl Pipeline {
    pub fn new(source: Arc<dyn Source>) -> Self {
        Self { source, ops: vec![] }
    }

    pub fn with_op(mut self, op: Arc<dyn Operator>) -> Self {
        self.ops.push(op);
        self
    }

    pub fn push_from(&self, idx: usize, batch: RecordBatch, emit: Emit<'_>) -> Result<()> {
        if idx == self.ops.len() {
            return emit(batch);
        }
        if batch.num_rows() == 0 {
            return Ok(());
        }
        self.ops[idx].execute(batch, &mut |b| self.push_from(idx + 1, b, &mut *emit))
    }

    pub fn describe(&self) -> String {
        let mut parts = vec![self.source.describe()];
        parts.extend(self.ops.iter().map(|o| o.describe()));
        parts.join(" -> ")
    }
}

impl Source for Pipeline {
    fn num_morsels(&self) -> usize {
        self.source.num_morsels()
    }
    fn run_morsel(&self, morsel: usize, emit: Emit<'_>) -> Result<()> {
        self.source.run_morsel(morsel, &mut |b| self.push_from(0, b, &mut *emit))
    }
    fn schema(&self) -> SchemaRef {
        unimplemented!("pipeline schema is defined by its last operator")
    }
    fn describe(&self) -> String {
        Pipeline::describe(self)
    }
}

pub trait Sink: Sync {
    type Local: Send;
    type Output;
    fn make_local(&self) -> Self::Local;
    fn push(&self, local: &mut Self::Local, morsel: usize, batch: RecordBatch) -> Result<()>;
    fn morsel_done(&self, _local: &mut Self::Local, _morsel: usize) -> Result<()> {
        Ok(())
    }
    fn should_stop(&self) -> bool {
        false
    }
    fn finalize(&self, locals: Vec<Self::Local>) -> Result<Self::Output>;
    /// The sink's name in a query's profile.
    fn name(&self) -> String {
        std::any::type_name::<Self>().rsplit("::").next().unwrap_or("").to_string()
    }
}

pub fn profiling() -> bool {
    static P: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *P.get_or_init(|| std::env::var("IARA_PROFILE").is_ok_and(|v| v != "0"))
}

/// Run a pipeline to completion on the global thread pool. Inside a query
/// (see [`crate::exec::query`]) its progress is tracked and cancellation is
/// checked between morsels.
pub fn run_pipeline<S: Sink>(pipeline: &Pipeline, sink: &S) -> Result<S::Output> {
    let query = crate::exec::query::current();
    if let Some(q) = &query {
        q.check()?;
    }
    let sink_name = sink.name();
    let progress = query.as_ref().map(|q| {
        q.track(PipelineProgress::new(
            pipeline.source.describe(),
            pipeline.ops.iter().map(|o| o.describe()).collect(),
            sink_name.clone(),
            pipeline.num_morsels(),
        ))
    });
    let t0 = std::time::Instant::now();
    let out = run_pipeline_inner(pipeline, sink, query.as_deref(), progress.as_deref());
    if let Some(p) = &progress {
        p.finish();
    }
    if profiling() {
        eprintln!("[iara] {:>8.2}ms  {} => {sink_name}", t0.elapsed().as_secs_f64() * 1000.0, pipeline.describe());
    }
    out
}

fn run_pipeline_inner<S: Sink>(
    pipeline: &Pipeline,
    sink: &S,
    query: Option<&QueryHandle>,
    progress: Option<&PipelineProgress>,
) -> Result<S::Output> {
    let n = pipeline.num_morsels();
    let threads = rayon::current_num_threads().max(1).min(n.max(1));
    let next = AtomicUsize::new(0);
    let failed = AtomicBool::new(false);
    let results: Vec<Result<S::Local>> = (0..threads)
        .into_par_iter()
        .map(|_| {
            let mut local = sink.make_local();
            loop {
                if failed.load(Ordering::Relaxed) || sink.should_stop() {
                    break;
                }
                if let Some(q) = query {
                    if let Err(e) = q.check() {
                        failed.store(true, Ordering::Relaxed);
                        return Err(e);
                    }
                }
                let m = next.fetch_add(1, Ordering::Relaxed);
                if m >= n {
                    break;
                }
                let (mut rows_in, mut rows_out) = (0u64, 0u64);
                // cancellation is also checked per batch: one morsel can be
                // large (a row group, an exploding join)
                let check = || query.map_or(Ok(()), |q| q.check());
                let r = pipeline.source.run_morsel(m, &mut |b| {
                    check()?;
                    rows_in += b.num_rows() as u64;
                    pipeline.push_from(0, b, &mut |x| {
                        check()?;
                        rows_out += x.num_rows() as u64;
                        sink.push(&mut local, m, x)
                    })
                });
                let r = r.and_then(|_| sink.morsel_done(&mut local, m));
                if let Err(e) = r {
                    failed.store(true, Ordering::Relaxed);
                    return Err(e);
                }
                if let Some(p) = progress {
                    p.morsel_done(rows_in, rows_out);
                }
            }
            Ok(local)
        })
        .collect();
    let mut locals = Vec::with_capacity(results.len());
    for r in results {
        locals.push(r?);
    }
    for (i, op) in pipeline.ops.iter().enumerate() {
        let extra = op.finish()?;
        if extra.is_empty() {
            continue;
        }
        if locals.is_empty() {
            locals.push(sink.make_local());
        }
        let local = &mut locals[0];
        for b in extra {
            pipeline.push_from(i + 1, b, &mut |x| sink.push(local, usize::MAX, x))?;
        }
    }
    sink.finalize(locals)
}

// ---------------------------------------------------------------------------
// Collect sink (order preserving, with early-out for LIMIT)
// ---------------------------------------------------------------------------

struct LimitTracker {
    done: Vec<Option<usize>>,
    prefix_end: usize,
    prefix_rows: usize,
}

pub struct CollectSink {
    skip: usize,
    fetch: Option<usize>,
    tracker: Mutex<LimitTracker>,
    stop: AtomicBool,
}

pub struct CollectLocal {
    batches: Vec<(usize, usize, RecordBatch)>,
    seq: usize,
    morsel_rows: usize,
}

impl CollectSink {
    pub fn new() -> Self {
        Self::with_limit(0, None)
    }
    pub fn with_limit(skip: usize, fetch: Option<usize>) -> Self {
        Self {
            skip,
            fetch,
            tracker: Mutex::new(LimitTracker { done: vec![], prefix_end: 0, prefix_rows: 0 }),
            stop: AtomicBool::new(false),
        }
    }
}

impl Default for CollectSink {
    fn default() -> Self {
        Self::new()
    }
}

impl Sink for CollectSink {
    type Local = CollectLocal;
    type Output = Vec<RecordBatch>;

    fn make_local(&self) -> CollectLocal {
        CollectLocal { batches: vec![], seq: 0, morsel_rows: 0 }
    }

    fn push(&self, local: &mut CollectLocal, morsel: usize, batch: RecordBatch) -> Result<()> {
        if batch.num_rows() == 0 {
            return Ok(());
        }
        local.morsel_rows += batch.num_rows();
        local.batches.push((morsel, local.seq, batch));
        local.seq += 1;
        Ok(())
    }

    fn morsel_done(&self, local: &mut CollectLocal, morsel: usize) -> Result<()> {
        let rows = std::mem::take(&mut local.morsel_rows);
        if let Some(fetch) = self.fetch {
            let mut t = self.tracker.lock();
            if t.done.len() <= morsel {
                t.done.resize(morsel + 1, None);
            }
            t.done[morsel] = Some(rows);
            while t.prefix_end < t.done.len() {
                match t.done[t.prefix_end] {
                    Some(r) => {
                        t.prefix_rows += r;
                        t.prefix_end += 1;
                    }
                    None => break,
                }
            }
            if t.prefix_rows >= self.skip + fetch {
                self.stop.store(true, Ordering::Relaxed);
            }
        }
        Ok(())
    }

    fn should_stop(&self) -> bool {
        self.stop.load(Ordering::Relaxed)
    }

    fn finalize(&self, locals: Vec<CollectLocal>) -> Result<Vec<RecordBatch>> {
        let mut all: Vec<(usize, usize, RecordBatch)> = locals.into_iter().flat_map(|l| l.batches).collect();
        all.sort_unstable_by_key(|(m, s, _)| (*m, *s));
        let batches: Vec<RecordBatch> = all.into_iter().map(|(_, _, b)| b).collect();
        Ok(apply_limit(batches, self.skip, self.fetch))
    }
}

pub fn apply_limit(batches: Vec<RecordBatch>, skip: usize, fetch: Option<usize>) -> Vec<RecordBatch> {
    if skip == 0 && fetch.is_none() {
        return batches;
    }
    let mut to_skip = skip;
    let mut remaining = fetch.unwrap_or(usize::MAX);
    let mut out = vec![];
    for b in batches {
        if remaining == 0 {
            break;
        }
        let n = b.num_rows();
        if to_skip >= n {
            to_skip -= n;
            continue;
        }
        let start = to_skip;
        to_skip = 0;
        let len = (n - start).min(remaining);
        remaining -= len;
        out.push(b.slice(start, len));
    }
    out
}

/// Discards its input (pipelines run for their side effects).
pub struct NullSink;

impl Sink for NullSink {
    type Local = ();
    type Output = ();
    fn make_local(&self) {}
    fn push(&self, _local: &mut (), _morsel: usize, _batch: RecordBatch) -> Result<()> {
        Ok(())
    }
    fn finalize(&self, _locals: Vec<()>) -> Result<()> {
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/// Split batches into morsel-sized slices (zero copy).
pub fn rechunk(batches: Vec<RecordBatch>, target: usize) -> Vec<RecordBatch> {
    let mut out = Vec::with_capacity(batches.len());
    for b in batches {
        let n = b.num_rows();
        if n <= target {
            if n > 0 {
                out.push(b);
            }
            continue;
        }
        let mut off = 0;
        while off < n {
            let len = target.min(n - off);
            out.push(b.slice(off, len));
            off += len;
        }
    }
    out
}

pub struct MemorySource {
    batches: Vec<parking_lot::Mutex<Option<RecordBatch>>>,
    /// an intermediate result read once: each morsel's batch is released
    /// when it has been run (a table's batches stay for the next query)
    once: bool,
    schema: SchemaRef,
    label: String,
}

impl MemorySource {
    pub fn new(batches: Vec<RecordBatch>, schema: SchemaRef, label: impl Into<String>) -> Self {
        let batches = rechunk(batches, MORSEL_ROWS).into_iter().map(|b| parking_lot::Mutex::new(Some(b))).collect();
        Self { batches, once: false, schema, label: label.into() }
    }

    /// A source of batches that nothing else reads: they are freed as the pipeline goes.
    pub fn once(batches: Vec<RecordBatch>, schema: SchemaRef, label: impl Into<String>) -> Self {
        Self { once: true, ..Self::new(batches, schema, label) }
    }
}

impl Source for MemorySource {
    fn num_morsels(&self) -> usize {
        self.batches.len()
    }
    fn run_morsel(&self, morsel: usize, emit: Emit<'_>) -> Result<()> {
        let b = {
            let mut slot = self.batches[morsel].lock();
            if self.once { slot.take() } else { slot.clone() }
        };
        let Some(b) = b else {
            return Err(crate::error::WhError::Execution(format!("{}: morsel {morsel} was already read", self.label)));
        };
        // morsels are large for scheduling; operators see cache-sized slices
        let bs = crate::io::parquet::batch_size();
        if b.num_rows() <= bs {
            return emit(b);
        }
        let mut off = 0;
        while off < b.num_rows() {
            let len = bs.min(b.num_rows() - off);
            emit(b.slice(off, len))?;
            off += len;
        }
        Ok(())
    }
    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }
    fn describe(&self) -> String {
        format!("{}[{} morsels]", self.label, self.batches.len())
    }
}

pub struct UnionSource {
    inputs: Vec<Pipeline>,
    offsets: Vec<usize>,
    schema: SchemaRef,
    /// analyzed run: the union's own work (the inputs report on their own)
    node: Option<NodeRef>,
}

impl UnionSource {
    pub fn new(inputs: Vec<Pipeline>, schema: SchemaRef) -> Self {
        let mut offsets = Vec::with_capacity(inputs.len() + 1);
        let mut acc = 0;
        for p in &inputs {
            offsets.push(acc);
            acc += p.num_morsels();
        }
        offsets.push(acc);
        Self { inputs, offsets, schema, node: None }
    }

    pub fn measured(mut self, node: Option<NodeRef>) -> Self {
        self.node = node;
        self
    }
}

impl Source for UnionSource {
    fn num_morsels(&self) -> usize {
        *self.offsets.last().unwrap()
    }
    fn run_morsel(&self, morsel: usize, emit: Emit<'_>) -> Result<()> {
        let i = self.offsets.partition_point(|&o| o <= morsel) - 1;
        let schema = self.schema.clone();
        self.inputs[i].run_morsel(morsel - self.offsets[i], &mut |b| {
            let start = self.node.as_ref().map(|_| std::time::Instant::now());
            // normalise field names/nullability to the union schema
            let b = RecordBatch::try_new_with_options(
                schema.clone(),
                b.columns().to_vec(),
                &arrow::record_batch::RecordBatchOptions::new().with_row_count(Some(b.num_rows())),
            )?;
            if let (Some(node), Some(start)) = (&self.node, start) {
                node.record(start.elapsed(), b.num_rows() as u64, 1);
            }
            emit(b)
        })
    }
    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }
    fn describe(&self) -> String {
        format!(
            "Union({})",
            self.inputs.iter().map(|p| p.describe()).collect::<Vec<_>>().join(" | ")
        )
    }
}
