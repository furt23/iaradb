//! Execution of physical plans: operators -> pipelines -> results.
//!
//! The nodes of a plan are numbered in pre-order, as `PhysicalPlan::tree`
//! lists them. An analyzed run ([`execute_analyzed`]) hands every operator,
//! source and sink built for a node that node's counters (see
//! [`crate::exec::metrics`]); a plain run builds the same pipelines without
//! the measuring wrappers.
//!
//! A node can take part in a run in more than one piece (a join builds in
//! one pipeline and probes in another; an aggregation is a sink, then a
//! source): all the pieces report to the same node.

use std::sync::Arc;
use std::time::{Duration, Instant};

use arrow::datatypes::SchemaRef;
use arrow::record_batch::RecordBatch;

use crate::error::Result;
use crate::exec::aggregate::AggregateSink;
use crate::exec::join::{BuildSide, HashJoinProbe, JoinBuildSink, NestedLoopJoin, concat_parallel};
use crate::exec::join_spill::{GraceJoin, GraceJoinSource, PartitionSink};
use crate::exec::measured::{MeasuredOp, MeasuredSource, run_measured};
use crate::exec::metrics::{NodeRef, PlanMetrics, rows_of};
use crate::exec::ops::{FilterOp, ProjectOp};
use crate::exec::pipeline::{CollectSink, MemorySource, NullSink, Operator, Pipeline, Sink, Source, UnionSource, run_pipeline};
use crate::exec::sort::SortSink;
use crate::exec::unnest::UnnestOp;
use crate::exec::stream::{Emitter, StreamSink};
use crate::exec::window::{WindowSink, WindowSpec, Windowed};
use crate::logical::JoinType;
use crate::physical::planner::PhysicalPlan;

pub fn execute(plan: &PhysicalPlan) -> Result<Vec<RecordBatch>> {
    Exec { metrics: None }.execute(plan, 0)
}

/// Run a plan, handing its batches to `emit` in order as they are produced:
/// pipelines stream through an order-preserving sink, a sort's runs are
/// merged straight into `emit`. Only aggregations and window results are
/// produced whole before being handed out.
pub fn execute_stream(plan: &PhysicalPlan, emit: Emitter<'_>) -> Result<()> {
    Exec { metrics: None }.stream(plan, 0, emit)
}

/// [`execute_stream`], measuring every operator into `metrics` (one set of
/// counters per node of `plan`).
pub fn execute_analyzed(plan: &PhysicalPlan, metrics: &Arc<PlanMetrics>, emit: Emitter<'_>) -> Result<()> {
    Exec { metrics: Some(metrics.clone()) }.stream(plan, 0, emit)
}

struct Exec {
    metrics: Option<Arc<PlanMetrics>>,
}

impl Exec {
    fn node(&self, id: usize) -> Option<NodeRef> {
        self.metrics.as_ref().map(|m| NodeRef::new(m.clone(), id))
    }

    /// The ids of a node's children (not worked out when nothing is measured).
    fn ids(&self, plan: &PhysicalPlan, id: usize) -> Vec<usize> {
        if self.metrics.is_some() { plan.child_ids(id) } else { vec![0; plan.children().len()] }
    }

    fn source(&self, id: usize, source: Arc<dyn Source>) -> Arc<dyn Source> {
        match self.node(id) {
            Some(node) => Arc::new(MeasuredSource::new(source, node)),
            None => source,
        }
    }

    fn op(&self, id: usize, op: Arc<dyn Operator>) -> Arc<dyn Operator> {
        match self.node(id) {
            Some(node) => Arc::new(MeasuredOp::new(op, node)),
            None => op,
        }
    }

    /// Run a pipeline whose sink belongs to node `id`.
    fn run<S: Sink>(&self, id: usize, pipeline: &Pipeline, sink: &S) -> Result<S::Output> {
        match self.node(id) {
            Some(node) => run_measured(&node, pipeline, sink),
            None => run_pipeline(pipeline, sink),
        }
    }

    /// Work of node `id` that is not an operator or a sink; `f` must not run
    /// other nodes.
    fn timed<T>(&self, id: usize, f: impl FnOnce() -> T) -> T {
        let Some(node) = self.node(id) else { return f() };
        let start = Instant::now();
        let out = f();
        node.add_time(start.elapsed());
        out
    }

    /// The batches a node produced whole (it hands them on as they are).
    fn output(&self, id: usize, batches: Vec<RecordBatch>) -> Vec<RecordBatch> {
        if let Some(node) = self.node(id) {
            node.add_output(rows_of(&batches), batches.len() as u64);
        }
        batches
    }

