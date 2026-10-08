//! One object of a store, with ranged reads.

use std::ops::Range;
use std::sync::Arc;

use bytes::Bytes;
use object_store::path::Path;
use object_store::{ObjectStore, ObjectStoreExt};

use super::error::storage_err;
use super::runtime::block_on_cancellable;
use crate::error::Result;
use crate::exec::query::QueryHandle;
use crate::io::location::ObjectUrl;

#[derive(Clone)]
pub struct ObjectFile {
    pub url: ObjectUrl,
    pub path: Path,
    pub size: u64,
    pub store: Arc<dyn ObjectStore>,
}

impl std::fmt::Debug for ObjectFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.url)
    }
}

impl ObjectFile {
    pub async fn get_range(&self, range: Range<u64>) -> Result<Bytes> {
        self.store.get_range(&self.path, range).await.map_err(|e| storage_err(e, &self.url.to_string()))
    }

    /// Several ranges at once (nearby ones are coalesced into one request).
    pub async fn get_ranges(&self, ranges: &[Range<u64>]) -> Result<Vec<Bytes>> {
        self.store.get_ranges(&self.path, ranges).await.map_err(|e| storage_err(e, &self.url.to_string()))
    }

    pub fn read_ranges(&self, ranges: &[Range<u64>], cancel: Option<&QueryHandle>) -> Result<Vec<Bytes>> {
        block_on_cancellable(self.get_ranges(ranges), cancel)
    }

    pub fn read_range(&self, range: Range<u64>, cancel: Option<&QueryHandle>) -> Result<Bytes> {
        block_on_cancellable(self.get_range(range), cancel)
    }
}
