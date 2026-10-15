//! `RESTORE`: one new commit that makes the table equal to an older version.
//! Files in use now but not then are removed; files in use then but not now
//! are added back (they must still exist: `VACUUM` may have deleted them);
//! the schema and partitioning of that version come back too. The history is
//! kept, the restore is a version like any other.

use std::collections::HashMap;

use object_store::ObjectStoreExt;

use super::{check_not_append_only, check_writable, now_ms};
use crate::delta::actions::{Action, Add, Metadata, Remove};
use crate::delta::log_store::LogStore;
use crate::delta::provider::VersionSpec;
use crate::delta::snapshot::Snapshot;
use crate::delta::txn::Transaction;
use crate::error::{Result, WhError};
use crate::io::location::{Location, url_scheme};
use crate::io::object::error::storage_err;
use crate::io::object::{block_on, object_path, registry};
use crate::io::options::StorageOptions;

/// What a `RESTORE` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RestoreSummary {
    /// the table's version after it (the existing one when it already was as the target)
    pub version: u64,
    /// the version the table was restored to
    pub restored_version: u64,
    pub files_removed: usize,
    pub files_restored: usize,
    pub bytes_removed: u64,
    pub bytes_restored: u64,
    /// the table already equalled the target: no commit was made
    pub skipped: bool,
}

/// Restore the table at `location` to a version or to its state at a time.
pub fn restore(location: &str, storage: &StorageOptions, to: VersionSpec) -> Result<RestoreSummary> {
    let log = LogStore::open(location, storage)?;
    let current = Snapshot::load(&log, None)?;
    let target = match to {
        VersionSpec::Version(v) => Snapshot::load(&log, Some(v))?,
        VersionSpec::Timestamp(ts) => Snapshot::at_timestamp(&log, ts)?,
    };
    check_writable(&current)?;
    if target.version > current.version {
        return Err(WhError::Plan(format!("RESTORE: version {} is newer than the table ({})", target.version, current.version)));
    }

    let now_files: HashMap<String, &Add> = current.files.iter().map(|a| (a.file_path(), a)).collect();
    let then_files: HashMap<String, &Add> = target.files.iter().map(|a| (a.file_path(), a)).collect();
    let removes: Vec<&Add> = current.files.iter().filter(|a| !then_files.contains_key(&a.file_path())).collect();
    let adds: Vec<&Add> = target.files.iter().filter(|a| !now_files.contains_key(&a.file_path())).collect();

    let metadata = (current.metadata.schema_string != target.metadata.schema_string || current.partition_columns != target.partition_columns)
        .then(|| Metadata { configuration: current.metadata.configuration.clone(), name: current.metadata.name.clone(), description: current.metadata.description.clone(), ..target.metadata.clone() });
    if removes.is_empty() && adds.is_empty() && metadata.is_none() {
        return Ok(RestoreSummary {
            version: current.version,
            restored_version: target.version,
            files_removed: 0,
            files_restored: 0,
            bytes_removed: 0,
            bytes_restored: 0,
            skipped: true,
        });
    }
    if !removes.is_empty() {
        check_not_append_only(&current)?;
    }
    for a in &adds {
        if !file_exists(location, storage, &a.file_path())? {
            return Err(WhError::Execution(format!(
                "cannot restore {location} to version {}: the data file '{}' no longer exists (VACUUM removed it?)",
                target.version,
                a.file_path()
            )));
        }
    }

    let now = now_ms();
    let size = |a: &Add| a.size.max(0) as u64;
    let (bytes_removed, bytes_restored) = (removes.iter().map(|a| size(a)).sum::<u64>(), adds.iter().map(|a| size(a)).sum::<u64>());
    let after_files = (current.files.len() - removes.len() + adds.len()) as i64;
    let after_bytes = current.files.iter().map(size).sum::<u64>() - bytes_removed + bytes_restored;
    let (param, value) = match to {
        VersionSpec::Version(_) => ("version", serde_json::Value::from(target.version)),
        VersionSpec::Timestamp(ts) => ("timestamp", serde_json::Value::from(ts)),
    };
    let mut txn = Transaction::new(Some(current.version), "RESTORE")
        .reads_table(true)
        .parameter(param, value)
        .metric("restoredVersion", target.version as i64)
        .metric("numRestoredFiles", adds.len() as i64)
        .metric("restoredFilesSize", bytes_restored as i64)
        .metric("removedFilesSize", bytes_removed as i64)
        .metric("numOfFilesAfterRestore", after_files)
        .metric("tableSizeAfterRestore", after_bytes as i64);
    if let Some(m) = metadata {
        txn.push(Action::Metadata(m));
    }
    txn.extend(removes.iter().map(|a| Action::Remove(Remove::of(a, now, true))));
    txn.extend(adds.iter().map(|a| {
        let mut add = (*a).clone();
        add.data_change = true;
        Action::Add(add)
    }));
    let version = txn.commit(&log)?;
    Ok(RestoreSummary {
        version,
        restored_version: target.version,
        files_removed: removes.len(),
        files_restored: adds.len(),
        bytes_removed,
        bytes_restored,
        skipped: false,
    })
}

/// Whether the data file `path` (relative to the table root, or absolute) exists.
fn file_exists(location: &str, storage: &StorageOptions, path: &str) -> Result<bool> {
    let full = if url_scheme(path).is_some() || std::path::Path::new(path).is_absolute() {
        path.strip_prefix("file://").unwrap_or(path).to_string()
    } else {
        format!("{}/{path}", location.trim_end_matches(['/', '\\']))
    };
    match Location::parse(&full)? {
        Location::Local(p) => Ok(p.is_file()),
        Location::Object(url) => {
            let store = registry::store(&url, storage)?;
            match block_on(store.head(&object_path(&url.key))) {
                Ok(_) => Ok(true),
                Err(object_store::Error::NotFound { .. }) => Ok(false),
                Err(e) => Err(storage_err(e, &url.to_string())),
            }
        }
    }
}
