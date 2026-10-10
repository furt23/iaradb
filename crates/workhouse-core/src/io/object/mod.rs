//! Object stores (S3, in-memory) behind the synchronous, morsel-driven
//! engine: requests run on a small tokio runtime of their own and worker
//! threads block on them (cancellably) or consume what a prefetcher fetched
//! ahead.
//!
//! Object stores bill per request, so the layer keeps requests few: every
//! store is wrapped to count them (`counting`) and to coalesce ranges into
//! big reads (`coalesce`), listings are remembered for a while
//! (`list_cache`), and consecutive row groups are fetched together
//! (`prefetch`). `config` lists the environment variables that tune it.

pub mod coalesce;
pub mod config;
pub mod counting;
pub mod error;
pub mod file;
pub mod list;
pub mod list_cache;
pub mod prefetch;
pub mod registry;
pub mod remove;
pub mod runtime;
pub mod write;

pub use counting::{StorageRequests, scope_requests, storage_requests};
pub use file::ObjectFile;

/// The object path of a key, as written (`Path::from` would percent-encode
/// a `%`, so Hive's escaped folder names such as `a%2Fb` would change).
pub fn object_path(key: &str) -> object_store::path::Path {
    object_store::path::Path::parse(key).unwrap_or_else(|_| object_store::path::Path::from(key))
}
pub use registry::{clear_object_stores, memory_store, set_storage_options, storage_options_for};
pub use runtime::{block_on, block_on_cancellable};
