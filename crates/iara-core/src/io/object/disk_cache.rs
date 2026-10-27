//! A disk cache of the byte ranges read from object stores: dashboards and
//! notebooks read the same Parquet ranges again and again, and every
//! request to a store is billed and slow. Off unless `IARA_DISK_CACHE_DIR`
//! is set; `IARA_DISK_CACHE_MB` bounds what it keeps.
//!
//! Layout: one folder per object version, named by a hash of
//! `url \n size \n stamp` (the stamp is the listing's entity tag or
//! modification time, so a rewritten object never reads old bytes). It holds
//! the `key` file (that string, compared on every read: a hash collision or
//! a damaged folder is a miss) and data files named `<start>-<end>` (byte
//! offsets, end exclusive). Object keys never become file names.
//!
//! The cache never fails a query: any I/O error on a read is a miss, and
//! writes happen on a background thread. A write is dropped when the queue
//! is full. Processes may share the folder: data files appear by rename,
//! and every step tolerates files that another process removed meanwhile.

use std::collections::hash_map::DefaultHasher;
use std::ffi::OsStr;
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::hash::{Hash, Hasher};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::ops::Range;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, SyncSender};
use std::sync::{Arc, OnceLock};
use std::time::SystemTime;

use bytes::Bytes;

use super::config;
use super::file::ObjectFile;

const KEY_FILE: &str = "key";
/// Writes waiting for the background thread (more are dropped).
const QUEUE_LEN: usize = 64;
/// Ranges larger than this are not cached.
const MAX_RANGE: u64 = 256 << 20;
/// Bytes waiting in the queue at most: they stay in memory until written.
const MAX_QUEUED: u64 = 512 << 20;

/// What identifies the bytes of `file`: where it is, and which version.
pub fn key(file: &ObjectFile) -> String {
    format!("{}\n{}\n{}", file.url, file.size, file.stamp)
}

/// The cache of this process, built from the settings on first use; `None`
/// when `IARA_DISK_CACHE_DIR` is not set.
pub fn global() -> Option<&'static DiskCache> {
    static CACHE: OnceLock<Option<DiskCache>> = OnceLock::new();
    CACHE.get_or_init(|| config::disk_cache_dir().map(|dir| DiskCache::new(dir, config::disk_cache_bytes()))).as_ref()
}

enum Msg {
    Put { key: String, start: u64, bytes: Bytes },
    Flush(mpsc::Sender<()>),
}

pub struct DiskCache {
    dir: PathBuf,
    budget: u64,
    tx: SyncSender<Msg>,
    /// bytes of the writes in the queue
    queued: Arc<AtomicU64>,
}

impl DiskCache {
    /// A cache in `dir` (made when first written) that keeps about `budget` bytes.
    pub fn new(dir: PathBuf, budget: u64) -> Self {
        let (tx, rx) = mpsc::sync_channel(QUEUE_LEN);
        let queued = Arc::new(AtomicU64::new(0));
        let mut writer = Writer { dir: dir.clone(), budget, total: 0, queued: queued.clone() };
        // without its thread every write is dropped: the cache stays harmless
        let _ = std::thread::Builder::new().name("iara-disk-cache".into()).spawn(move || writer.run(rx));
        Self { dir, budget, tx, queued }
    }

    /// The bytes of `range` of the object version `key`, when one cached range holds them.
    pub fn get(&self, key: &str, range: &Range<u64>) -> Option<Bytes> {
        if range.start >= range.end {
            return None;
        }
        let dir = version_dir(&self.dir, key);
        if fs::read(dir.join(KEY_FILE)).ok()?.as_slice() != key.as_bytes() {
            return None;
        }
        fs::read_dir(&dir).ok()?.flatten().find_map(|e| {
            let (start, end) = parse_name(&e.file_name())?;
            (start <= range.start && range.end <= end).then(|| read_slice(&e.path(), start, end, range)).flatten()
        })
    }

    /// [`get`](Self::get) for several ranges, on a thread of the blocking pool
    /// (it reads files, which the I/O threads should not wait for).
    pub async fn get_all(&'static self, key: String, ranges: Vec<Range<u64>>) -> Vec<Option<Bytes>> {
        let n = ranges.len();
        let hits = tokio::task::spawn_blocking(move || ranges.iter().map(|r| self.get(&key, r)).collect()).await;
        hits.unwrap_or_else(|_| vec![None; n])
    }

