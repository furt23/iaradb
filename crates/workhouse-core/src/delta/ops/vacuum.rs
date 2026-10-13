//! `VACUUM`: delete the data files a table no longer needs.
//!
//! A file under the table root is deleted when the current version does not
//! use it and it is older than the retention period:
//!
//! - a file the log removed counts from its `remove` action's
//!   `deletionTimestamp` (the newest one if it was removed more than once);
//! - a file the log never mentions (an orphan: a write that failed or lost its
//!   commit) counts from its modification time.
//!
//! Never touched: `_delta_log/`, and hidden files and folders (a name that
//! starts with `_` or `.`, unless it is a `col=value` partition folder).
//! Delta also records `VACUUM START` / `VACUUM END` commits; this does not
//! (nothing in the table changes, and readers are not told).

use std::collections::{HashMap, HashSet};

use futures::TryStreamExt;
#[allow(unused_imports)]
use object_store::{ObjectStore, ObjectStoreExt};

use super::now_ms;
use crate::delta::actions::Action;
use crate::delta::checkpoint::read_checkpoint;
use crate::delta::log_store::LogStore;
use crate::delta::names::{LOG_DIR, LogFileKind};
use crate::delta::snapshot::Snapshot;
use crate::error::{Result, WhError};
use crate::io::dataset;
use crate::io::location::Location;
use crate::io::object::error::storage_err;
use crate::io::object::{block_on, object_path, registry};
use crate::io::options::StorageOptions;

/// Default retention: 7 days.
pub const DEFAULT_RETENTION_HOURS: f64 = 168.0;

/// What a `VACUUM` found (a dry run) or deleted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VacuumSummary {
    pub dry_run: bool,
    /// the files, relative to the table root, sorted
    pub files: Vec<String>,
    pub bytes: u64,
}

/// A file under the table root.
struct Listed {
    /// relative to the table root, `/` separated
    path: String,
    size: u64,
    /// modification time, milliseconds since the epoch
    modified: Option<i64>,
}

/// Delete the unneeded files older than `retention_hours` (default 168) of the
/// table at `location`; with `dry_run` only list them. A retention under 168
/// hours is refused unless `allow_short_retention`: it can break time travel
/// and readers of older versions that are still running.
pub fn vacuum(location: &str, storage: &StorageOptions, retention_hours: Option<f64>, dry_run: bool, allow_short_retention: bool) -> Result<VacuumSummary> {
    vacuum_as_of(location, storage, retention_hours, dry_run, allow_short_retention, now_ms())
}

/// [`vacuum`] with the current time given (milliseconds since the epoch).
pub fn vacuum_as_of(
    location: &str,
    storage: &StorageOptions,
    retention_hours: Option<f64>,
    dry_run: bool,
    allow_short_retention: bool,
    now: i64,
) -> Result<VacuumSummary> {
    let hours = retention_hours.unwrap_or(DEFAULT_RETENTION_HOURS);
    if !hours.is_finite() || hours < 0.0 {
        return Err(WhError::Plan(format!("VACUUM: invalid retention of {hours} hours")));
    }
    if hours < DEFAULT_RETENTION_HOURS && !allow_short_retention {
        return Err(WhError::Plan(format!(
            "VACUUM: a retention of {hours} hours is shorter than the default of {DEFAULT_RETENTION_HOURS} hours (7 days); retention shorter than 7 days could break time travel and concurrent readers (pass allow_short_retention to do it anyway)"
        )));
    }
    let cutoff = now.saturating_sub((hours * 3_600_000.0) as i64);

    let log = LogStore::open(location, storage)?;
    let snapshot = Snapshot::load(&log, None)?;
    if snapshot.files.iter().any(|a| a.deletion_vector.is_some()) {
        return Err(WhError::NotSupported("VACUUM of a table with deletion vectors".into()));
    }
    let active: HashSet<String> = snapshot.files.iter().map(|a| a.file_path()).collect();
    let removed = removal_times(&log)?;

    let mut doomed: Vec<Listed> = list_files(location, storage)?
        .into_iter()
        .filter(|f| !active.contains(&f.path))
        .filter(|f| match removed.get(&f.path) {
            Some(removed_at) => *removed_at < cutoff,
            None => f.modified.is_some_and(|m| m < cutoff),
        })
        .collect();
    doomed.sort_by(|a, b| a.path.cmp(&b.path));
    let summary = VacuumSummary { dry_run, files: doomed.iter().map(|f| f.path.clone()).collect(), bytes: doomed.iter().map(|f| f.size).sum() };
    if !dry_run && !doomed.is_empty() {
        let full: Vec<String> = doomed.iter().map(|f| full_path(location, &f.path)).collect();
        dataset::remove_files(&full, storage)?;
        for f in &full {
            remove_empty_partition_dirs(f);
        }
        log.invalidate_listings();
    }
    Ok(summary)
}

