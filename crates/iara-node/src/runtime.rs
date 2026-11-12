//! Progress of running queries and their cancellation.

use napi_derive::napi;

use iara_core::exec::query::{self, PipelineStats, QueryStats};

use crate::storage::{Requests, requests};

#[napi(object)]
pub struct Pipeline {
    pub source: String,
    pub operators: Vec<String>,
    pub sink: String,
    pub morsels_total: i64,
    pub nodes: Vec<i64>,
    pub morsels_done: i64,
    pub rows_in: i64,
    pub rows_out: i64,
    pub elapsed_ms: f64,
    pub finished: bool,
}

#[napi(object)]
pub struct Planned {
    pub source: String,
    pub sink: String,
    /// null when only the run knows it
    pub morsels: Option<i64>,
}

#[napi(object)]
pub struct RunningQuery {
    pub id: i64,
    pub elapsed_ms: f64,
    pub cancelled: bool,
    pub memory_peak: i64,
    pub spilled_bytes: i64,
    pub requests: Requests,
    pub pipelines: Vec<Pipeline>,
    /// pipelines planned and not started yet
    pub pending: Vec<Planned>,
}

fn pipeline(p: &PipelineStats) -> Pipeline {
    Pipeline {
        source: p.source.clone(),
        operators: p.operators.clone(),
        sink: p.sink.clone(),
        morsels_total: p.morsels_total as i64,
        nodes: p.nodes.iter().map(|&n| n as i64).collect(),
        morsels_done: p.morsels_done as i64,
        rows_in: p.rows_in as i64,
        rows_out: p.rows_out as i64,
        elapsed_ms: p.elapsed_ms,
        finished: p.finished,
    }
}

fn running(q: QueryStats) -> RunningQuery {
    RunningQuery {
        id: q.id as i64,
        elapsed_ms: q.elapsed_ms,
        cancelled: q.cancelled,
        memory_peak: q.memory_peak as i64,
        spilled_bytes: q.spilled_bytes as i64,
        requests: requests(&q.requests),
        pipelines: q.pipelines.iter().map(pipeline).collect(),
        pending: q.pending.iter().map(|p| Planned { source: p.source.clone(), sink: p.sink.clone(), morsels: p.morsels.map(|m| m as i64) }).collect(),
    }
}

/// Cancel every running query; returns how many were cancelled.
#[napi]
pub fn interrupt() -> i64 {
    query::cancel_all() as i64
}

/// Cancel one running query by id.
#[napi]
pub fn cancel_query(id: i64) -> bool {
    u64::try_from(id).is_ok_and(query::cancel)
}

#[napi]
pub fn running_queries() -> Vec<RunningQuery> {
    query::running().into_iter().map(running).collect()
}