    /// Keep `bytes`, the bytes of `range` of the object version `key`. Never
    /// waits: when the writer is behind, the entry is dropped.
    pub fn put(&self, key: &str, range: Range<u64>, bytes: Bytes) {
        let len = bytes.len() as u64;
        if len == 0 || len > MAX_RANGE.min(self.budget) || range.end.checked_sub(range.start) != Some(len) {
            return;
        }
        if self.queued.fetch_add(len, Ordering::AcqRel) + len > MAX_QUEUED {
            self.queued.fetch_sub(len, Ordering::AcqRel);
            return;
        }
        if self.tx.try_send(Msg::Put { key: key.to_string(), start: range.start, bytes }).is_err() {
            self.queued.fetch_sub(len, Ordering::AcqRel);
        }
    }

    /// Waits until the writer is done with everything queued so far (tests).
    pub fn flush(&self) {
        let (ack, done) = mpsc::channel();
        if self.tx.send(Msg::Flush(ack)).is_ok() {
            let _ = done.recv();
        }
    }
}

/// `range` out of the data file `start..end`; a file whose length is not
/// that (a damaged one) is removed.
fn read_slice(path: &Path, start: u64, end: u64, range: &Range<u64>) -> Option<Bytes> {
    let mut file = File::open(path).ok()?;
    if file.metadata().ok()?.len() != end - start {
        drop(file);
        let _ = fs::remove_file(path);
        return None;
    }
    file.seek(SeekFrom::Start(range.start - start)).ok()?;
    let mut buf = vec![0u8; (range.end - range.start) as usize];
    file.read_exact(&mut buf).ok()?;
    drop(file);
    // the eviction removes the least recently used first
    if let Ok(f) = OpenOptions::new().write(true).open(path) {
        let _ = f.set_modified(SystemTime::now());
    }
    Some(Bytes::from(buf))
}

/// The folder of an object version: 128 bits of hash of its key.
fn version_dir(root: &Path, key: &str) -> PathBuf {
    let hash = |salt: u8| {
        let mut h = DefaultHasher::new();
        salt.hash(&mut h);
        key.hash(&mut h);
        h.finish()
    };
    root.join(format!("{:016x}{:016x}", hash(1), hash(2)))
}

fn is_version_dir(name: &OsStr) -> bool {
    name.to_str().is_some_and(|n| n.len() == 32 && n.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// `(start, end)` of a data file name (`<start>-<end>`).
fn parse_name(name: &OsStr) -> Option<(u64, u64)> {
    let (start, end) = name.to_str()?.split_once('-')?;
    let (start, end) = (start.parse().ok()?, end.parse().ok()?);
    (start < end).then_some((start, end))
}

struct Cached {
    path: PathBuf,
    size: u64,
    modified: SystemTime,
}

fn version_dirs(root: &Path) -> impl Iterator<Item = PathBuf> {
    fs::read_dir(root).into_iter().flatten().flatten().filter(|e| is_version_dir(&e.file_name())).map(|e| e.path())
}

/// The files of a version folder other than its `key` (data files, and the
/// temp files of writers).
fn data_files(dir: &Path) -> Vec<Cached> {
    let files = fs::read_dir(dir).into_iter().flatten().flatten().filter(|e| e.file_name() != KEY_FILE);
    files
        .filter_map(|e| {
            let meta = e.metadata().ok().filter(|m| m.is_file())?;
            Some(Cached { path: e.path(), size: meta.len(), modified: meta.modified().ok()? })
        })
        .collect()
}

fn create_dir(path: &Path) -> io::Result<()> {
    let mut b = DirBuilder::new();
    b.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut b, 0o700);
    b.create(path)
}

fn create_file(path: &Path) -> io::Result<File> {
    let mut o = OpenOptions::new();
    o.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut o, 0o600);
    o.open(path)
}