fn full_path(location: &str, relative: &str) -> String {
    format!("{}/{relative}", location.trim_end_matches(['/', '\\']))
}

/// When each removed file was removed (the newest time, when more than once),
/// from the newest checkpoint's tombstones and every commit the log has.
fn removal_times(log: &LogStore) -> Result<HashMap<String, i64>> {
    let files = log.list_from(0)?;
    let mut times: HashMap<String, i64> = HashMap::new();
    let mut note = |remove: &crate::delta::actions::Remove, fallback: Option<i64>| {
        // without any time the file is never old enough
        let at = remove.deletion_timestamp.or(fallback).unwrap_or(i64::MAX);
        let e = times.entry(remove.file_path()).or_insert(at);
        *e = (*e).max(at);
    };
    if let Some(version) = files.iter().filter(|f| f.kind.is_checkpoint()).map(|f| f.version).max() {
        let parts: Vec<_> = files.iter().filter(|f| f.kind.is_checkpoint() && f.version == version).collect();
        let names: Vec<String> = match parts.iter().find(|f| f.kind == LogFileKind::Checkpoint) {
            Some(single) => vec![single.name.clone()],
            None => parts.iter().map(|f| f.name.clone()).collect(),
        };
        let modified = parts.iter().filter_map(|f| f.modified).max();
        for action in read_checkpoint(log, &names)? {
            if let Action::Remove(r) = action {
                note(&r, modified);
            }
        }
    }
    for f in files.iter().filter(|f| f.kind == LogFileKind::Commit) {
        let bytes = log.read(&f.name)?;
        let text = String::from_utf8_lossy(&bytes);
        for line in text.lines().filter(|l| l.contains("\"remove\"")) {
            if let Some(Action::Remove(r)) = Action::from_line(line.trim())? {
                note(&r, f.modified);
            }
        }
    }
    Ok(times)
}

/// Whether a file or folder name is hidden from `VACUUM`.
fn hidden(name: &str) -> bool {
    (name.starts_with('_') || name.starts_with('.')) && !name.contains('=')
}

/// Whether a path relative to the table root is one `VACUUM` may delete.
fn visible(relative: &str) -> bool {
    !relative.split('/').any(hidden) && relative != LOG_DIR
}

/// The files under the table root that `VACUUM` may delete.
fn list_files(location: &str, storage: &StorageOptions) -> Result<Vec<Listed>> {
    match Location::parse(location)? {
        Location::Local(root) => {
            let mut out = vec![];
            let mut pending = vec![(root, String::new())];
            while let Some((dir, prefix)) = pending.pop() {
                let entries = match std::fs::read_dir(&dir) {
                    Ok(e) => e,
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e.into()),
                };
                for entry in entries {
                    let entry = entry?;
                    let Some(name) = entry.file_name().to_str().map(str::to_string) else { continue };
                    if hidden(&name) {
                        continue;
                    }
                    let relative = format!("{prefix}{name}");
                    let meta = entry.metadata()?;
                    if meta.is_dir() {
                        pending.push((entry.path(), format!("{relative}/")));
                    } else if meta.is_file() {
                        let modified = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_millis() as i64);
                        out.push(Listed { path: relative, size: meta.len(), modified });
                    }
                }
            }
            Ok(out)
        }
        Location::Object(url) => {
            let store = registry::store(&url, storage)?;
            let key = url.key.trim_end_matches('/').to_string();
            let prefix = (!key.is_empty()).then(|| object_path(&key));
            let metas: Vec<_> = block_on(store.list(prefix.as_ref()).try_collect::<Vec<_>>()).map_err(|e| storage_err(e, &url.to_string()))?;
            let lead = if key.is_empty() { String::new() } else { format!("{key}/") };
            Ok(metas
                .iter()
                .filter_map(|m| {
                    let path = m.location.as_ref().strip_prefix(&lead)?.to_string();
                    visible(&path).then(|| Listed { path, size: m.size, modified: Some(m.last_modified.timestamp_millis()) })
                })
                .collect())
        }
    }
}

/// Remove the `col=value` folders a deleted local file leaves empty, innermost first.
fn remove_empty_partition_dirs(path: &str) {
    let mut dir = std::path::Path::new(path).parent();
    while let Some(d) = dir {
        if !d.file_name().is_some_and(|n| n.to_string_lossy().contains('=')) || std::fs::remove_dir(d).is_err() {
            return;
        }
        dir = d.parent();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hidden_names_are_not_vacuumed() {
        assert!(visible("part-1.parquet"));
        assert!(visible("p=1/part-1.parquet"));
        assert!(visible("_p=1/part-1.parquet"));
        assert!(!visible("_delta_log/00000000000000000000.json"));
        assert!(!visible("_hidden/x.parquet"));
        assert!(!visible(".part-1.parquet.crc"));
        assert!(!visible("p=1/_SUCCESS"));
    }
}
