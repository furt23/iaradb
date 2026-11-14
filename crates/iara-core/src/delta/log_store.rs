//! Access to `<table>/_delta_log/`, on local disk or in an object store.
//!
//! File names are relative to the log directory. Listings go to the store
//! every time (never through the shared listing cache: a commit by another
//! writer must be seen at once); after this process writes or deletes, the
//! cached listings of the table's data files are dropped.

use std::io::Write;
use std::path::PathBuf;

use bytes::Bytes;
use futures::TryStreamExt;
use object_store::{ObjectStore, ObjectStoreExt};

use super::names::{LAST_CHECKPOINT, LOG_DIR, LastCheckpoint, LogFileKind, parse_file_name};
use super::util::new_uuid;
use crate::error::{Result, WhError};
use crate::io::location::{Location, ObjectUrl};
use crate::io::object::error::storage_err;
use crate::io::object::list_cache;
use crate::io::object::put_if_absent::put_if_absent;
use crate::io::object::{block_on, object_path, registry};
use crate::io::options::StorageOptions;

/// One file of the log directory that is part of the log.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LogFile {
    /// relative to `_delta_log/`
    pub name: String,
    /// the version it belongs to (0 for `_last_checkpoint`)
    pub version: u64,
    pub kind: LogFileKind,
    pub size: u64,
    /// modification time, milliseconds since the epoch
    pub modified: Option<i64>,
}

impl LogFile {
    fn new(name: &str, size: u64, modified: Option<i64>) -> Option<LogFile> {
        let (version, kind) = parse_file_name(name)?;
        Some(LogFile { name: name.to_string(), version, kind, size, modified })
    }

    fn order(&self) -> (u64, u8, u32) {
        match self.kind {
            LogFileKind::LastCheckpoint => (0, 0, 0),
            LogFileKind::Checkpoint => (self.version, 1, 0),
            LogFileKind::MultiPartCheckpoint { part, .. } => (self.version, 1, part),
            LogFileKind::Commit => (self.version, 2, 0),
        }
    }
}

#[derive(Debug, Clone)]
enum Backend {
    Local { table: PathBuf },
    Object { table: ObjectUrl, options: StorageOptions },
}

/// The transaction log of one table.
#[derive(Debug, Clone)]
pub struct LogStore {
    backend: Backend,
    given: String,
}

fn not_found(what: &str) -> WhError {
    WhError::Storage(format!("{what}: not found"))
}

fn check_name(name: &str) -> Result<()> {
    if name.is_empty() || name.contains(['/', '\\']) || name == ".." || name == "." {
        return Err(WhError::Plan(format!("invalid Delta log file name '{name}'")));
    }
    Ok(())
}

impl LogStore {
    /// The log of the table at `table`: a local directory or a URL such as
    /// `s3://bucket/path/to/table`.
    pub fn open(table: &str, options: &StorageOptions) -> Result<LogStore> {
        let backend = match Location::parse(table)? {
            Location::Local(table) => Backend::Local { table },
            Location::Object(table) => Backend::Object { table, options: options.clone() },
        };
        Ok(LogStore { backend, given: table.to_string() })
    }

    /// The table root, as given.
    pub fn table(&self) -> String {
        self.given.clone()
    }

    fn local_dir(table: &std::path::Path) -> PathBuf {
        table.join(LOG_DIR)
    }

    fn log_url(table: &ObjectUrl, name: &str) -> ObjectUrl {
        let base = table.key.trim_end_matches('/');
        let key = if base.is_empty() { format!("{LOG_DIR}/{name}") } else { format!("{base}/{LOG_DIR}/{name}") };
        table.with_key(&key)
    }

    fn object_store(table: &ObjectUrl, options: &StorageOptions) -> Result<std::sync::Arc<dyn ObjectStore>> {
        registry::store(table, options)
    }

