//! Tuning knobs of remote reads, from environment variables (read where
//! used, so they can change between queries).

use std::time::Duration;

fn env_u64(name: &str, default: u64) -> u64 {
    std::env::var(name).ok().and_then(|v| v.trim().parse().ok()).unwrap_or(default)
}

/// `WORKHOUSE_COALESCE_KB` (default 1024): byte ranges of one object at most
/// this far apart are fetched with one request.
pub fn coalesce_gap() -> u64 {
    env_u64("WORKHOUSE_COALESCE_KB", 1024) << 10
}

/// `WORKHOUSE_MAX_REQUEST_MB` (default 64): the most one coalesced request
/// asks for (a single larger range is still one request).
pub fn max_request() -> u64 {
    env_u64("WORKHOUSE_MAX_REQUEST_MB", 64).max(1) << 20
}

/// `WORKHOUSE_FETCH_TARGET_MB` (default 32): compressed column-chunk bytes of
/// consecutive row groups of a file fetched as one job (0: one job per row group).
pub fn fetch_target() -> u64 {
    env_u64("WORKHOUSE_FETCH_TARGET_MB", 32) << 20
}

/// `WORKHOUSE_FOOTER_GUESS_KB` (default 512): bytes read from the end of a
/// Parquet file at first; files up to this size are read whole, in that one request.
pub fn footer_guess() -> u64 {
    env_u64("WORKHOUSE_FOOTER_GUESS_KB", 512).max(1) << 10
}

/// `WORKHOUSE_METADATA_CACHE_MB` (default 256; 0 disables): decoded Parquet
/// footers kept for the process.
pub fn metadata_cache_bytes() -> u64 {
    env_u64("WORKHOUSE_METADATA_CACHE_MB", 256) << 20
}

/// `WORKHOUSE_LIST_CACHE_SECS` (default 30; 0 disables): how long a listing
/// of an object store prefix is reused.
pub fn list_cache_ttl() -> Duration {
    Duration::from_secs(env_u64("WORKHOUSE_LIST_CACHE_SECS", 30))
}
