//! An analyzed run (per-operator metrics) as plain Python dicts.

use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};

use iara_core::exec::metrics::OperatorMetrics;
use iara_core::physical::analyze::{Analysis, AnalyzedNode};

use crate::runtime::stats_dict;
use crate::storage::requests_dict;

/// `{rows_out, elapsed_ms, batches, memory_peak?, spilled_bytes?}` (the
/// optional keys only when the operator has them).
fn metrics_dict<'py>(py: Python<'py>, m: &OperatorMetrics) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("rows_out", m.rows_out)?;
    d.set_item("elapsed_ms", m.elapsed_ms)?;
    d.set_item("batches", m.batches)?;
    if let Some(b) = m.memory_peak {
        d.set_item("memory_peak", b)?;
    }
    if let Some(b) = m.spilled_bytes {
        d.set_item("spilled_bytes", b)?;
    }
    Ok(d)
}

/// `{name, detail, role, metrics: {...} | None, children: [...]}`
fn node_dict<'py>(py: Python<'py>, n: &AnalyzedNode) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("name", &n.name)?;
    d.set_item("detail", &n.detail)?;
    d.set_item("role", n.role)?;
    match &n.metrics {
        Some(m) => d.set_item("metrics", metrics_dict(py, m)?)?,
        None => d.set_item("metrics", py.None())?,
    }
    let children = PyList::empty(py);
    for c in &n.children {
        children.append(node_dict(py, c)?)?;
    }
    d.set_item("children", children)?;
    Ok(d)
}

/// `{plan, profile, rows, requests}`: the plan with its metrics, the run
/// profile (as `profile()` gives it), the result's row count and the
/// requests made to object stores.
pub fn analysis_dict<'py>(py: Python<'py>, a: &Analysis) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("plan", node_dict(py, &a.plan)?)?;
    d.set_item("profile", stats_dict(py, &a.stats)?)?;
    d.set_item("rows", a.rows)?;
    d.set_item("requests", requests_dict(py, &a.stats.requests)?)?;
    Ok(d)
}
