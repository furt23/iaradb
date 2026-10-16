//! The engine's memory limit from Python.

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyDict, PyInt, PyString};

use iara_core::exec::memory::{self, parse_limit};
use iara_core::exec::spill::spilled_bytes;

/// Memory the engine may hold before spilling to disk: bytes, `"2GB"`,
/// `"60%"` of the machine, or `None` for no limit.
#[pyfunction]
#[pyo3(signature = (limit=None))]
fn set_memory_limit(limit: Option<&Bound<'_, PyAny>>) -> PyResult<()> {
    let bytes = match limit {
        None => usize::MAX,
        Some(v) if v.is_instance_of::<PyInt>() => v.extract::<usize>()?,
        Some(v) if v.is_instance_of::<PyString>() => {
            let s: String = v.extract()?;
            parse_limit(&s, memory::total_memory()).ok_or_else(|| PyValueError::new_err(format!("invalid memory limit {s:?}")))?
        }
        Some(_) => return Err(PyValueError::new_err("the limit is a number of bytes, a string like '2GB' or '60%', or None")),
    };
    memory::pool().set_limit(bytes);
    Ok(())
}

/// `{limit, used, peak, spilled}` in bytes (`limit` is None without a limit).
#[pyfunction]
fn memory_usage(py: Python<'_>) -> PyResult<Bound<'_, PyDict>> {
    let pool = memory::pool();
    let d = PyDict::new(py);
    d.set_item("limit", pool.limited().then(|| pool.limit()))?;
    d.set_item("used", pool.used())?;
    d.set_item("peak", pool.peak())?;
    d.set_item("spilled", spilled_bytes())?;
    Ok(d)
}

unsafe extern "C" {
    /// mimalloc (the global allocator): give memory this thread freed back to the system
    fn mi_collect(force: bool);
}

fn release_freed() {
    // SAFETY: mimalloc is linked in as the global allocator
    unsafe { mi_collect(true) }
}

pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    memory::set_release(release_freed);
    m.add_function(wrap_pyfunction!(set_memory_limit, m)?)?;
    m.add_function(wrap_pyfunction!(memory_usage, m)?)?;
    Ok(())
}