    fn execute(&self, plan: &PhysicalPlan, id: usize) -> Result<Vec<RecordBatch>> {
        let ids = self.ids(plan, id);
        match plan {
            PhysicalPlan::Aggregate { input, group_exprs, aggs, schema } => {
                let pipe = self.pipeline(input, ids[0])?;
                let sink = AggregateSink::new(group_exprs.clone(), aggs.clone(), schema.clone());
                Ok(self.output(id, self.run(id, &pipe, &sink)?))
            }
            PhysicalPlan::Sort { input, keys, fetch, schema } => {
                let pipe = self.pipeline(input, ids[0])?;
                let sorted = self.run(id, &pipe, &SortSink { keys: keys.clone(), fetch: *fetch, schema: schema.clone() })?;
                Ok(self.output(id, self.timed(id, || sorted.into_batches())?))
            }
            PhysicalPlan::Limit { input, skip, fetch } => {
                let pipe = self.pipeline(input, ids[0])?;
                Ok(self.output(id, self.run(id, &pipe, &CollectSink::with_limit(*skip, *fetch))?))
            }
            PhysicalPlan::Values { batches, .. } => Ok(self.output(id, batches.clone())),
            PhysicalPlan::Window { input, specs, schema } => {
                let pipe = self.pipeline(input, ids[0])?;
                let windowed = self.run(id, &pipe, &WindowSink::new(specs.clone(), schema.clone()))?;
                Ok(self.output(id, self.timed(id, || windowed.into_batches())?))
            }
            PhysicalPlan::RecursiveQuery { static_term, recursive_term, work_table, distinct, fetch, .. } => {
                let base = self.execute(static_term, ids[0])?;
                // the node's own time is the iteration's, not the terms' it runs
                let (mut inside, start) = (Duration::ZERO, Instant::now());
                let out = crate::exec::recursive::iterate(base, work_table, *distinct, *fetch, || {
                    let t = Instant::now();
                    let batches = self.execute(recursive_term, ids[1]);
                    inside += t.elapsed();
                    batches
                })?;
                if let Some(node) = self.node(id) {
                    node.add_time(start.elapsed().saturating_sub(inside));
                }
                Ok(self.output(id, out))
            }
            _ => run_pipeline(&self.pipeline(plan, id)?, &CollectSink::new()),
        }
    }

    fn stream(&self, plan: &PhysicalPlan, id: usize, emit: Emitter<'_>) -> Result<()> {
        let ids = self.ids(plan, id);
        match plan {
            PhysicalPlan::Sort { input, keys, fetch, schema } => {
                let pipe = self.pipeline(input, ids[0])?;
                let sorted = self.run(id, &pipe, &SortSink { keys: keys.clone(), fetch: *fetch, schema: schema.clone() })?;
                match self.node(id) {
                    None => sorted.emit(emit),
                    // the merge is the node's, what `emit` does with its batches is not
                    Some(node) => node.measure(|m| sorted.emit(&mut |b| m.through(b, &mut *emit))),
                }
            }
            PhysicalPlan::Limit { input, skip, fetch } => {
                let pipe = self.pipeline(input, ids[0])?;
                match self.node(id) {
                    None => run_pipeline(&pipe, &StreamSink::new(emit, *skip, *fetch)),
                    Some(node) => {
                        let (mut rows, mut batches) = (0u64, 0u64);
                        let out = run_pipeline(
                            &pipe,
                            &StreamSink::new(
                                &mut |b: RecordBatch| {
                                    rows += b.num_rows() as u64;
                                    batches += 1;
                                    emit(b)
                                },
                                *skip,
                                *fetch,
                            ),
                        );
                        node.add_output(rows, batches);
                        out
                    }
                }
            }
            PhysicalPlan::Window { input, specs, schema } => {
                match self.window(input, ids[0], id, specs, schema)? {
                    Windowed::Batches(b) => self.output(id, b).into_iter().try_for_each(emit),
                    Windowed::Partitions(p) => {
                        run_pipeline(&Pipeline::new(self.source(id, Arc::new(p))), &StreamSink::new(emit, 0, None))
                    }
                }
            }
            PhysicalPlan::Aggregate { .. } | PhysicalPlan::Values { .. } | PhysicalPlan::RecursiveQuery { .. } => {
                self.execute(plan, id)?.into_iter().try_for_each(emit)
            }
            _ => run_pipeline(&self.pipeline(plan, id)?, &StreamSink::new(emit, 0, None)),
        }
    }

    fn window(
        &self,
        input: &PhysicalPlan,
        input_id: usize,
        id: usize,
        specs: &[WindowSpec],
        schema: &SchemaRef,
    ) -> Result<Windowed> {
        let pipe = self.pipeline(input, input_id)?;
        self.run(id, &pipe, &WindowSink::new(specs.to_vec(), schema.clone()))
    }

