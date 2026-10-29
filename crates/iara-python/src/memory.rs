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

/// jemalloc, the global allocator on Linux and macOS. Its own purging is
/// off: by default it gives every freed extent of 8 MB or more back at once
/// (and the rest within ten seconds), and queries that free and allocate
/// such blocks all the time (a scan's decompressed pages, aggregation
/// tables) faulted them in zeroed again, 10-30% of their time. [`govern`]
/// gives freed memory back instead once what the process holds would pass
/// the most it had in use in the last seconds, so it keeps about what it
/// uses at its peak, and memory freed below the peak is reused.
#[cfg(unix)]
mod alloc {
    use std::ffi::{CStr, CString, c_void};
    use std::ptr::null_mut;
    use std::time::{Duration, Instant};

    use tikv_jemalloc_sys::mallctl;

    fn ctl(name: &CStr) {
        // SAFETY: jemalloc is the global allocator; these controls take no value
        unsafe { mallctl(name.as_ptr(), null_mut(), null_mut(), null_mut(), 0) };
    }

    fn read<T: Default>(name: &CStr) -> Option<T> {
        let (mut v, mut len) = (T::default(), size_of::<T>());
        // SAFETY: callers read controls of type T (size_t, unsigned)
        let rc = unsafe { mallctl(name.as_ptr(), (&raw mut v).cast::<c_void>(), &raw mut len, null_mut(), 0) };
        (rc == 0).then_some(v)
    }

    fn refresh() {
        let mut epoch = 1u64;
        // SAFETY: writing the epoch (uint64_t) refreshes the statistics
        unsafe { mallctl(c"epoch".as_ptr(), null_mut(), null_mut(), (&raw mut epoch).cast::<c_void>(), size_of::<u64>()) };
    }

    pub fn release_freed() {
        ctl(c"thread.tcache.flush");
        ctl(c"arena.4096.purge"); // MALLCTL_ARENAS_ALL
    }

    /// Bytes handed out and bytes the allocator holds resident, now.
    pub fn heap() -> Option<(usize, usize)> {
        refresh();
        Some((read(c"stats.allocated")?, read(c"stats.resident")?))
    }

    /// Checks while freed memory is held, and while none is (a check
    /// refreshes jemalloc's statistics, about 1 ms).
    const TICK: Duration = Duration::from_millis(20);
    const IDLE_TICK: Duration = Duration::from_secs(1);
    /// Seconds of in-use peaks that bound what is kept.
    const WINDOW: usize = 5;
    /// Freed memory kept past the bound before any is given back.
    const SLACK: usize = 64 << 20;

    /// Give freed memory back, largest arenas first, while what is kept
    /// passes the most that was in use in the last [`WINDOW`] seconds.
    fn govern() {
        let page = read::<usize>(c"arenas.page").unwrap_or(4096);
        let mut peaks = [0usize; WINDOW];
        let (mut at, mut second) = (0, Instant::now());
        loop {
            refresh();
            let (Some(live), Some(dirty)) = (read::<usize>(c"stats.allocated"), read::<usize>(c"stats.arenas.4096.pdirty")) else { return };
            if second.elapsed() >= Duration::from_secs(1) {
                (at, second) = ((at + 1) % WINDOW, Instant::now());
                peaks[at] = 0;
            }
            peaks[at] = peaks[at].max(live);
            let keep = peaks.iter().max().unwrap() - live + SLACK;
            if dirty * page > keep {
                trim(dirty * page - keep, page);
            }
            std::thread::sleep(if dirty == 0 { IDLE_TICK } else { TICK });
        }
    }

    /// Purge the arenas holding the most freed memory until `excess` bytes went back.
    fn trim(excess: usize, page: usize) {
        let n = read::<u32>(c"arenas.narenas").unwrap_or(0);
        let mut held: Vec<(usize, u32)> = (0..n)
            .filter_map(|i| Some((read::<usize>(&CString::new(format!("stats.arenas.{i}.pdirty")).unwrap())? * page, i)))
            .filter(|&(b, _)| b > 0)
            .collect();
        held.sort_unstable_by(|a, b| b.cmp(a));
        let mut freed = 0;
        for (b, i) in held {
            if freed >= excess {
                break;
            }
            ctl(&CString::new(format!("arena.{i}.purge")).unwrap());
            freed += b;
        }
    }

    /// jemalloc's options, read at its first allocation (`_RJEM_MALLOC_CONF`
    /// still adds to them): no purging of its own (with a decay of -1 it also
    /// keeps freed extents past 8 MB) and, on Linux, transparent huge pages,
    /// as mimalloc's arenas have: large hash tables and buffers fault in 2 MB
    /// at a time and miss the TLB about a tenth as often (ClickBench Q33
    /// 2.3 s to 1.8 s).
    #[repr(transparent)]
    struct Conf(*const std::ffi::c_char);
    // SAFETY: points at a static string
    unsafe impl Sync for Conf {}
    #[unsafe(export_name = "_rjem_malloc_conf")]
    static MALLOC_CONF: Conf =
        Conf(if cfg!(target_os = "linux") { c"dirty_decay_ms:-1,thp:always" } else { c"dirty_decay_ms:-1" }.as_ptr());

    pub fn init() {
        let _ = std::thread::Builder::new().name("iara-memory".into()).spawn(govern);
    }
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
