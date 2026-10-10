//! Folders of objects: whether one holds anything, and deleting it (a table
//! being replaced).

use futures::TryStreamExt;
use object_store::ObjectStoreExt;
use object_store::path::Path;

use super::error::storage_err;
use super::list_cache;
use super::registry;
use super::runtime::block_on;
use crate::error::Result;
use crate::io::location::ObjectUrl;
use crate::io::options::StorageOptions;

fn prefix(url: &ObjectUrl) -> Option<Path> {
    let key = url.key.trim_end_matches('/');
    (!key.is_empty()).then(|| super::object_path(key))
}

/// Whether any object lives under the folder `url`.
pub fn any_under(url: &ObjectUrl, options: &StorageOptions) -> Result<bool> {
    let store = registry::store(url, options)?;
    let prefix = prefix(url);
    block_on(async move {
        let mut objects = store.list(prefix.as_ref());
        objects.try_next().await.map(|o| o.is_some()).map_err(|e| storage_err(e, &url.to_string()))
    })
}

/// Delete every object under the folder `url`; returns how many.
pub fn remove_under(url: &ObjectUrl, options: &StorageOptions) -> Result<usize> {
    let store = registry::store(url, options)?;
    let prefix = prefix(url);
    let deleted = block_on(async move {
        let objects: Vec<_> = store.list(prefix.as_ref()).try_collect().await.map_err(|e| storage_err(e, &url.to_string()))?;
        for o in &objects {
            store.delete(&o.location).await.map_err(|e| storage_err(e, &url.to_string()))?;
        }
        Ok(objects.len())
    });
    // even half done: some objects may be gone
    list_cache::invalidate(&url.root(), &url.key);
    deleted
}
