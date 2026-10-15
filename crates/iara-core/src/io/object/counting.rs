//! Counting the requests made to object stores, as a billing proxy: object
//! stores charge per request (LIST and PUT dearest), so how many a query
//! makes matters as much as how many bytes it reads.
//!
//! Every store the registry builds is wrapped in a [`CountingStore`]. It
//! counts LIST pages, HEAD and GET requests plus the bytes asked for in
//! process-wide atomics (and per store root, for tests), and also does the
//! range coalescing of [`get_ranges`](ObjectStore::get_ranges). Retries done
//! inside the client are not visible here: they are not counted.

use std::collections::HashMap;
use std::fmt;
use std::ops::Range;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock};
use std::task::{Context, Poll};

use async_trait::async_trait;
use bytes::Bytes;
use futures::stream::{BoxStream, Stream, StreamExt, TryStreamExt};
use object_store::path::Path;
use object_store::{
    CopyOptions, GetOptions, GetResult, ListResult, MultipartUpload, ObjectMeta, ObjectStore, PutMultipartOptions, PutOptions, PutPayload,
    PutResult, RenameOptions, Result,
};
use parking_lot::Mutex;

use super::coalesce::Plan;
use super::config;

/// Objects per LIST page (S3 and R2 return at most 1000 keys per request).
const LIST_PAGE: u64 = 1000;
/// Merged ranges of one `get_ranges` call fetched at once.
const PARALLEL_GETS: usize = 16;

/// Requests made to object stores (over a span of time, or in total).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct StorageRequests {
    pub list: u64,
    pub head: u64,
    pub get: u64,
    /// bytes asked for by GET requests
    pub bytes: u64,
}

impl StorageRequests {
    /// What happened after `before` was taken.
    pub fn since(self, before: StorageRequests) -> StorageRequests {
        StorageRequests {
            list: self.list.saturating_sub(before.list),
            head: self.head.saturating_sub(before.head),
            get: self.get.saturating_sub(before.get),
            bytes: self.bytes.saturating_sub(before.bytes),
        }
    }

    /// Requests of every kind.
    pub fn count(&self) -> u64 {
        self.list + self.head + self.get
    }
}

#[derive(Default)]
struct Counters {
    list: AtomicU64,
    head: AtomicU64,
    get: AtomicU64,
    bytes: AtomicU64,
}

impl Counters {
    const fn new() -> Self {
        Self { list: AtomicU64::new(0), head: AtomicU64::new(0), get: AtomicU64::new(0), bytes: AtomicU64::new(0) }
    }

    fn snapshot(&self) -> StorageRequests {
        StorageRequests {
            list: self.list.load(Ordering::Relaxed),
            head: self.head.load(Ordering::Relaxed),
            get: self.get.load(Ordering::Relaxed),
            bytes: self.bytes.load(Ordering::Relaxed),
        }
    }
}

static TOTALS: Counters = Counters::new();
static SCOPES: LazyLock<Mutex<HashMap<String, Arc<Counters>>>> = LazyLock::new(Default::default);

/// Requests made by this process so far, to every store.
pub fn storage_requests() -> StorageRequests {
    TOTALS.snapshot()
}

/// Requests made so far to the stores of one root (`s3://bucket`).
pub fn scope_requests(root: &str) -> StorageRequests {
    SCOPES.lock().get(root).map(|c| c.snapshot()).unwrap_or_default()
}

/// Bumps the process totals and the counters of one store root.
#[derive(Clone)]
struct Meter(Arc<Counters>);

impl Meter {
    fn for_root(root: &str) -> Self {
        Meter(SCOPES.lock().entry(root.to_string()).or_default().clone())
    }

    fn list(&self) {
        self.0.list.fetch_add(1, Ordering::Relaxed);
        TOTALS.list.fetch_add(1, Ordering::Relaxed);
    }

    fn head(&self) {
        self.0.head.fetch_add(1, Ordering::Relaxed);
        TOTALS.head.fetch_add(1, Ordering::Relaxed);
    }

    fn get(&self, bytes: u64) {
        self.0.get.fetch_add(1, Ordering::Relaxed);
        self.0.bytes.fetch_add(bytes, Ordering::Relaxed);
        TOTALS.get.fetch_add(1, Ordering::Relaxed);
        TOTALS.bytes.fetch_add(bytes, Ordering::Relaxed);
    }
}

/// An object store that counts its requests.
pub struct CountingStore {
    inner: Arc<dyn ObjectStore>,
    meter: Meter,
}

impl CountingStore {
    /// `root` names the store in per-root counts (`s3://bucket`).
    pub fn wrap(inner: Arc<dyn ObjectStore>, root: &str) -> Arc<dyn ObjectStore> {
        Arc::new(Self { inner, meter: Meter::for_root(root) })
    }

    /// One counted GET of exactly `range`.
    async fn get_one(&self, location: &Path, range: Range<u64>) -> Result<Bytes> {
        self.get_opts(location, GetOptions::new().with_range(Some(range))).await?.bytes().await
    }

    fn counted_list(&self, inner: BoxStream<'static, Result<ObjectMeta>>) -> BoxStream<'static, Result<ObjectMeta>> {
        Box::pin(CountedList { inner, meter: self.meter.clone(), started: false, items: 0 })
    }
}

impl fmt::Display for CountingStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Counting({})", self.inner)
    }
}

impl fmt::Debug for CountingStore {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "CountingStore({:?})", self.inner)
    }
}

/// A listing: its first poll is the first page's request, and every
/// thousand objects past the first thousand another page's.
struct CountedList {
    inner: BoxStream<'static, Result<ObjectMeta>>,
    meter: Meter,
    /// the first page was counted (a stream is polled again while it is pending)
    started: bool,
    items: u64,
}

