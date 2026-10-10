//! Remote storage from Python: option dicts, defaults by URL prefix, file
//! listings, request counts and column statistics of registered tables.

use pyo3::prelude::*;
use pyo3::types::{PyBool, PyDict};

use workhouse_core::WhError;
use workhouse_core::io::object::StorageRequests;
use workhouse_core::io::{StorageOptions, object};

use crate::PyResultExt;

/// A `{key: value}` dict as storage options (booleans as `true`/`false`,
/// other values by `str()`; `None` values are skipped).
pub fn options(obj: Option<&Bound<'_, PyDict>>) -> PyResult<StorageOptions> {
    let mut o = StorageOptions::new();
    for (k, v) in obj.into_iter().flat_map(|d| d.iter()) {
        if v.is_none() {
            continue;
        }
        let key: String = k.extract()?;
        let value = if v.is_instance_of::<PyBool>() { v.extract::<bool>()?.to_string() } else { v.str()?.to_string() };
        o = o.with(&key, value);
    }
    Ok(o)
}

/// Default options for every URL under `prefix` (`None` or `{}` removes them).
#[pyfunction]
#[pyo3(signature = (prefix, options=None))]
fn set_storage_options(prefix: &str, options: Option<&Bound<'_, PyDict>>) -> PyResult<()> {
    object::set_storage_options(prefix, self::options(options)?);
    Ok(())
}

/// `[(path_or_url, size_in_bytes), ...]` for a path, directory, glob or URL.
#[pyfunction]
#[pyo3(signature = (pattern, extension="parquet", storage_options=None))]
fn list_files(py: Python<'_>, pattern: &str, extension: &str, storage_options: Option<&Bound<'_, PyDict>>) -> PyResult<Vec<(String, u64)>> {
    let opts = options(storage_options)?;
    let (pattern, extension) = (pattern.to_string(), extension.to_string());
    py.detach(move || {
        let files = workhouse_core::io::list_files(&pattern, &extension, &opts)?;
        files.iter().map(|f| Ok((f.name(), f.size()?))).collect::<Result<Vec<_>, WhError>>()
    })
    .py()
}

/// `{list, head, get, bytes}`: requests made to object stores (GET `bytes`
/// are the bytes asked for).
pub fn requests_dict<'py>(py: Python<'py>, r: &StorageRequests) -> PyResult<Bound<'py, PyDict>> {
    let d = PyDict::new(py);
    d.set_item("list", r.list)?;
    d.set_item("head", r.head)?;
    d.set_item("get", r.get)?;
    d.set_item("bytes", r.bytes)?;
    Ok(d)
}

/// Requests this process has made to object stores so far.
#[pyfunction]
fn storage_requests(py: Python<'_>) -> PyResult<Bound<'_, PyDict>> {
    requests_dict(py, &object::storage_requests())
}

/// Forget connections to object stores (e.g. after credentials changed).
#[pyfunction]
fn clear_object_stores() {
    object::clear_object_stores();
}

pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_function(wrap_pyfunction!(set_storage_options, m)?)?;
    m.add_function(wrap_pyfunction!(list_files, m)?)?;
    m.add_function(wrap_pyfunction!(clear_object_stores, m)?)?;
    m.add_function(wrap_pyfunction!(storage_requests, m)?)?;
    Ok(())
}