    /// The log files of version `version` and later, in log order
    /// (`_last_checkpoint`, when there is one, comes first; at a version
    /// checkpoint parts precede the commit). Empty when the table has no log.
    pub fn list_from(&self, version: u64) -> Result<Vec<LogFile>> {
        let mut files = match &self.backend {
            Backend::Local { table } => list_local(&Self::local_dir(table))?,
            Backend::Object { table, options } => {
                let store = Self::object_store(table, options)?;
                let dir = Self::log_url(table, "");
                let prefix_key = dir.key.trim_end_matches('/').to_string();
                let prefix = object_path(&prefix_key);
                let offset = object_path(&format!("{prefix_key}/{version:020}"));
                let what = table.to_string();
                let metas: Vec<_> = block_on(store.list_with_offset(Some(&prefix), &offset).try_collect::<Vec<_>>()).map_err(|e| storage_err(e, &what))?;
                let lead = format!("{prefix_key}/");
                metas
                    .iter()
                    .filter_map(|m| {
                        let name = m.location.as_ref().strip_prefix(&lead)?;
                        (!name.contains('/')).then(|| LogFile::new(name, m.size, Some(m.last_modified.timestamp_millis()))).flatten()
                    })
                    .collect()
            }
        };
        files.retain(|f| f.kind == LogFileKind::LastCheckpoint || f.version >= version);
        files.sort_by_key(LogFile::order);
        Ok(files)
    }

    pub fn read(&self, name: &str) -> Result<Bytes> {
        check_name(name)?;
        match &self.backend {
            Backend::Local { table } => {
                let path = Self::local_dir(table).join(name);
                std::fs::read(&path).map(Bytes::from).map_err(|e| match e.kind() {
                    std::io::ErrorKind::NotFound => not_found(&path.display().to_string()),
                    _ => e.into(),
                })
            }
            Backend::Object { table, options } => {
                let url = Self::log_url(table, name);
                let store = Self::object_store(table, options)?;
                let path = object_path(&url.key);
                block_on(async { store.get(&path).await?.bytes().await }).map_err(|e| storage_err(e, &url.to_string()))
            }
        }
    }