impl Stream for CountedList {
    type Item = Result<ObjectMeta>;

    fn poll_next(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<Option<Self::Item>> {
        if !self.started {
            self.started = true;
            self.meter.list();
        }
        let next = self.inner.poll_next_unpin(cx);
        if let Poll::Ready(Some(Ok(_))) = &next {
            self.items += 1;
            if self.items > 1 && self.items % LIST_PAGE == 1 {
                self.meter.list();
            }
        }
        next
    }
}

#[async_trait]
impl ObjectStore for CountingStore {
    async fn put_opts(&self, location: &Path, payload: PutPayload, opts: PutOptions) -> Result<PutResult> {
        self.inner.put_opts(location, payload, opts).await
    }

    async fn put_multipart_opts(&self, location: &Path, opts: PutMultipartOptions) -> Result<Box<dyn MultipartUpload>> {
        self.inner.put_multipart_opts(location, opts).await
    }

    async fn get_opts(&self, location: &Path, options: GetOptions) -> Result<GetResult> {
        let head = options.head;
        let result = self.inner.get_opts(location, options).await;
        if head {
            self.meter.head();
        } else {
            self.meter.get(result.as_ref().map_or(0, |r| r.range.end - r.range.start));
        }
        result
    }

    /// Ranges close to each other share a request, many requests run at once.
    async fn get_ranges(&self, location: &Path, ranges: &[Range<u64>]) -> Result<Vec<Bytes>> {
        let plan = Plan::new(ranges, config::coalesce_gap(), config::max_request());
        let fetched: Vec<Bytes> = futures::stream::iter(plan.requests().to_vec())
            .map(|r| self.get_one(location, r))
            .buffered(PARALLEL_GETS)
            .try_collect()
            .await?;
        Ok(plan.slice(&fetched))
    }

    fn delete_stream(&self, locations: BoxStream<'static, Result<Path>>) -> BoxStream<'static, Result<Path>> {
        self.inner.delete_stream(locations)
    }

    fn list(&self, prefix: Option<&Path>) -> BoxStream<'static, Result<ObjectMeta>> {
        self.counted_list(self.inner.list(prefix))
    }

    fn list_with_offset(&self, prefix: Option<&Path>, offset: &Path) -> BoxStream<'static, Result<ObjectMeta>> {
        self.counted_list(self.inner.list_with_offset(prefix, offset))
    }

    async fn list_with_delimiter(&self, prefix: Option<&Path>) -> Result<ListResult> {
        self.meter.list();
        self.inner.list_with_delimiter(prefix).await
    }

    async fn copy_opts(&self, from: &Path, to: &Path, options: CopyOptions) -> Result<()> {
        self.inner.copy_opts(from, to, options).await
    }

    async fn rename_opts(&self, from: &Path, to: &Path, options: RenameOptions) -> Result<()> {
        self.inner.rename_opts(from, to, options).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use object_store::ObjectStoreExt;
    use object_store::memory::InMemory;

    use crate::io::object::block_on;

    fn store(root: &str) -> Arc<dyn ObjectStore> {
        CountingStore::wrap(Arc::new(InMemory::new()), root)
    }

    #[test]
    fn counts_lists_heads_and_gets() {
        let (root, s) = ("memory://counting-basic", store("memory://counting-basic"));
        block_on(async {
            for i in 0..3 {
                s.put(&Path::from(format!("d/{i}")), PutPayload::from(vec![7u8; 100])).await.unwrap();
            }
            assert_eq!(scope_requests(root), StorageRequests::default());
            assert_eq!(s.list(Some(&Path::from("d"))).try_collect::<Vec<_>>().await.unwrap().len(), 3);
            s.head(&Path::from("d/0")).await.unwrap();
            s.get_range(&Path::from("d/1"), 10..60).await.unwrap();
            // ranges 10 bytes apart share one request
            let parts = s.get_ranges(&Path::from("d/2"), &[0..10, 20..30, 40..50]).await.unwrap();
            assert_eq!(parts.iter().map(|p| p.len()).collect::<Vec<_>>(), vec![10, 10, 10]);
        });
        assert_eq!(scope_requests(root), StorageRequests { list: 1, head: 1, get: 2, bytes: 50 + 50 });
        assert!(storage_requests().count() >= 4);
    }

    #[test]
    fn a_never_polled_listing_costs_nothing_and_big_ones_cost_pages() {
        let (root, s) = ("memory://counting-pages", store("memory://counting-pages"));
        block_on(async {
            for i in 0..2500 {
                s.put(&Path::from(format!("p/{i:05}")), PutPayload::from_static(b"x")).await.unwrap();
            }
            drop(s.list(None));
            assert_eq!(scope_requests(root).list, 0);
            assert_eq!(s.list(None).try_collect::<Vec<_>>().await.unwrap().len(), 2500);
        });
        assert_eq!(scope_requests(root).list, 3);
    }

    #[test]
    fn a_listing_still_pending_is_one_request() {
        let root = "memory://counting-pending";
        let mut polls = 0;
        // the page arrives on the third poll, as from a slow server
        let inner = futures::stream::poll_fn(move |cx| {
            polls += 1;
            if polls < 3 {
                cx.waker().wake_by_ref();
                return Poll::Pending;
            }
            Poll::Ready(None)
        });
        let list = CountedList { inner: Box::pin(inner), meter: Meter::for_root(root), started: false, items: 0 };
        block_on(async { assert!(list.try_collect::<Vec<_>>().await.unwrap().is_empty()) });
        assert_eq!(scope_requests(root).list, 1);
    }
}
