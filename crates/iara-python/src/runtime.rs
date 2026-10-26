//! Query runtime bindings: progress of running queries, cancellation, run
//! profiles and physical plan trees, exposed as plain Python dicts.

use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};

use iara_core::exec::query::{self, PipelineStats, QueryStats};
use iara_core::physical::analyze;
use iara_core::physical::planner::PlanNode;

use crate::analyze::analysis_dict;

fn pipeline_dict<'py>(py: Python<'py>, p: &PipelineStats) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("source", &p.source)?;
    d.set_item("operators", &p.operators)?;
    d.set_item("sink", &p.sink)?;
    d.set_item("morsels_total", p.morsels_total)?;
    d.set_item("nodes", &p.nodes)?;
    d.set_item("morsels_done", p.morsels_done)?;
    d.set_item("rows_in", p.rows_in)?;
    d.set_item("rows_out", p.rows_out)?;
    d.set_item("elapsed_ms", p.elapsed_ms)?;
    d.set_item("finished", p.finished)?;
    Ok(d)
}

/// `{id, elapsed_ms, cancelled, memory_peak, spilled_bytes,
/// requests: {list, head, get, bytes}, pipelines: [...],
/// pending: [{source, sink, morsels}]}`: `pending` are the pipelines planned
/// and not started yet (`morsels` is None when the run decides it)
pub fn stats_dict<'py>(py: Python<'py>, q: &QueryStats) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("id", q.id)?;
    d.set_item("elapsed_ms", q.elapsed_ms)?;
    d.set_item("cancelled", q.cancelled)?;
    d.set_item("memory_peak", q.memory_peak)?;
    d.set_item("spilled_bytes", q.spilled_bytes)?;
    d.set_item("requests", crate::storage::requests_dict(py, &q.requests)?)?;
    let pipelines = PyList::empty(py);
    for p in &q.pipelines {
        pipelines.append(pipeline_dict(py, p)?)?;
    }
    d.set_item("pipelines", pipelines)?;
    let pending = PyList::empty(py);
    for p in &q.pending {
        let item = PyDict::new(py);
        item.set_item("source", &p.source)?;
        item.set_item("sink", &p.sink)?;
        item.set_item("morsels", p.morsels)?;
        pending.append(item)?;
    }
    d.set_item("pending", pending)?;
    Ok(d)
}

/// `{name, detail, role, children: [...]}`
pub fn plan_dict<'py>(py: Python<'py>, n: &PlanNode) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("name", &n.name)?;
    d.set_item("detail", &n.detail)?;
    d.set_item("role", n.role)?;
    let children = PyList::empty(py);
    for c in &n.children {
        children.append(plan_dict(py, c)?)?;
    }
    d.set_item("children", children)?;
    Ok(d)
}

/// Cancel every running query; returns how many were cancelled.
#[pyfunction]
pub fn interrupt() -> usize {
    query::cancel_all()
}

/// Cancel one running query by id.
#[pyfunction]
pub fn cancel_query(id: u64) -> bool {
    query::cancel(id)
}

/// Progress snapshots of the running queries.
#[pyfunction]
pub fn running_queries(py: Python<'_>) -> PyResult<Bound<'_, PyList>> {
    let out = PyList::empty(py);
    for q in query::running() {
        out.append(stats_dict(py, &q)?)?;
    }
    Ok(out)
}

/// Keep the plan and metrics of every query that runs (see
/// `take_recorded_plans`); queries are only measured while this is on.
#[pyfunction]
pub fn record_plans(on: bool) {
    analyze::record_plans(on);
}

/// The runs recorded since the last call, oldest first: each is what
/// `LazyFrame.analyze()` returns, plus the plan as `text`.
#[pyfunction]
pub fn take_recorded_plans(py: Python<'_>) -> PyResult<Bound<'_, PyList>> {
    let out = PyList::empty(py);
    for run in analyze::take_recorded() {
        let d = analysis_dict(py, &run)?;
        d.set_item("text", analyze::plan_text(&run.plan))?;
        out.append(d)?;
    }
    Ok(out)
}

pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(interrupt, m)?)?;
    m.add_function(wrap_pyfunction!(cancel_query, m)?)?;
    m.add_function(wrap_pyfunction!(running_queries, m)?)?;
    m.add_function(wrap_pyfunction!(record_plans, m)?)?;
    m.add_function(wrap_pyfunction!(take_recorded_plans, m)?)?;
    Ok(())
}
