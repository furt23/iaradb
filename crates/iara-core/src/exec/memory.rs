//! The engine's memory limit.
//!
//! Operators that hold data across morsels (aggregation tables, join build
//! sides, sort buffers) reserve what they hold from one process-wide pool.
//! When a reservation would go over the limit they spill to disk instead of
//! growing (see [`crate::exec::spill`]). Everything else (batches flowing
//! through a pipeline) is small and transient, and not accounted.
//!
//! The limit is `IARA_MEMORY_LIMIT`: bytes (`2147483648`), with a unit
//! (`2GB`, `512MB`) or a share of the machine's RAM (`60%`). Without it, a
//! query may use 75% of the machine's RAM, or less when less is free when it
//! starts (data frames held by the process, other programs).

use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

pub struct MemoryPool {
    limit: AtomicUsize,
    used: AtomicUsize,
    peak: AtomicUsize,
    /// the default limit, adjusted to the free memory as queries start
    /// (cleared once a limit is set explicitly)
    fitted: AtomicBool,
    default_limit: AtomicUsize,
}

impl MemoryPool {
    pub const fn new(limit: usize) -> Self {
        Self {
            limit: AtomicUsize::new(limit),
            used: AtomicUsize::new(0),
            peak: AtomicUsize::new(0),
            fitted: AtomicBool::new(false),
            default_limit: AtomicUsize::new(limit),
        }
    }

    pub fn limit(&self) -> usize {
        self.limit.load(Ordering::Relaxed)
    }

    /// Change the limit (`usize::MAX`: none). Data already held stays.
    pub fn set_limit(&self, limit: usize) {
        self.fitted.store(false, Ordering::Relaxed);
        self.limit.store(limit, Ordering::Relaxed);
    }

    /// With the default limit: let the pool grow by at most 90% of the memory
    /// free now (called as a query starts), never past the default nor below
    /// half of it (the allocator keeps memory the process freed, which the
    /// system does not count as free).
    pub fn fit_to_free_memory(&self) {
        if !self.fitted.load(Ordering::Relaxed) {
            return;
        }
        let default = self.default_limit.load(Ordering::Relaxed);
        let limit = match available_memory() {
            Some(free) => default.min(self.used().saturating_add(free / 10 * 9).max(default / 2)),
            None => default,
        };
        self.limit.store(limit, Ordering::Relaxed);
    }

    /// Forget the peak (for a new measurement).
    pub fn reset_peak(&self) {
        self.peak.store(self.used(), Ordering::Relaxed);
    }

    /// Bring the peak up to at least `peak` (after a measurement that reset it).
    pub fn raise_peak(&self, peak: usize) {
        self.peak.fetch_max(peak, Ordering::Relaxed);
    }

    pub fn used(&self) -> usize {
        self.used.load(Ordering::Relaxed)
    }

    pub fn peak(&self) -> usize {
        self.peak.load(Ordering::Relaxed)
    }

    pub fn limited(&self) -> bool {
        self.limit() != usize::MAX
    }

    /// Take `n` bytes if they fit under the limit.
    fn try_take(&self, n: usize) -> bool {
        let limit = self.limit();
        let mut cur = self.used.load(Ordering::Relaxed);
        loop {
            let next = cur.saturating_add(n);
            if next > limit {
                return false;
            }
            match self.used.compare_exchange_weak(cur, next, Ordering::Relaxed, Ordering::Relaxed) {
                Ok(_) => {
                    self.peak.fetch_max(next, Ordering::Relaxed);
                    return true;
                }
                Err(actual) => cur = actual,
            }
        }
    }

    /// Take `n` bytes even over the limit (data that cannot be spilled).
    fn take(&self, n: usize) {
        let next = self.used.fetch_add(n, Ordering::Relaxed) + n;
        self.peak.fetch_max(next, Ordering::Relaxed);
    }

    fn give(&self, n: usize) {
        self.used.fetch_sub(n, Ordering::Relaxed);
    }

    pub fn reservation(&'static self) -> Reservation {
        Reservation { pool: self, bytes: 0 }
    }
}

