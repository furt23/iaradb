//! The disk cache of ranged reads: what was read once is not requested again.
//! The setting is read once per process, so this file holds one test only.
//!
//! There is no fake S3 server in the repo: the object is an `s3://` one
//! backed by an in-memory store (wrapped to count requests, as the registry
//! wraps every store), built directly, since the registry would only serve
//! `memory://` that way and those objects are not cached.

use std::sync::Arc;

use bytes::Bytes;
use iara_core::io::location::ObjectUrl;
use iara_core::io::object::counting::CountingStore;
use iara_core::io::object::{ObjectFile, StorageRequests, block_on, disk_cache, scope_requests};
use object_store::memory::InMemory;
use object_store::path::Path;
use object_store::{ObjectStoreExt, PutPayload};

const ROOT: &str = "s3://disk-cache-bucket";

fn object(bytes: &Bytes, stamp: &str) -> ObjectFile {
    let mem = Arc::new(InMemory::new());
    let path = Path::from("t/f.bin");
    block_on(mem.put(&path, PutPayload::from(bytes.clone()))).unwrap();
    let url = ObjectUrl { scheme: "s3".into(), bucket: "disk-cache-bucket".into(), key: "t/f.bin".into() };
    ObjectFile { url, path, size: bytes.len() as u64, store: CountingStore::wrap(mem, ROOT), store_id: 1, stamp: stamp.into(), content: None }
}

fn gets_since(before: StorageRequests) -> u64 {
    scope_requests(ROOT).since(before).get
}

#[test]
fn a_range_read_twice_is_requested_once() {
    let dir = std::env::temp_dir().join(format!("iara-disk-cache-it-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    // SAFETY: set before anything of this binary reads the environment (one test, no threads yet)
    unsafe {
        std::env::set_var("IARA_DISK_CACHE_DIR", &dir);
        std::env::set_var("IARA_DISK_CACHE_MB", "16");
    }
    let cache = disk_cache::global().expect("the cache is on");
    let bytes = Bytes::from((0..100_000u32).map(|i| (i % 253) as u8).collect::<Vec<u8>>());
    let file = object(&bytes, "etag-1");
    let before = scope_requests(ROOT);

    assert_eq!(file.read_range(1000..2000, None).unwrap(), bytes.slice(1000..2000));
    assert_eq!(gets_since(before), 1);
    cache.flush();
    // the same range, and one inside it, come from disk
    assert_eq!(file.read_range(1000..2000, None).unwrap(), bytes.slice(1000..2000));
    assert_eq!(file.read_range(1200..1300, None).unwrap(), bytes.slice(1200..1300));
    assert_eq!(gets_since(before), 1, "cached ranges made requests");

    // only what is missing is requested, and the answer keeps the order asked
    let got = file.read_ranges(&[50_000..50_100, 1500..1600, 60_000..60_100], None).unwrap();
    let expected: Vec<Bytes> = [50_000..50_100, 1500..1600, 60_000..60_100].into_iter().map(|r| bytes.slice(r)).collect();
    assert_eq!(got, expected);
    // (the two missing ranges are close: one coalesced request, on top of the first)
    assert_eq!(gets_since(before), 2);
    cache.flush();
    let before = scope_requests(ROOT);
    assert_eq!(file.read_ranges(&[50_000..50_100, 1500..1600, 60_000..60_100], None).unwrap(), expected);
    assert_eq!(gets_since(before), 0);

    // another version of the object (a new tag) is not served from the old bytes
    let rewritten = Bytes::from(vec![7u8; 100_000]);
    let newer = object(&rewritten, "etag-2");
    assert_eq!(newer.read_range(1000..2000, None).unwrap(), rewritten.slice(1000..2000));
    assert_eq!(gets_since(before), 1);
    cache.flush();

    // a second process would find the same bytes: a fresh view of the folder holds them
    assert_eq!(disk_cache::DiskCache::new(dir.clone(), 16 << 20).get(&disk_cache::key(&file), &(1000..2000)).unwrap(), bytes.slice(1000..2000));
    let _ = std::fs::remove_dir_all(&dir);
}