    fn pipeline(&self, plan: &PhysicalPlan, id: usize) -> Result<Pipeline> {
        let ids = self.ids(plan, id);
        Ok(match plan {
            PhysicalPlan::Source { source, .. } => Pipeline::new(self.source(id, source.clone())),
            PhysicalPlan::Filter { input, predicate, projection, .. } => self
                .pipeline(input, ids[0])?
                .with_op(self.op(id, Arc::new(FilterOp { predicate: predicate.clone(), projection: projection.clone() }))),
            PhysicalPlan::Project { input, exprs, schema } => self
                .pipeline(input, ids[0])?
                .with_op(self.op(id, Arc::new(ProjectOp { exprs: exprs.clone(), schema: schema.clone() }))),
            PhysicalPlan::Unnest { input, exprs, keep_empty, schema } => self.pipeline(input, ids[0])?.with_op(self.op(
                id,
                Arc::new(UnnestOp { exprs: exprs.clone(), keep_empty: *keep_empty, schema: schema.clone() }),
            )),
            PhysicalPlan::HashJoin { .. } => self.hash_join(plan, id, &ids)?,
            PhysicalPlan::NestedLoopJoin { probe, build, join_type, filter, joined_schema, schema, order } => {
                let batches = self.execute(build, ids[1])?;
                let bschema = build.schema();
                let build_batch = self.timed(id, || {
                    if batches.is_empty() {
                        Ok(RecordBatch::new_empty(bschema.clone()))
                    } else {
                        concat_parallel(&bschema, &batches)
                    }
                })?;
                let memory = Some(NestedLoopJoin::reserve_build(&build_batch)?);
                let join = NestedLoopJoin {
                    memory,
                    build: build_batch,
                    join_type: *join_type,
                    filter: filter.clone(),
                    joined_schema: joined_schema.clone(),
                    output_schema: schema.clone(),
                    order: order.clone(),
                };
                self.pipeline(probe, ids[0])?.with_op(self.op(id, Arc::new(join)))
            }
            PhysicalPlan::Union { inputs, schema } => {
                let pipes = inputs.iter().zip(&ids).map(|(p, &i)| self.pipeline(p, i)).collect::<Result<Vec<_>>>()?;
                Pipeline::new(Arc::new(UnionSource::new(pipes, schema.clone()).measured(self.node(id))))
            }
            // spilled window partitions are evaluated one per morsel, in the next pipeline
            PhysicalPlan::Window { input, specs, schema } => match self.window(input, ids[0], id, specs, schema)? {
                Windowed::Batches(b) => Pipeline::new(Arc::new(MemorySource::new(self.output(id, b), schema.clone(), "Materialized"))),
                Windowed::Partitions(p) => Pipeline::new(self.source(id, Arc::new(p))),
            },
            PhysicalPlan::Aggregate { .. }
            | PhysicalPlan::Sort { .. }
            | PhysicalPlan::Limit { .. }
            | PhysicalPlan::Values { .. }
            | PhysicalPlan::RecursiveQuery { .. } => {
                let batches = self.execute(plan, id)?;
                Pipeline::new(Arc::new(MemorySource::new(batches, plan.schema(), "Materialized")))
            }
        })
    }

    /// The probe side of a hash join, ready to run once its build side was.
    fn hash_join(&self, plan: &PhysicalPlan, id: usize, ids: &[usize]) -> Result<Pipeline> {
        let PhysicalPlan::HashJoin { probe, build, probe_keys, build_keys, join_type, filter, joined_schema, schema, order, mark_build } = plan else {
            unreachable!("hash_join runs on hash joins")
        };
        let build_pipe = self.pipeline(build, ids[1])?;
        let track_matches = matches!(join_type, JoinType::Full | JoinType::Right) || *mark_build;
        let sink = JoinBuildSink::new(build_keys.clone(), build.schema(), track_matches);
        let table = match self.run(id, &build_pipe, &sink)? {
            BuildSide::Table(t) => Arc::new(t),
            BuildSide::Spilled(build_parts) => {
                // grace hash join: the probe side is partitioned like the build side
                let probe_sink = PartitionSink::new(probe_keys.clone(), probe.schema(), build_parts.len());
                let probe_parts = self.run(id, &self.pipeline(probe, ids[0])?, &probe_sink)?;
                let join = GraceJoin {
                    build_keys: build_keys.clone(),
                    build_schema: build.schema(),
                    probe_keys: probe_keys.clone(),
                    join_type: *join_type,
                    filter: filter.clone(),
                    joined_schema: joined_schema.clone(),
                    output_schema: schema.clone(),
                    order: order.clone(),
                    mark_build: *mark_build,
                };
                return Ok(Pipeline::new(self.source(id, Arc::new(GraceJoinSource::new(join, build_parts, probe_parts)))));
            }
        };
        let op = self.op(
            id,
            Arc::new(HashJoinProbe {
                table: table.clone(),
                probe_keys: probe_keys.clone(),
                join_type: *join_type,
                filter: filter.clone(),
                joined_schema: joined_schema.clone(),
                output_schema: schema.clone(),
                order: order.clone(),
                mark_only: *mark_build,
            }),
        );
        let probe_pipe = self.pipeline(probe, ids[0])?;
        if *mark_build {
            // run the probe side only to mark matches, then stream the kept build rows
            run_pipeline(&probe_pipe.with_op(op), &NullSink)?;
            let rows = self.timed(id, || table.rows_by_match(*join_type == JoinType::Semi))?;
            return Ok(Pipeline::new(self.source(id, Arc::new(MemorySource::new(rows, schema.clone(), "SemiJoinMarked")))));
        }
        Ok(probe_pipe.with_op(op))
    }
}
