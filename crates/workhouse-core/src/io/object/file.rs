//! One object of a store, with ranged reads.

use std::ops::Range;
use std::sync::Arc;

use bytes::Bytes;
use object_store::path::Path;
use object_store::{ObjectMeta, ObjectStore, ObjectStoreExt};

use super::error::storage_err;
use super::runtime::block_on_cancellable;
use crate::error::Result;
use crate::exec::query::QueryHandle;
use crate::io::location::ObjectUrl;

/// Which version of which object: equal keys mean the same bytes, as far as
/// the listing that produced them can tell.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct VersionKey {
    pub store: u64,
    pub path: String,
    pub size: u64,
    /// the entity tag, else the modification time
    pub stamp: String,
}

#[derive(Clone)]
pub struct ObjectFile {
    pub url: ObjectUrl,
    pub path: Path,
    pub size: u64,
    pub store: Arc<dyn ObjectStore>,
    /// id of the store (see the registry)
    pub store_id: u64,
    /// the listing's entity tag, else its modification time
    pub stamp: String,
    /// the whole object, when it was read already (small files): ranges are
    /// then served from memory
    pub content: Option<Bytes>,
}

impl std::fmt::Debug for ObjectFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.url)
    }
}

impl ObjectFile {
    /// An object a listing returned.
    pub fn from_meta(url: ObjectUrl, meta: ObjectMeta, store: Arc<dyn ObjectStore>, store_id: u64) -> Self {
        let stamp = meta.e_tag.clone().unwrap_or_else(|| meta.last_modified.timestamp_nanos_opt().unwrap_or_default().to_string());
        Self { url, path: meta.location, size: meta.size, store, store_id, stamp, content: None }
    }

    pub fn version_key(&self) -> VersionKey {
        VersionKey { store: self.store_id, path: self.path.to_string(), size: self.size, stamp: self.stamp.clone() }
    }

    /// The same object, holding its bytes.
    pub fn with_content(mut self, content: Bytes) -> Self {
        self.content = Some(content);
        self
    }

    pub async fn get_range(&self, range: Range<u64>) -> Result<Bytes> {
        if let Some(data) = &self.content {
            return Ok(slice(data, &range));
        }
        self.store.get_range(&self.path, range).await.map_err(|e| storage_err(e, &self.url.to_string()))
    }

    /// Several ranges at once (nearby ones are coalesced into one request).
    pub async fn get_ranges(&self, ranges: &[Range<u64>]) -> Result<Vec<Bytes>> {
        if let Some(data) = &self.content {
            return Ok(ranges.iter().map(|r| slice(data, r)).collect());
        }
        self.store.get_ranges(&self.path, ranges).await.map_err(|e| storage_err(e, &self.url.to_string()))
    }

    pub fn read_ranges(&self, ranges: &[Range<u64>], cancel: Option<&QueryHandle>) -> Result<Vec<Bytes>> {
        block_on_cancellable(self.get_ranges(ranges), cancel)
    }

    pub fn read_range(&self, range: Range<u64>, cancel: Option<&QueryHandle>) -> Result<Bytes> {
        block_on_cancellable(self.get_range(range), cancel)
    }
}

fn slice(data: &Bytes, r: &Range<u64>) -> Bytes {
    let end = (r.end as usize).min(data.len());
    data.slice((r.start as usize).min(end)..end)
}
