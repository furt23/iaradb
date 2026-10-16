//! Process-wide memory of the string-column samples behind distinct-count
//! estimates (reading one column chunk of a remote file is a request each
//! time a new table object is planned over the same file).

use std::collections::HashMap;
use std::sync::LazyLock;

use parking_lot::Mutex;

use crate::io::object::file::VersionKey;

/// (distinct values, rows) of a sample.
pub type Sample = (usize, usize);

/// Samples kept at most (the cache starts over beyond that).
const MAX_ENTRIES: usize = 4096;

static CACHE: LazyLock<Mutex<HashMap<(VersionKey, usize), Sample>>> = LazyLock::new(Default::default);

/// The sample of `column` of the remote file `file` (`None`: a local file,
/// which is cheap to read), computed on the first ask.
pub fn get_or_compute(file: Option<VersionKey>, column: usize, compute: impl FnOnce() -> Option<Sample>) -> Option<Sample> {
    let Some(file) = file else { return compute() };
    let key = (file, column);
    if let Some(hit) = CACHE.lock().get(&key) {
        return Some(*hit);
    }
    let sample = compute()?;
    let mut cache = CACHE.lock();
    if cache.len() >= MAX_ENTRIES {
        cache.clear();
    }
    cache.insert(key, sample);
    Some(sample)
}

pub fn clear() {
    CACHE.lock().clear();
}