/// `bytes` as `dir/name`, whole or not there at all: written to a temp file, then renamed.
fn write_atomic(dir: &Path, name: &str, bytes: &[u8]) -> io::Result<()> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let tmp = dir.join(format!(".tmp-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    let done = create_file(&tmp).and_then(|mut f| f.write_all(bytes)).and_then(|()| fs::rename(&tmp, dir.join(name)));
    if done.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    done
}

/// The background thread: the only one that writes and evicts.
struct Writer {
    dir: PathBuf,
    budget: u64,
    /// bytes in the folder, as far as this process knows (other processes
    /// add and remove too: every eviction counts them again)
    total: u64,
    queued: Arc<AtomicU64>,
}

impl Writer {
    fn run(&mut self, rx: Receiver<Msg>) {
        self.total = version_dirs(&self.dir).flat_map(|d| data_files(&d)).map(|f| f.size).sum();
        for msg in rx {
            match msg {
                Msg::Put { key, start, bytes } => {
                    // a failed write only costs the entry
                    if self.write(&key, start, &bytes).is_ok() && self.total > self.budget {
                        self.evict();
                    }
                    self.queued.fetch_sub(bytes.len() as u64, Ordering::AcqRel);
                }
                Msg::Flush(ack) => {
                    let _ = ack.send(());
                }
            }
        }
    }

    fn write(&mut self, key: &str, start: u64, bytes: &[u8]) -> io::Result<()> {
        let dir = version_dir(&self.dir, key);
        let name = format!("{start}-{}", start + bytes.len() as u64);
        if dir.join(&name).exists() {
            return Ok(());
        }
        match fs::read(dir.join(KEY_FILE)) {
            Ok(k) if k == key.as_bytes() => {}
            other => {
                // not the folder of this version (or not made yet): start over
                if other.is_ok() {
                    fs::remove_dir_all(&dir)?;
                }
                create_dir(&dir)?;
                write_atomic(&dir, KEY_FILE, key.as_bytes())?;
            }
        }
        write_atomic(&dir, &name, bytes)?;
        self.total += bytes.len() as u64;
        Ok(())
    }

    /// Over the budget: remove the least recently used files down to 90% of
    /// it, then the folders left without data.
    fn evict(&mut self) {
        let mut files: Vec<Cached> = version_dirs(&self.dir).flat_map(|d| data_files(&d)).collect();
        files.sort_by_key(|f| f.modified);
        let mut total: u64 = files.iter().map(|f| f.size).sum();
        let goal = self.budget / 10 * 9;
        for f in &files {
            if total <= goal {
                break;
            }
            match fs::remove_file(&f.path) {
                Ok(()) => total -= f.size,
                // another process removed it first
                Err(e) if e.kind() == io::ErrorKind::NotFound => total -= f.size,
                Err(_) => {}
            }
        }
        for dir in version_dirs(&self.dir).filter(|d| data_files(d).is_empty()) {
            let _ = fs::remove_file(dir.join(KEY_FILE));
            let _ = fs::remove_dir(&dir);
        }
        self.total = total;
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::*;

    /// A folder removed when dropped.
    struct Tmp(PathBuf);

    impl Tmp {
        fn new() -> Self {
            static N: AtomicU64 = AtomicU64::new(0);
            let p = std::env::temp_dir().join(format!("iara-disk-cache-{}-{}", std::process::id(), N.fetch_add(1, Ordering::Relaxed)));
            let _ = fs::remove_dir_all(&p);
            Self(p)
        }
    }

    impl Drop for Tmp {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn data(n: usize) -> Bytes {
        Bytes::from((0..n).map(|i| (i % 251) as u8).collect::<Vec<u8>>())
    }

    /// Cache `n` bytes at `start` and wait for the write.
    fn put(c: &DiskCache, key: &str, start: u64, n: usize) {
        c.put(key, start..start + n as u64, data(n));
        c.flush();
    }

    fn age(path: &Path, secs: u64) {
        let f = OpenOptions::new().write(true).open(path).unwrap();
        f.set_modified(SystemTime::now() - Duration::from_secs(secs)).unwrap();
    }

    fn data_file(c: &DiskCache, key: &str, name: &str) -> PathBuf {
        version_dir(&c.dir, key).join(name)
    }

    #[test]
    fn put_then_get_and_containment() {
        let tmp = Tmp::new();
        let c = DiskCache::new(tmp.0.clone(), 1 << 20);
        let all = data(1000);
        put(&c, "k", 0, 1000);
        assert_eq!(c.get("k", &(0..1000)).unwrap(), all);
        assert_eq!(c.get("k", &(100..200)).unwrap().as_ref(), &all[100..200]);
        assert!(c.get("k", &(0..1001)).is_none() && c.get("k", &(900..1100)).is_none());
        assert!(c.get("k", &(5..5)).is_none(), "an empty range is never served");
        assert!(c.get("other", &(0..10)).is_none());
        // empty, mismatching and oversized entries are not kept
        c.put("k2", 0..0, Bytes::new());
        c.put("k2", 0..10, data(5));
        c.flush();
        assert!(!version_dir(&c.dir, "k2").exists());
    }

    #[test]
    fn another_version_of_the_object_misses() {
        let tmp = Tmp::new();
        let c = DiskCache::new(tmp.0.clone(), 1 << 20);
        put(&c, "s3://b/o\n100\netag-1", 0, 100);
        assert!(c.get("s3://b/o\n100\netag-1", &(0..100)).is_some());
        assert!(c.get("s3://b/o\n100\netag-2", &(0..100)).is_none());
        assert!(c.get("s3://b/o\n101\netag-1", &(0..100)).is_none());
    }

    #[test]
    fn a_tampered_key_file_misses_and_the_next_write_starts_over() {
        let tmp = Tmp::new();
        let c = DiskCache::new(tmp.0.clone(), 1 << 20);
        put(&c, "k", 0, 100);
        fs::write(version_dir(&c.dir, "k").join(KEY_FILE), b"somebody else's object").unwrap();
        assert!(c.get("k", &(0..100)).is_none());
        put(&c, "k", 200, 50);
        assert!(c.get("k", &(200..250)).is_some());
        assert!(c.get("k", &(0..100)).is_none(), "what the foreign key vouched for is gone");
    }

    #[test]
    fn a_truncated_data_file_misses_and_is_removed() {
        let tmp = Tmp::new();
        let c = DiskCache::new(tmp.0.clone(), 1 << 20);
        put(&c, "k", 0, 100);
        let file = data_file(&c, "k", "0-100");
        OpenOptions::new().write(true).open(&file).unwrap().set_len(10).unwrap();
        assert!(c.get("k", &(0..100)).is_none());
        assert!(!file.exists());
    }

    #[test]
    fn a_hit_refreshes_the_modification_time() {
        let tmp = Tmp::new();
        let c = DiskCache::new(tmp.0.clone(), 1 << 20);
        put(&c, "k", 0, 100);
        let file = data_file(&c, "k", "0-100");
        age(&file, 3600);
        c.get("k", &(0..10)).unwrap();
        let idle = SystemTime::now().duration_since(fs::metadata(&file).unwrap().modified().unwrap()).unwrap();
        assert!(idle < Duration::from_secs(60), "{idle:?}");
    }

    #[test]
    fn eviction_removes_the_oldest_files_and_empty_folders() {
        let tmp = Tmp::new();
        let c = DiskCache::new(tmp.0.clone(), 1000);
        put(&c, "a", 0, 400);
        put(&c, "b", 0, 400);
        age(&data_file(&c, "a", "0-400"), 300);
        age(&data_file(&c, "b", "0-400"), 200);
        // 1200 bytes: over the budget, down to 900 by removing `a`
        put(&c, "c", 0, 400);
        assert!(c.get("a", &(0..400)).is_none());
        assert!(!version_dir(&c.dir, "a").exists(), "its folder went with its last file");
        assert!(c.get("b", &(0..400)).is_some() && c.get("c", &(0..400)).is_some());
        age(&data_file(&c, "b", "0-400"), 200);
        age(&data_file(&c, "c", "0-400"), 100);
        put(&c, "d", 0, 400);
        assert!(c.get("b", &(0..400)).is_none());
        assert!(c.get("c", &(0..400)).is_some() && c.get("d", &(0..400)).is_some());
        let on_disk: u64 = version_dirs(&c.dir).flat_map(|d| data_files(&d)).map(|f| f.size).sum();
        assert!(on_disk <= 1000, "{on_disk}");
    }

    #[test]
    fn a_new_cache_counts_what_the_folder_already_holds() {
        let tmp = Tmp::new();
        let first = DiskCache::new(tmp.0.clone(), 1000);
        put(&first, "old", 0, 600);
        age(&data_file(&first, "old", "0-600"), 300);
        drop(first);
        let second = DiskCache::new(tmp.0.clone(), 1000);
        put(&second, "new", 0, 600);
        assert!(second.get("old", &(0..600)).is_none());
        assert!(second.get("new", &(0..600)).is_some());
    }

    #[test]
    fn names_that_are_not_ranges_are_ignored() {
        for bad in ["key", ".tmp-1-2", "5-5", "9-3", "a-b", "7", "-4-9"] {
            assert_eq!(parse_name(OsStr::new(bad)), None, "{bad}");
        }
        assert_eq!(parse_name(OsStr::new("0-100")), Some((0, 100)));
    }
}
