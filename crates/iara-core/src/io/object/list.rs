//! Expanding an object URL (one object, a "directory" prefix, or a glob such
//! as `s3://b/sales/**/*.parquet`) into the objects it names.

use std::sync::Arc;

use futures::TryStreamExt;
use object_store::{ObjectMeta, ObjectStoreExt};

use super::error::storage_err;
use super::file::ObjectFile;
use super::list_cache::{self, Kind};
use super::registry::{self, Store};
use super::runtime::block_on;
use crate::error::{Result, WhError};
use crate::io::location::{ObjectUrl, has_glob};
use crate::io::options::StorageOptions;

/// The objects `url` names, sorted by key; `.ext` filters directory listings.
/// Listings are reused for a short while (see [`list_cache`]).
pub fn list(url: &ObjectUrl, ext: &str, options: &StorageOptions) -> Result<Vec<ObjectFile>> {
    let store = registry::open(url, options)?;
    let metas = block_on(list_metas(&store, url, ext))?;
    if metas.is_empty() {
        return Err(WhError::Plan(format!("no .{ext} files found at '{url}'")));
    }
    Ok(metas.into_iter().map(|m| ObjectFile::from_meta(url.with_key(m.location.as_ref()), m, store.store.clone(), store.id)).collect())
}

async fn list_metas(store: &Store, url: &ObjectUrl, ext: &str) -> Result<Vec<ObjectMeta>> {
    let key = url.key.trim_end_matches('/');
    let mut metas = if has_glob(key) {
        let pattern = glob::Pattern::new(key).map_err(|e| WhError::Plan(format!("invalid glob '{url}': {e}")))?;
        let opts = glob::MatchOptions { require_literal_separator: true, ..Default::default() };
        let all = list_prefix(store, url, glob_prefix(key)).await?;
        all.iter().filter(|m| pattern.matches_with(m.location.as_ref(), opts)).cloned().collect()
    } else if has_extension(key, ext) {
        vec![head(store, url, key).await?]
    } else {
        let found: Vec<ObjectMeta> =
            list_prefix(store, url, key).await?.iter().filter(|m| has_extension(m.location.as_ref(), ext)).cloned().collect();
        if found.is_empty() && !key.is_empty() {
            // an object without the extension, named exactly
            head(store, url, key).await.map(|m| vec![m]).unwrap_or_default()
        } else {
            found
        }
    };
    metas.sort_by(|a, b| a.location.cmp(&b.location));
    Ok(metas)
}

async fn list_prefix(store: &Store, url: &ObjectUrl, prefix: &str) -> Result<Arc<Vec<ObjectMeta>>> {
    if let Some(hit) = list_cache::get(store.id, Kind::Prefix, prefix) {
        return Ok(hit);
    }
    let generation = list_cache::generation();
    let path = (!prefix.is_empty()).then(|| super::object_path(prefix));
    let metas: Vec<ObjectMeta> = store.store.list(path.as_ref()).try_collect().await.map_err(|e| storage_err(e, &url.to_string()))?;
    let metas = Arc::new(metas);
    list_cache::put(generation, store.id, &url.root(), Kind::Prefix, prefix, metas.clone());
    Ok(metas)
}

async fn head(store: &Store, url: &ObjectUrl, key: &str) -> Result<ObjectMeta> {
    if let Some(hit) = list_cache::get(store.id, Kind::Head, key) {
        return Ok(hit[0].clone());
    }
    let generation = list_cache::generation();
    let meta = store.store.head(&super::object_path(key)).await.map_err(|e| storage_err(e, &url.with_key(key).to_string()))?;
    list_cache::put(generation, store.id, &url.root(), Kind::Head, key, Arc::new(vec![meta.clone()]));
    Ok(meta)
}

/// The directory part of a glob before its first wildcard (`a/b*/c` -> `a`).
fn glob_prefix(key: &str) -> &str {
    let first = key.find(['*', '?', '[']).unwrap_or(key.len());
    key[..first].rfind('/').map_or("", |i| &key[..i])
}

fn has_extension(key: &str, ext: &str) -> bool {
    key.rsplit_once('.').is_some_and(|(_, e)| e.eq_ignore_ascii_case(ext))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn glob_prefixes() {
        assert_eq!(glob_prefix("a/b/*.parquet"), "a/b");
        assert_eq!(glob_prefix("a/b*/c"), "a");
        assert_eq!(glob_prefix("*.csv"), "");
        assert_eq!(glob_prefix("a/**/x.parquet"), "a");
    }
}
