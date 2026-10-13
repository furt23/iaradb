//! Delta tables from Python: what the log says about one.

use pyo3::prelude::*;
use pyo3::types::{PyDict, PyList};

use crate::PyResultExt;
use crate::storage;

/// `{version, num_files, size_bytes, partition_columns, created_at, last_modified, description}`
/// of the Delta table at `path` (a folder or URL), at its newest version.
#[pyfunction]
#[pyo3(signature = (path, storage_options=None))]
fn delta_info<'py>(py: Python<'py>, path: &str, storage_options: Option<&Bound<'_, PyDict>>) -> PyResult<Bound<'py, PyDict>> {
    let opts = storage::options(storage_options)?;
    let path = path.to_string();
    let d = py.detach(move || workhouse_core::delta::ops::detail::detail(&path, &opts)).py()?;
    let out = PyDict::new(py);
    out.set_item("version", d.version)?;
    out.set_item("num_files", d.num_files)?;
    out.set_item("size_bytes", d.size_in_bytes)?;
    out.set_item("partition_columns", d.partition_columns)?;
    out.set_item("not_null_columns", d.not_null_columns)?;
    out.set_item("created_at", d.created_at)?;
    out.set_item("last_modified", d.last_modified)?;
    out.set_item("description", d.description)?;
    Ok(out)
}

/// The commits of the Delta table at `path`, newest first (at most `limit`):
/// `[{version, timestamp (ms), operation, operation_parameters, operation_metrics, engine_info}]`.
#[pyfunction]
#[pyo3(signature = (path, storage_options=None, limit=None))]
fn delta_history<'py>(py: Python<'py>, path: &str, storage_options: Option<&Bound<'_, PyDict>>, limit: Option<usize>) -> PyResult<Bound<'py, PyList>> {
    let opts = storage::options(storage_options)?;
    let path = path.to_string();
    let entries = py.detach(move || workhouse_core::delta::ops::history::history(&path, &opts, limit)).py()?;
    let out = PyList::empty(py);
    for e in entries {
        let d = PyDict::new(py);
        d.set_item("version", e.version)?;
        d.set_item("timestamp", e.timestamp_ms)?;
        d.set_item("operation", e.operation)?;
        d.set_item("operation_parameters", e.operation_parameters)?;
        d.set_item("operation_metrics", e.operation_metrics)?;
        d.set_item("engine_info", e.engine_info)?;
        out.append(d)?;
    }
    Ok(out)
}

pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(delta_info, m)?)?;
    m.add_function(wrap_pyfunction!(delta_history, m)?)?;
    Ok(())
}