    /// The `_last_checkpoint` pointer; `None` when absent or unreadable
    /// (readers then find the checkpoint by listing).
    pub fn read_last_checkpoint(&self) -> Result<Option<LastCheckpoint>> {
        match self.read(LAST_CHECKPOINT) {
            Ok(bytes) => Ok(LastCheckpoint::parse(&bytes)),
            Err(WhError::Storage(m)) if m.ends_with("not found") => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Create the log file `name` with `bytes` unless it exists: `Ok(false)` when it does.
    /// Locally the content is written to a temporary file and hard-linked to
    /// the final name, so readers never see a partial commit; where hard links
    /// are unavailable the file is created exclusively and written in place.
    /// Object stores use a conditional put (see the `single_writer` storage option).
    pub fn put_if_absent(&self, name: &str, bytes: impl Into<Bytes>) -> Result<bool> {
        check_name(name)?;
        let bytes: Bytes = bytes.into();
        match &self.backend {
            Backend::Local { table } => {
                let dir = Self::local_dir(table);
                std::fs::create_dir_all(&dir)?;
                create_exclusive(&dir, name, &bytes)
            }
            Backend::Object { table, options } => put_if_absent(&Self::log_url(table, name), bytes, options),
        }
    }

    /// Write `name`, replacing any content (for `_last_checkpoint`).
    pub fn put(&self, name: &str, bytes: impl Into<Bytes>) -> Result<()> {
        check_name(name)?;
        let bytes: Bytes = bytes.into();
        match &self.backend {
            Backend::Local { table } => {
                let dir = Self::local_dir(table);
                std::fs::create_dir_all(&dir)?;
                let tmp = dir.join(format!(".tmp-{}", new_uuid()));
                write_synced(&tmp, &bytes)?;
                let renamed = std::fs::rename(&tmp, dir.join(name));
                if renamed.is_err() {
                    let _ = std::fs::remove_file(&tmp);
                }
                Ok(renamed?)
            }
            Backend::Object { table, options } => {
                let url = Self::log_url(table, name);
                let store = Self::object_store(table, options)?;
                let path = object_path(&url.key);
                let written = block_on(store.put(&path, bytes.into()));
                list_cache::invalidate(&table.root(), &table.key);
                written.map(|_| ()).map_err(|e| storage_err(e, &url.to_string()))
            }
        }
    }

    /// Delete the log file `name` (no error when it is already gone).
    pub fn delete(&self, name: &str) -> Result<()> {
        check_name(name)?;
        match &self.backend {
            Backend::Local { table } => match std::fs::remove_file(Self::local_dir(table).join(name)) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
                _ => Ok(()),
            },
            Backend::Object { table, options } => {
                let url = Self::log_url(table, name);
                let store = Self::object_store(table, options)?;
                let deleted = block_on(store.delete(&object_path(&url.key)));
                list_cache::invalidate(&table.root(), &table.key);
                match deleted {
                    Err(object_store::Error::NotFound { .. }) => Ok(()),
                    other => other.map_err(|e| storage_err(e, &url.to_string())),
                }
            }
        }
    }

    /// Drop the cached listings of the table's files (after the data files or
    /// the log changed); a no-op for local tables.
    pub fn invalidate_listings(&self) {
        if let Backend::Object { table, .. } = &self.backend {
            list_cache::invalidate(&table.root(), &table.key);
        }
    }
}

fn list_local(dir: &std::path::Path) -> Result<Vec<LogFile>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    let mut files = vec![];
    for entry in entries {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
        if parse_file_name(&name).is_none() {
            continue;
        }
        let meta = entry.metadata()?;
        if !meta.is_file() {
            continue;
        }
        let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64);
        files.extend(LogFile::new(&name, meta.len(), modified));
    }
    Ok(files)
}

fn write_synced(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut f = std::fs::OpenOptions::new().write(true).create_new(true).open(path)?;
    f.write_all(bytes)?;
    f.sync_all()
}