/// Bytes held by one operator (released when dropped).
pub struct Reservation {
    pool: &'static MemoryPool,
    bytes: usize,
}

impl Reservation {
    pub fn size(&self) -> usize {
        self.bytes
    }

    /// Grow by `n` bytes if the pool has room; false means: spill.
    pub fn try_grow(&mut self, n: usize) -> bool {
        let ok = self.pool.try_take(n);
        if ok {
            self.bytes += n;
        }
        ok
    }

    /// Grow by `n` bytes whatever the limit says.
    pub fn grow(&mut self, n: usize) {
        self.pool.take(n);
        self.bytes += n;
    }

    /// Hold exactly `n` bytes (growing past the limit if needed).
    pub fn resize(&mut self, n: usize) {
        if n > self.bytes {
            self.grow(n - self.bytes);
        } else {
            self.shrink(self.bytes - n);
        }
    }

    pub fn shrink(&mut self, n: usize) {
        let n = n.min(self.bytes);
        self.pool.give(n);
        self.bytes -= n;
    }

    pub fn free(&mut self) {
        self.shrink(self.bytes);
    }
}

impl Drop for Reservation {
    fn drop(&mut self) {
        self.free();
    }
}

impl std::fmt::Debug for Reservation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Reservation({} bytes)", self.bytes)
    }
}

/// `2GB`, `512 MB`, `1.5GiB`, `123456`, `60%` (of `total`) -> bytes.
pub fn parse_limit(s: &str, total: Option<usize>) -> Option<usize> {
    let s = s.trim().to_ascii_lowercase();
    if let Some(pct) = s.strip_suffix('%') {
        let p: f64 = pct.trim().parse().ok()?;
        return Some((total? as f64 * p / 100.0) as usize);
    }
    let digits = s.find(|c: char| !(c.is_ascii_digit() || c == '.')).unwrap_or(s.len());
    let value: f64 = s[..digits].parse().ok()?;
    let unit = match s[digits..].trim().trim_end_matches('b').trim_end_matches('i') {
        "" => 1.0,
        "k" => 1024.0,
        "m" => 1024.0 * 1024.0,
        "g" => 1024.0 * 1024.0 * 1024.0,
        "t" => 1024f64.powi(4),
        _ => return None,
    };
    Some((value * unit) as usize)
}

/// Memory the machine could give the process now (free plus reclaimable
/// cache), when it can be read without extra dependencies.
pub fn available_memory() -> Option<usize> {
    #[cfg(target_os = "linux")]
    {
        let info = std::fs::read_to_string("/proc/meminfo").ok()?;
        let line = info.lines().find(|l| l.starts_with("MemAvailable:"))?;
        let kb: usize = line.split_whitespace().nth(1)?.parse().ok()?;
        Some(kb * 1024)
    }
    #[cfg(windows)]
    {
        memory_status().map(|s| s.avail_phys as usize)
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        None
    }
}

#[cfg(windows)]
#[repr(C)]
struct MemoryStatusEx {
    length: u32,
    memory_load: u32,
    total_phys: u64,
    avail_phys: u64,
    total_page_file: u64,
    avail_page_file: u64,
    total_virtual: u64,
    avail_virtual: u64,
    avail_extended_virtual: u64,
}

#[cfg(windows)]
fn memory_status() -> Option<MemoryStatusEx> {
    unsafe extern "system" {
        fn GlobalMemoryStatusEx(status: *mut MemoryStatusEx) -> i32;
    }
    unsafe {
        let mut status = std::mem::zeroed::<MemoryStatusEx>();
        status.length = std::mem::size_of::<MemoryStatusEx>() as u32;
        (GlobalMemoryStatusEx(&mut status) != 0).then_some(status)
    }
}

