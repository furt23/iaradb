//! Expanding an object URL (one object, a "directory" prefix, or a glob such
//! as `s3://b/sales/**/*.parquet`) into the objects it names.

use std::sync::Arc;

use futures::TryStreamExt;
use object_store::path::Path;
use object_store::{ObjectMeta, ObjectStore, ObjectStoreExt};

use super::error::storage_err;
use super::file::ObjectFile;
use super::registry;
use super::runtime::block_on;
use crate::error::{Result, WhError};
use crate::io::location::{ObjectUrl, has_glob};
use crate::io::options::StorageOptions;

/// The objects `url` names, sorted by key; `.ext` filters directory listings.
pub fn list(url: &ObjectUrl, ext: &str, options: &StorageOptions) -> Result<Vec<ObjectFile>> {
    let store = registry::store(url, options)?;
    let metas = block_on(list_metas(&store, url, ext))?;
    if metas.is_empty() {
        return Err(WhError::Plan(format!("no .{ext} files found at '{url}'")));
    }
    Ok(metas
        .into_iter()
        .map(|m| ObjectFile { url: url.with_key(m.location.as_ref()), path: m.location, size: m.size, store: store.clone() })
        .collect())
}

async fn list_metas(store: &Arc<dyn ObjectStore>, url: &ObjectUrl, ext: &str) -> Result<Vec<ObjectMeta>> {
    let key = url.key.trim_end_matches('/');
    let mut metas = if has_glob(key) {
        let pattern = glob::Pattern::new(key).map_err(|e| WhError::Plan(format!("invalid glob '{url}': {e}")))?;
        let opts = glob::MatchOptions { require_literal_separator: true, ..Default::default() };
        let all = list_prefix(store, url, glob_prefix(key)).await?;
        all.into_iter().filter(|m| pattern.matches_with(m.location.as_ref(), opts)).collect()
    } else if has_extension(key, ext) {
        vec![head(store, url, key).await?]
    } else {
        let found: Vec<ObjectMeta> =
            list_prefix(store, url, key).await?.into_iter().filter(|m| has_extension(m.location.as_ref(), ext)).collect();
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

async fn list_prefix(store: &Arc<dyn ObjectStore>, url: &ObjectUrl, prefix: &str) -> Result<Vec<ObjectMeta>> {
    let prefix = (!prefix.is_empty()).then(|| Path::from(prefix));
    store.list(prefix.as_ref()).try_collect().await.map_err(|e| storage_err(e, &url.to_string()))
}

async fn head(store: &Arc<dyn ObjectStore>, url: &ObjectUrl, key: &str) -> Result<ObjectMeta> {
    store.head(&Path::from(key)).await.map_err(|e| storage_err(e, &url.with_key(key).to_string()))
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