fn create_exclusive(dir: &std::path::Path, name: &str, bytes: &[u8]) -> Result<bool> {
    let target = dir.join(name);
    let tmp = dir.join(format!(".tmp-{}", new_uuid()));
    write_synced(&tmp, bytes)?;
    let linked = std::fs::hard_link(&tmp, &target);
    let _ = std::fs::remove_file(&tmp);
    match linked {
        Ok(()) => Ok(true),
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(_) => {
            // no hard links here (FAT, some network shares): exclusive create is still atomic
            match write_synced(&target, bytes) {
                Ok(()) => Ok(true),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
                Err(e) => {
                    let _ = std::fs::remove_file(&target);
                    Err(e.into())
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::delta::names::{checkpoint_file_name, commit_file_name, multipart_checkpoint_file_name};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> TempDir {
            let p = std::env::temp_dir().join(format!("iara-delta-{}", new_uuid()));
            std::fs::create_dir_all(&p).unwrap();
            TempDir(p)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn names(files: &[LogFile]) -> Vec<String> {
        files.iter().map(|f| f.name.clone()).collect()
    }

    #[test]
    fn local_log_lists_in_log_order() {
        let tmp = TempDir::new();
        let log = LogStore::open(tmp.0.to_str().unwrap(), &StorageOptions::new()).unwrap();
        assert!(log.list_from(0).unwrap().is_empty(), "no log directory yet");
        for v in [2, 0, 1] {
            assert!(log.put_if_absent(&commit_file_name(v), format!("v{v}")).unwrap());
        }
        log.put_if_absent(&checkpoint_file_name(1), "cp").unwrap();
        log.put_if_absent(&multipart_checkpoint_file_name(2, 1, 2), "p1").unwrap();
        log.put("_last_checkpoint", "{\"version\":1,\"size\":3}").unwrap();
        std::fs::write(tmp.0.join("_delta_log").join("junk.txt"), "x").unwrap();
        let all = log.list_from(0).unwrap();
        assert_eq!(
            names(&all),
            vec![
                "_last_checkpoint".to_string(),
                commit_file_name(0),
                checkpoint_file_name(1),
                commit_file_name(1),
                multipart_checkpoint_file_name(2, 1, 2),
                commit_file_name(2),
            ]
        );
        assert_eq!(names(&log.list_from(2).unwrap()).len(), 3);
        assert_eq!(&log.read(&commit_file_name(1)).unwrap()[..], b"v1");
        assert_eq!(log.read_last_checkpoint().unwrap().unwrap().version, 1);
        assert!(log.read(&commit_file_name(9)).is_err());
        log.delete(&commit_file_name(0)).unwrap();
        log.delete(&commit_file_name(0)).unwrap();
        assert!(log.read("../x").is_err());
        // no temporary files are left behind
        assert!(std::fs::read_dir(tmp.0.join("_delta_log")).unwrap().all(|e| !e.unwrap().file_name().to_str().unwrap().starts_with(".tmp")));
    }

    #[test]
    fn local_commit_race_has_one_winner() {
        let tmp = TempDir::new();
        let log = LogStore::open(tmp.0.to_str().unwrap(), &StorageOptions::new()).unwrap();
        let wins = AtomicUsize::new(0);
        std::thread::scope(|s| {
            for i in 0..8 {
                let (log, wins) = (&log, &wins);
                s.spawn(move || {
                    if log.put_if_absent(&commit_file_name(5), format!("writer {i}")).unwrap() {
                        wins.fetch_add(1, Ordering::SeqCst);
                    }
                });
            }
        });
        assert_eq!(wins.load(Ordering::SeqCst), 1);
        let content = String::from_utf8(log.read(&commit_file_name(5)).unwrap().to_vec()).unwrap();
        assert!(content.starts_with("writer "));
    }

    #[test]
    fn object_store_log_lists_commits_and_races() {
        let log = LogStore::open("memory://delta-log-store/tables/t1", &StorageOptions::new()).unwrap();
        assert!(log.list_from(0).unwrap().is_empty());
        for v in 0..4 {
            assert!(log.put_if_absent(&commit_file_name(v), format!("v{v}")).unwrap());
        }
        assert!(!log.put_if_absent(&commit_file_name(3), "again").unwrap());
        log.put_if_absent(&checkpoint_file_name(2), "cp").unwrap();
        log.put("_last_checkpoint", LastCheckpoint { version: 2, size: 5, parts: None, size_in_bytes: None, num_of_add_files: None }.to_bytes()).unwrap();
        // a sibling table must not show up
        let other = LogStore::open("memory://delta-log-store/tables/t10", &StorageOptions::new()).unwrap();
        other.put_if_absent(&commit_file_name(7), "x").unwrap();
        let from2 = log.list_from(2).unwrap();
        assert_eq!(names(&from2), vec!["_last_checkpoint".to_string(), checkpoint_file_name(2), commit_file_name(2), commit_file_name(3)]);
        assert_eq!(&log.read(&commit_file_name(3)).unwrap()[..], b"v3");
        assert_eq!(log.read_last_checkpoint().unwrap().unwrap().version, 2);
        log.delete(&commit_file_name(0)).unwrap();
        assert_eq!(log.list_from(0).unwrap().len(), 5);
        let wins = AtomicUsize::new(0);
        std::thread::scope(|s| {
            for _ in 0..8 {
                s.spawn(|| {
                    if log.put_if_absent(&commit_file_name(10), "w").unwrap() {
                        wins.fetch_add(1, Ordering::SeqCst);
                    }
                });
            }
        });
        assert_eq!(wins.load(Ordering::SeqCst), 1);
    }
}