/// Physical memory of the machine, when it can be read without extra dependencies.
pub fn total_memory() -> Option<usize> {
    #[cfg(target_os = "linux")]
    {
        let info = std::fs::read_to_string("/proc/meminfo").ok()?;
        let line = info.lines().find(|l| l.starts_with("MemTotal:"))?;
        let kb: usize = line.split_whitespace().nth(1)?.parse().ok()?;
        Some(kb * 1024)
    }
    #[cfg(windows)]
    {
        memory_status().map(|s| s.total_phys as usize)
    }
    #[cfg(target_os = "macos")]
    {
        use std::ffi::c_void;
        unsafe extern "C" {
            fn sysctlbyname(
                name: *const std::ffi::c_char,
                oldp: *mut c_void,
                oldlenp: *mut usize,
                newp: *const c_void,
                newlen: usize,
            ) -> i32;
        }
        let mut mem: u64 = 0;
        let mut len = std::mem::size_of::<u64>();
        let name = c"hw.memsize";
        unsafe {
            if sysctlbyname(name.as_ptr(), &mut mem as *mut _ as *mut c_void, &mut len, std::ptr::null(), 0) == 0 {
                Some(mem as usize)
            } else {
                None
            }
        }
    }
    #[cfg(not(any(target_os = "linux", windows, target_os = "macos")))]
    {
        None
    }
}

/// The limit and whether it is the default (fitted to the free memory).
fn configured_limit() -> (usize, bool) {
    let total = total_memory();
    match std::env::var("IARA_MEMORY_LIMIT") {
        Ok(v) if !v.trim().is_empty() => (parse_limit(&v, total).unwrap_or(usize::MAX), false),
        _ => (total.map_or(usize::MAX, |t| t / 4 * 3), total.is_some()),
    }
}

static RELEASE: OnceLock<fn()> = OnceLock::new();

/// Set how a thread gives the memory it freed back to the system (the
/// allocator's own call; allocators keep freed memory for reuse, which
/// other allocators in the process, like numpy's, cannot use).
pub fn set_release(f: fn()) {
    let _ = RELEASE.set(f);
}

/// Give freed memory back on every engine thread (once no query runs).
pub fn release_freed() {
    if let Some(f) = RELEASE.get() {
        rayon::broadcast(|_| f());
        f();
    }
}

/// The process-wide pool.
pub fn pool() -> &'static MemoryPool {
    static POOL: OnceLock<MemoryPool> = OnceLock::new();
    POOL.get_or_init(|| {
        let (limit, fitted) = configured_limit();
        let pool = MemoryPool::new(limit);
        pool.fitted.store(fitted, Ordering::Relaxed);
        pool
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn limits_parse() {
        assert_eq!(parse_limit("2GB", None), Some(2 << 30));
        assert_eq!(parse_limit("512 mb", None), Some(512 << 20));
        assert_eq!(parse_limit("1.5GiB", None), Some(3 << 29));
        assert_eq!(parse_limit("4096", None), Some(4096));
        assert_eq!(parse_limit("50%", Some(1000)), Some(500));
        assert_eq!(parse_limit("50%", None), None);
        assert_eq!(parse_limit("lots", None), None);
    }

    #[test]
    fn reservations_respect_the_limit() {
        static POOL: MemoryPool = MemoryPool::new(100);
        let mut a = POOL.reservation();
        let mut b = POOL.reservation();
        assert!(a.try_grow(60));
        assert!(!b.try_grow(50));
        assert!(b.try_grow(40));
        a.shrink(30);
        assert!(b.try_grow(25));
        b.grow(1000); // unspillable data goes over
        assert_eq!(POOL.used(), 30 + 1065);
        drop(a);
        drop(b);
        assert_eq!(POOL.used(), 0);
        assert_eq!(POOL.peak(), 1095);
    }

    #[test]
    fn total_memory_detects_physical_ram() {
        println!("DETECTED: total_memory: {:?}, pool().limit(): {}", total_memory(), pool().limit());
        if cfg!(any(target_os = "linux", windows, target_os = "macos")) {
            let total = total_memory();
            assert!(total.is_some(), "total_memory should detect RAM on supported platforms");
            assert!(total.unwrap() > 1024 * 1024 * 1024, "machine should have at least 1 GB RAM");
        }
    }
}
