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

/// `{limit, used, peak, spilled}` in bytes (`limit` is None without a limit),
/// with `heap` (bytes the allocator has handed out) and `resident` (bytes it
/// holds in memory) on Linux and macOS.
#[pyfunction]
fn memory_usage(py: Python<'_>) -> PyResult<Bound<'_, PyDict>> {
    let pool = memory::pool();
    let d = PyDict::new(py);
    d.set_item("limit", pool.limited().then(|| pool.limit()))?;
    d.set_item("used", pool.used())?;
    d.set_item("peak", pool.peak())?;
    d.set_item("spilled", spilled_bytes())?;
    if let Some((heap, resident)) = alloc::heap() {
        d.set_item("heap", heap)?;
        d.set_item("resident", resident)?;
    }
    Ok(d)
}

/// jemalloc, the global allocator on Linux and macOS: with its defaults it
/// gives blocks of 8 MB and more back as they are freed (and the rest within
/// ten seconds), so a process holds about what it uses, for some speed
/// (see docs/benchmarks.md).
#[cfg(unix)]
mod alloc {
    use std::ffi::{CStr, c_void};
    use std::ptr::null_mut;

    use tikv_jemalloc_sys::mallctl;

    fn ctl(name: &CStr) {
        // SAFETY: jemalloc is the global allocator; these controls take no value
        unsafe { mallctl(name.as_ptr(), null_mut(), null_mut(), null_mut(), 0) };
    }

    fn read(name: &CStr) -> Option<usize> {
        let (mut v, mut len) = (0usize, size_of::<usize>());
        // SAFETY: the statistics read are size_t
        let rc = unsafe { mallctl(name.as_ptr(), (&raw mut v).cast::<c_void>(), &raw mut len, null_mut(), 0) };
        (rc == 0).then_some(v)
    }

    pub fn release_freed() {
        ctl(c"thread.tcache.flush");
        ctl(c"arena.4096.purge"); // MALLCTL_ARENAS_ALL
    }

    /// Bytes handed out and bytes the allocator holds resident, now.
    pub fn heap() -> Option<(usize, usize)> {
        let mut epoch = 1u64;
        // SAFETY: writing the epoch refreshes the statistics
        unsafe { mallctl(c"epoch".as_ptr(), null_mut(), null_mut(), (&raw mut epoch).cast::<c_void>(), size_of::<u64>()) };
        Some((read(c"stats.allocated")?, read(c"stats.resident")?))
    }

    pub fn init() {}
}

/// mimalloc, the global allocator on Windows.
#[cfg(not(unix))]
mod alloc {
    unsafe extern "C" {
        /// give memory this thread freed back to the system
        fn mi_collect(force: bool);
        fn mi_option_set(option: std::ffi::c_int, value: std::ffi::c_long);
    }

    /// `mi_option_purge_delay` (mimalloc 2 and 3)
    const MI_OPTION_PURGE_DELAY: std::ffi::c_int = 15;

    pub fn release_freed() {
        // SAFETY: mimalloc is linked in as the global allocator
        unsafe { mi_collect(true) }
    }

    pub fn heap() -> Option<(usize, usize)> {
        None
    }

    pub fn init() {
        // freed memory goes back five seconds after it is freed (or when the
        // engine releases it after a query, see `memory::release_later`), not
        // one second after: a query of a few seconds reuses its pages instead of
        // faulting them in zeroed again
        if std::env::var_os("MIMALLOC_PURGE_DELAY").is_none() {
            // SAFETY: mimalloc is the global allocator; options may change at run time
            unsafe { mi_option_set(MI_OPTION_PURGE_DELAY, 5_000) }
        }
    }
}

pub fn register(m: &Bound<'_, PyModule>) -> PyResult<()> {
    alloc::init();
    memory::set_release(alloc::release_freed);
    m.add_function(wrap_pyfunction!(set_memory_limit, m)?)?;
    m.add_function(wrap_pyfunction!(memory_usage, m)?)?;
    Ok(())
}
