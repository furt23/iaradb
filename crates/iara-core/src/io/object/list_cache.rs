//! A short-lived, process-wide cache of listings: listing a prefix is the
//! dearest request an object store serves, and the same table is listed
//! again by every new table object (SQL `FROM 's3://...'`, `read_parquet()`,
//! a workspace session starting over).
//!
//! Entries are valid for `IARA_LIST_CACHE_SECS` (30). The engine's own
//! writes and deletes drop every entry that holds, or lies inside, the
//! written path, so what this process wrote is listed at once; what other
//! writers add shows up when the entry expires.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::time::Instant;

use object_store::ObjectMeta;
use parking_lot::Mutex;

use super::config;

/// What was asked of the store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Kind {
    /// every object under a prefix
    Prefix,
    /// one object (the listing has just that one)
    Head,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct Key {
    store: u64,
    kind: Kind,
    path: String,
}

struct Entry {
    at: Instant,
    /// `s3://bucket`, for invalidation
    root: String,
    metas: Arc<Vec<ObjectMeta>>,
}

/// Entries kept at most (each can hold a big listing).
const MAX_ENTRIES: usize = 128;

static CACHE: LazyLock<Mutex<HashMap<Key, Entry>>> = LazyLock::new(Default::default);
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Taken before listing, handed to [`put`]: a listing that overlapped an
/// invalidation may lack what that write added, and is not kept.
pub fn generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}

pub fn get(store: u64, kind: Kind, path: &str) -> Option<Arc<Vec<ObjectMeta>>> {
    let ttl = config::list_cache_ttl();
    if ttl.is_zero() {
        return None;
    }
    let key = Key { store, kind, path: path.trim_end_matches('/').to_string() };
    let mut cache = CACHE.lock();
    match cache.get(&key) {
        Some(e) if e.at.elapsed() < ttl => Some(e.metas.clone()),
        Some(_) => {
            cache.remove(&key);
            None
        }
        None => None,
    }
}

/// Keep a listing (never an empty one: that is an error to the caller, and
/// worth asking again).
pub fn put(generation: u64, store: u64, root: &str, kind: Kind, path: &str, metas: Arc<Vec<ObjectMeta>>) {
    let ttl = config::list_cache_ttl();
    if ttl.is_zero() || metas.is_empty() {
        return;
    }
    let mut cache = CACHE.lock();
    if generation != self::generation() {
        return;
    }
    cache.retain(|_, e| e.at.elapsed() < ttl);
    if cache.len() >= MAX_ENTRIES {
        if let Some(oldest) = cache.iter().min_by_key(|(_, e)| e.at).map(|(k, _)| k.clone()) {
            cache.remove(&oldest);
        }
    }
    let key = Key { store, kind, path: path.trim_end_matches('/').to_string() };
    cache.insert(key, Entry { at: Instant::now(), root: root.to_string(), metas });
}

/// `path` (an object, or a folder) of the store `root` was written or deleted.
pub fn invalidate(root: &str, path: &str) {
    let path = path.trim_matches('/');
    let mut cache = CACHE.lock();
    GENERATION.fetch_add(1, Ordering::AcqRel);
    cache.retain(|k, e| e.root != root || !(contains(&k.path, path) || contains(path, &k.path)));
}

pub fn clear() {
    let mut cache = CACHE.lock();
    GENERATION.fetch_add(1, Ordering::AcqRel);
    cache.clear();
}

/// Whether `inner` is `outer` or lies under it (the empty path holds everything).
fn contains(outer: &str, inner: &str) -> bool {
    outer.is_empty() || inner == outer || inner.strip_prefix(outer).is_some_and(|r| r.starts_with('/'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use object_store::path::Path;

    fn metas(name: &str) -> Arc<Vec<ObjectMeta>> {
        let m = ObjectMeta { location: Path::from(name), last_modified: Default::default(), size: 1, e_tag: None, version: None };
        Arc::new(vec![m])
    }

    /// Store a listing even if a parallel test invalidated meanwhile.
    fn keep(store: u64, root: &str, kind: Kind, path: &str) {
        while get(store, kind, path).is_none() {
            put(generation(), store, root, kind, path, metas("x"));
        }
    }

    #[test]
    fn writes_drop_the_listings_around_them() {
        let (store, root) = (9_000_001, "memory://list-cache-test");
        for p in ["", "sales", "sales/year=2024", "sales2", "other"] {
            keep(store, root, Kind::Prefix, p);
        }
        // a file below: the whole bucket, `sales` and `sales/year=2024` hold it
        invalidate(root, "sales/year=2024/part-0.parquet");
        let alive: Vec<_> = ["", "sales", "sales/year=2024", "sales2", "other"].iter().map(|p| get(store, Kind::Prefix, p).is_some()).collect();
        assert_eq!(alive, vec![false, false, false, true, true]);
        // a folder removed: the listings inside it go, and the ones holding it
        keep(store, root, Kind::Prefix, "sales/year=2024");
        keep(store, root, Kind::Head, "sales/year=2024/a.parquet");
        invalidate(root, "sales/");
        assert!(get(store, Kind::Prefix, "sales/year=2024").is_none() && get(store, Kind::Head, "sales/year=2024/a.parquet").is_none());
        assert!(get(store, Kind::Prefix, "other").is_some());
        // another bucket is untouched
        invalidate("memory://elsewhere", "");
        assert!(get(store, Kind::Prefix, "other").is_some());
    }

    #[test]
    fn a_listing_that_raced_a_write_is_not_kept() {
        let (store, root) = (9_000_002, "memory://list-cache-race");
        let before = generation();
        invalidate(root, "t/a.parquet");
        put(before, store, root, Kind::Prefix, "t", metas("x"));
        assert!(get(store, Kind::Prefix, "t").is_none());
        put(generation(), store, root, Kind::Prefix, "t", Arc::new(vec![]));
        assert!(get(store, Kind::Prefix, "t").is_none(), "empty listings are not kept");
    }
}
