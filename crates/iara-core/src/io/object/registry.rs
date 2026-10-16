//! Object stores, built once per (bucket, options) and shared, and default
//! storage options by URL prefix (`s3://bucket` or `s3://bucket/some/prefix`).

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};

use object_store::ObjectStore;
use object_store::memory::InMemory;
use parking_lot::{Mutex, RwLock};

use super::counting::CountingStore;
use crate::error::{Result, WhError};
use crate::io::location::ObjectUrl;
use crate::io::options::StorageOptions;

type StoreKey = (String, StorageOptions);

/// A built store. Its `id` tells it from every other store the registry
/// ever built (a rebuilt store gets a new one), for cache keys.
#[derive(Clone)]
pub struct Store {
    pub store: Arc<dyn ObjectStore>,
    pub id: u64,
}

static STORES: LazyLock<Mutex<HashMap<StoreKey, Store>>> = LazyLock::new(Default::default);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
static DEFAULTS: LazyLock<RwLock<Vec<(String, StorageOptions)>>> = LazyLock::new(Default::default);
static MEMORY: LazyLock<Mutex<HashMap<String, Arc<InMemory>>>> = LazyLock::new(Default::default);

/// Default options for every URL under `prefix` (empty options remove them).
pub fn set_storage_options(prefix: &str, options: StorageOptions) {
    let prefix = prefix.trim_end_matches('/').to_string();
    let mut d = DEFAULTS.write();
    d.retain(|(p, _)| *p != prefix);
    if !options.is_empty() {
        d.push((prefix, options));
    }
}

/// The defaults of the longest prefix that `url` falls under.
pub fn storage_options_for(url: &str) -> StorageOptions {
    let under = |p: &str| url == p || url.strip_prefix(p).is_some_and(|r| r.starts_with('/'));
    DEFAULTS
        .read()
        .iter()
        .filter(|(p, _)| under(p))
        .max_by_key(|(p, _)| p.len())
        .map(|(_, o)| o.clone())
        .unwrap_or_default()
}

/// Forget built stores (e.g. after credentials changed), and what was cached
/// from them; defaults stay.
pub fn clear_object_stores() {
    STORES.lock().clear();
    super::list_cache::clear();
    crate::io::parquet::meta_cache::clear();
}

/// The in-memory store behind `memory://<name>/...` (tests, scratch data).
pub fn memory_store(name: &str) -> Arc<InMemory> {
    MEMORY.lock().entry(name.to_string()).or_insert_with(|| Arc::new(InMemory::new())).clone()
}

/// The store serving `url`: `explicit` options over the prefix defaults over
/// the environment (`AWS_*` variables, then the instance profile).
pub fn open(url: &ObjectUrl, explicit: &StorageOptions) -> Result<Store> {
    let options = explicit.over(&storage_options_for(&url.to_string()));
    let key = (url.root(), options);
    if let Some(s) = STORES.lock().get(&key) {
        return Ok(s.clone());
    }
    let raw: Arc<dyn ObjectStore> = match url.scheme.as_str() {
        "memory" => memory_store(&url.bucket),
        "s3" => build_s3(url, &key.1)?,
        other => return Err(WhError::Storage(format!("unsupported storage scheme '{other}://'"))),
    };
    let built = Store { store: CountingStore::wrap(raw, &key.0), id: NEXT_ID.fetch_add(1, Ordering::Relaxed) };
    Ok(STORES.lock().entry(key).or_insert(built).clone())
}

pub fn store(url: &ObjectUrl, explicit: &StorageOptions) -> Result<Arc<dyn ObjectStore>> {
    open(url, explicit).map(|s| s.store)
}

#[cfg(feature = "s3")]
fn build_s3(url: &ObjectUrl, options: &StorageOptions) -> Result<Arc<dyn ObjectStore>> {
    use object_store::RetryConfig;
    use object_store::aws::{AmazonS3Builder, AmazonS3ConfigKey};
    install_crypto_provider();
    let retry = RetryConfig { max_retries: 5, retry_timeout: std::time::Duration::from_secs(60), ..Default::default() };
    let mut b = AmazonS3Builder::from_env().with_bucket_name(&url.bucket).with_retry(retry);
    for (k, v) in options.iter() {
        if super::put_if_absent::is_engine_option(k) {
            continue;
        }
        let key: AmazonS3ConfigKey = k.parse().map_err(|_| WhError::Storage(format!("unknown storage option '{k}'")))?;
        b = b.with_config(key, v);
    }
    let s3 = b.build().map_err(|e| super::error::storage_err(e, &url.root()))?;
    Ok(Arc::new(s3))
}

#[cfg(not(feature = "s3"))]
fn build_s3(url: &ObjectUrl, _: &StorageOptions) -> Result<Arc<dyn ObjectStore>> {
    Err(WhError::Storage(format!("{}: S3 support was not compiled in (feature \"s3\")", url.root())))
}

/// TLS through rustls with the ring provider (no aws-lc toolchain needed).
#[cfg(feature = "s3")]
fn install_crypto_provider() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let _ = rustls::crypto::ring::default_provider().install_default();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn longest_prefix_defaults_apply() {
        set_storage_options("memory://reg-a", StorageOptions::new().with("region", "x"));
        set_storage_options("memory://reg-a/deep/", StorageOptions::new().with("region", "y"));
        assert_eq!(storage_options_for("memory://reg-a/k").get("region"), Some("x"));
        assert_eq!(storage_options_for("memory://reg-a/deep/k").get("region"), Some("y"));
        assert!(storage_options_for("memory://reg-ab/k").is_empty());
        set_storage_options("memory://reg-a/deep", StorageOptions::new());
        assert_eq!(storage_options_for("memory://reg-a/deep/k").get("region"), Some("x"));
    }
}
