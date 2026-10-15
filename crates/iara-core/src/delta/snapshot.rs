//! The state of a Delta table at one version, rebuilt from its log: the
//! newest checkpoint at or below the version, then the commits after it.
//!
//! Files are reconciled by (path, deletion vector): the latest action wins.
//! Protocol and metadata are the last ones seen; `txn` keeps the last
//! version per app id; `commitInfo` only supplies the version's timestamp
//! (`inCommitTimestamp` when present, else `timestamp`, else the commit
//! file's modification time).

use std::collections::BTreeMap;

use arrow::datatypes::SchemaRef;

use super::actions::{Action, Add, Metadata, Protocol, Txn, parse_commit};
use super::checkpoint::read_checkpoint;
use super::features::check_reader_support;
use super::log_store::{LogFile, LogStore};
use super::names::LogFileKind;
use super::schema_json::schema_from_json;
use crate::error::{Result, WhError};

#[derive(Debug, Clone, PartialEq)]
pub struct Snapshot {
    pub version: u64,
    pub protocol: Protocol,
    pub metadata: Metadata,
    /// the Arrow schema of `metadata.schema_string`
    pub schema: SchemaRef,
    pub partition_columns: Vec<String>,
    /// the active files, ordered by path
    pub files: Vec<Add>,
    /// the last `txn` version of every app id
    pub txns: Vec<Txn>,
    /// when the version was committed, milliseconds since the epoch
    pub timestamp: i64,
}

type FileKey = (String, Option<String>);

#[derive(Default)]
struct State {
    protocol: Option<Protocol>,
    metadata: Option<Metadata>,
    adds: BTreeMap<FileKey, Add>,
    txns: BTreeMap<String, Txn>,
}

fn file_key(path: &str, dv: Option<&super::actions::DeletionVector>) -> FileKey {
    let path = super::util::percent_decode(path);
    (path, dv.map(|d| format!("{}{}@{}", d.storage_type, d.path_or_inline_dv, d.offset.unwrap_or(-1))))
}

impl State {
    /// `in_checkpoint`: removes are tombstones there, not changes to apply.
    fn apply(&mut self, action: Action, in_checkpoint: bool) {
        match action {
            Action::Protocol(p) => self.protocol = Some(p),
            Action::Metadata(m) => self.metadata = Some(m),
            Action::Add(a) => {
                self.adds.insert(file_key(&a.path, a.deletion_vector.as_ref()), a);
            }
            Action::Remove(r) if !in_checkpoint => {
                self.adds.remove(&file_key(&r.path, r.deletion_vector.as_ref()));
            }
            Action::Txn(t) => {
                self.txns.insert(t.app_id.clone(), t);
            }
            Action::Remove(_) | Action::CommitInfo(_) => {}
        }
    }
}

fn no_table(log: &LogStore, detail: &str) -> WhError {
    WhError::Execution(format!("not a Delta table or the log was vacuumed: {detail} in {}/_delta_log", log.table()))
}

/// The commit timestamp recorded in a commit's actions.
fn commit_timestamp(actions: &[Action]) -> Option<i64> {
    actions.iter().find_map(|a| match a {
        Action::CommitInfo(ci) => ci.0.get("inCommitTimestamp").and_then(|v| v.as_i64()).or(ci.timestamp()),
        _ => None,
    })
}

/// The timestamp of a commit file: its `commitInfo`, else its modification time.
fn read_commit_timestamp(log: &LogStore, file: &LogFile) -> Result<i64> {
    let bytes = log.read(&file.name)?;
    let text = String::from_utf8_lossy(&bytes);
    let from_info = text.lines().filter(|l| l.contains("\"commitInfo\"")).find_map(|l| Action::from_line(l.trim()).ok().flatten().and_then(|a| commit_timestamp(&[a])));
    from_info.or(file.modified).ok_or_else(|| WhError::Execution(format!("commit {} has no timestamp", file.name)))
}

/// The newest complete checkpoint at or below `limit`: the files of its parts.
fn pick_checkpoint(files: &[LogFile], limit: Option<u64>) -> Option<Vec<LogFile>> {
    let mut versions: Vec<u64> = files.iter().filter(|f| f.kind.is_checkpoint() && limit.is_none_or(|l| f.version <= l)).map(|f| f.version).collect();
    versions.sort_unstable();
    versions.dedup();
    versions.into_iter().rev().find_map(|v| {
        let at: Vec<&LogFile> = files.iter().filter(|f| f.version == v && f.kind.is_checkpoint()).collect();
        if let Some(single) = at.iter().find(|f| f.kind == LogFileKind::Checkpoint) {
            return Some(vec![(*single).clone()]);
        }
        let counts: Vec<u32> = at.iter().filter_map(|f| if let LogFileKind::MultiPartCheckpoint { parts, .. } = f.kind { Some(parts) } else { None }).collect();
        counts.into_iter().find_map(|n| {
            let mut parts: Vec<LogFile> = at.iter().filter(|f| matches!(f.kind, LogFileKind::MultiPartCheckpoint { parts, .. } if parts == n)).map(|f| (*f).clone()).collect();
            parts.sort_by_key(|f| f.name.clone());
            (parts.len() == n as usize).then_some(parts)
        })
    })
}

/// The log files from the checkpoint `_last_checkpoint` names (or all of them).
fn list_recent(log: &LogStore, limit: Option<u64>) -> Result<(Vec<LogFile>, Option<Vec<LogFile>>)> {
    let hint = log.read_last_checkpoint()?.map(|c| c.version).filter(|v| limit.is_none_or(|l| *v <= l)).unwrap_or(0);
    let files = log.list_from(hint)?;
    let checkpoint = pick_checkpoint(&files, limit);
    if checkpoint.is_none() && hint > 0 {
        let files = log.list_from(0)?;
        let checkpoint = pick_checkpoint(&files, limit);
        return Ok((files, checkpoint));
    }
    Ok((files, checkpoint))
}

/// The newest version of the table.
pub fn latest_version(log: &LogStore) -> Result<u64> {
    let newest = |files: &[LogFile]| files.iter().filter(|f| f.kind != LogFileKind::LastCheckpoint).map(|f| f.version).max();
    let hint = log.read_last_checkpoint()?.map_or(0, |c| c.version);
    let found = match newest(&log.list_from(hint)?) {
        Some(v) => Some(v),
        None if hint > 0 => newest(&log.list_from(0)?),
        None => None,
    };
    found.ok_or_else(|| no_table(log, "no commits or checkpoints"))
}

impl Snapshot {
    /// The table at `version`, or at its newest version.
    pub fn load(log: &LogStore, version: Option<u64>) -> Result<Snapshot> {
        let (files, checkpoint) = list_recent(log, version)?;
        let from = checkpoint.as_ref().map_or(0, |c| c[0].version + 1);
        let mut commits: Vec<&LogFile> = files.iter().filter(|f| f.kind == LogFileKind::Commit && f.version >= from && version.is_none_or(|v| f.version <= v)).collect();
        commits.sort_by_key(|f| f.version);
        for (i, c) in commits.iter().enumerate() {
            if c.version != from + i as u64 {
                return Err(if from + i as u64 == 0 {
                    no_table(log, "version 0 is missing and no checkpoint covers it")
                } else {
                    WhError::Execution(format!("the Delta log of {} is missing version {}", log.table(), from + i as u64))
                });
            }
        }
        let latest = match (commits.last(), &checkpoint) {
            (Some(c), _) => c.version,
            (None, Some(cp)) => cp[0].version,
            (None, None) => return Err(no_table(log, "no commits or checkpoints")),
        };
        if let Some(v) = version
            && v != latest
        {
            return Err(WhError::Execution(format!("version {v} of the Delta table {} does not exist (the latest version is {latest})", log.table())));
        }

        let mut state = State::default();
        if let Some(cp) = &checkpoint {
            let names: Vec<String> = cp.iter().map(|f| f.name.clone()).collect();
            for action in read_checkpoint(log, &names)? {
                state.apply(action, true);
            }
        }
        let mut timestamp = None;
        for c in &commits {
            let actions = parse_commit(&log.read(&c.name)?)?;
            timestamp = commit_timestamp(&actions).or(c.modified);
            for action in actions {
                state.apply(action, false);
            }
        }
        if commits.is_empty() {
            // the version is the checkpoint's: its commit may be gone
            let cp = checkpoint.as_ref().expect("a checkpoint when there are no commits");
            timestamp = match files.iter().find(|f| f.kind == LogFileKind::Commit && f.version == latest) {
                Some(commit) => Some(read_commit_timestamp(log, commit)?),
                None => cp[0].modified,
            };
        }
        Snapshot::build(log, latest, timestamp.unwrap_or(0), state)
    }

    fn build(log: &LogStore, version: u64, timestamp: i64, state: State) -> Result<Snapshot> {
        let protocol = state.protocol.ok_or_else(|| WhError::Execution(format!("the Delta log of {} has no protocol action", log.table())))?;
        let metadata = state.metadata.ok_or_else(|| WhError::Execution(format!("the Delta log of {} has no metaData action", log.table())))?;
        let files: Vec<Add> = state.adds.into_values().collect();
        check_reader_support(&protocol, &metadata, &files)?;
        let schema = std::sync::Arc::new(schema_from_json(&metadata.schema_string)?);
        Ok(Snapshot { version, partition_columns: metadata.partition_columns.clone(), protocol, metadata, schema, files, txns: state.txns.into_values().collect(), timestamp })
    }

    /// The table as of `ts_ms` (milliseconds since the epoch): the newest
    /// version committed at or before it. A time after the newest commit
    /// gives the newest version; one before the first commit is an error.
    pub fn at_timestamp(log: &LogStore, ts_ms: i64) -> Result<Snapshot> {
        let mut commits: Vec<LogFile> = log.list_from(0)?.into_iter().filter(|f| f.kind == LogFileKind::Commit).collect();
        commits.sort_by_key(|f| f.version);
        if commits.is_empty() {
            return Err(no_table(log, "no commits"));
        }
        // the first commit with a timestamp after ts_ms (commit times grow with the version)
        let (mut lo, mut hi) = (0, commits.len());
        while lo < hi {
            let mid = (lo + hi) / 2;
            if read_commit_timestamp(log, &commits[mid])? <= ts_ms {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo == 0 {
            return Err(WhError::Execution(format!(
                "timestamp {ts_ms} is before the first available version ({}, committed at {}) of the Delta table {}",
                commits[0].version,
                read_commit_timestamp(log, &commits[0])?,
                log.table()
            )));
        }
        Snapshot::load(log, Some(commits[lo - 1].version))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delta::checkpoint::{write_checkpoint, write_checkpoint_parts};
    use crate::delta::names::{checkpoint_file_name, commit_file_name};
    use crate::delta::test_support::{TempDir, add, adds, commit, metadata, protocol};

    /// v0 a b | v1 +c | v2 -a +d | v3 schema change +e | v4 -b, txn
    fn small_log() -> (TempDir, LogStore) {
        let tmp = TempDir::new();
        let log = tmp.log();
        commit(&log, 0, Some(1000), vec![Action::Protocol(protocol()), Action::Metadata(metadata(&["id"])), Action::Add(add("a.parquet", 1)), Action::Add(add("b.parquet", 2))]);
        commit(&log, 1, Some(2000), vec![Action::Add(add("c.parquet", 3))]);
        commit(&log, 2, Some(3000), vec![Action::Remove(crate::delta::Remove::of(&add("a.parquet", 1), 3000, true)), Action::Add(add("d.parquet", 4))]);
        commit(&log, 3, Some(4000), vec![Action::Metadata(metadata(&["id", "name"])), Action::Add(add("e.parquet", 5))]);
        commit(
            &log,
            4,
            Some(5000),
            vec![Action::Remove(crate::delta::Remove::of(&add("b.parquet", 2), 5000, true)), Action::Txn(Txn { app_id: "app".into(), version: 7, last_updated: None })],
        );
        (tmp, log)
    }

    #[test]
    fn replays_the_log_at_every_version() {
        let (_tmp, log) = small_log();
        assert_eq!(latest_version(&log).unwrap(), 4);
        let s = Snapshot::load(&log, None).unwrap();
        assert_eq!((s.version, s.timestamp), (4, 5000));
        assert_eq!(adds(&s.files), vec!["c.parquet", "d.parquet", "e.parquet"]);
        assert_eq!(s.schema.fields().len(), 2);
        assert_eq!(s.txns, vec![Txn { app_id: "app".into(), version: 7, last_updated: None }]);
        let s1 = Snapshot::load(&log, Some(1)).unwrap();
        assert_eq!(adds(&s1.files), vec!["a.parquet", "b.parquet", "c.parquet"]);
        assert_eq!((s1.schema.fields().len(), s1.timestamp), (1, 2000));
        assert_eq!(adds(&Snapshot::load(&log, Some(2)).unwrap().files), vec!["b.parquet", "c.parquet", "d.parquet"]);
        let err = Snapshot::load(&log, Some(5)).unwrap_err().to_string();
        assert!(err.contains("does not exist") && err.contains("latest version is 4"), "{err}");
    }

    #[test]
    fn time_travel_by_timestamp() {
        let (_tmp, log) = small_log();
        let at = |ts| Snapshot::at_timestamp(&log, ts).map(|s| s.version);
        assert_eq!(at(1000).unwrap(), 0);
        assert_eq!(at(1999).unwrap(), 0);
        assert_eq!(at(2000).unwrap(), 1);
        assert_eq!(at(3999).unwrap(), 2);
        assert_eq!(at(5000).unwrap(), 4);
        assert_eq!(at(99_999).unwrap(), 4);
        assert!(at(999).unwrap_err().to_string().contains("before the first"));
    }

    #[test]
    fn commits_without_commit_info_use_the_file_time() {
        let tmp = TempDir::new();
        let log = tmp.log();
        commit(&log, 0, None, vec![Action::Protocol(protocol()), Action::Metadata(metadata(&["id"])), Action::Add(add("a.parquet", 1))]);
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        let s = Snapshot::load(&log, None).unwrap();
        assert!((s.timestamp - now).abs() < 120_000, "{} vs {now}", s.timestamp);
        assert_eq!(Snapshot::at_timestamp(&log, now + 120_000).unwrap().version, 0);
    }

    #[test]
    fn a_checkpoint_gives_the_state_of_a_full_replay() {
        let tmp = TempDir::new();
        let log = tmp.log();
        commit(&log, 0, Some(1000), vec![Action::Protocol(protocol()), Action::Metadata(metadata(&["id"]))]);
        for v in 1..=12u64 {
            let mut actions = vec![Action::Add(add(&format!("f{v}.parquet"), v as i64))];
            if v > 2 && v % 3 == 0 {
                actions.push(Action::Remove(crate::delta::Remove::of(&add(&format!("f{}.parquet", v - 2), 1), 0, true)));
            }
            commit(&log, v, Some(1000 + v as i64), actions);
        }
        let full = Snapshot::load(&log, None).unwrap();
        let at10 = Snapshot::load(&log, Some(10)).unwrap();
        let last = write_checkpoint(&log, &at10).unwrap();
        assert_eq!((last.version, last.parts, last.num_of_add_files), (10, None, Some(at10.files.len() as i64)));
        assert!(tmp.log_path(&checkpoint_file_name(10)).exists());
        assert_eq!(log.read_last_checkpoint().unwrap().unwrap().version, 10);
        // with the old commits gone, only the checkpoint and the later commits remain
        for v in 0..=9 {
            log.delete(&commit_file_name(v)).unwrap();
        }
        assert_eq!(Snapshot::load(&log, None).unwrap(), full);
        assert_eq!(Snapshot::load(&log, Some(10)).unwrap(), at10);
        assert_eq!(latest_version(&log).unwrap(), 12);
        let err = Snapshot::load(&log, Some(5)).unwrap_err().to_string();
        assert!(err.contains("vacuumed"), "{err}");
        // a checkpoint at a version older than the pointer does not move it back
        let at5_state = full.clone();
        let older = Snapshot { version: 9, ..at5_state };
        write_checkpoint(&log, &older).unwrap();
        assert_eq!(log.read_last_checkpoint().unwrap().unwrap().version, 10);
    }

    #[test]
    fn checkpoint_without_commit_files_uses_its_own_time() {
        let (_tmp, log) = small_log();
        let s = Snapshot::load(&log, Some(2)).unwrap();
        write_checkpoint(&log, &s).unwrap();
        for v in 0..=4 {
            log.delete(&commit_file_name(v)).unwrap();
        }
        let again = Snapshot::load(&log, None).unwrap();
        assert_eq!((again.version, adds(&again.files)), (2, vec!["b.parquet".to_string(), "c.parquet".into(), "d.parquet".into()]));
        let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64;
        assert!((again.timestamp - now).abs() < 120_000);
    }

    #[test]
    fn multi_part_checkpoints_are_read() {
        let (tmp, log) = small_log();
        let full = Snapshot::load(&log, None).unwrap();
        let last = write_checkpoint_parts(&log, &full, 2).unwrap();
        assert_eq!(last.parts, Some(2));
        assert!(!tmp.log_path(&checkpoint_file_name(4)).exists());
        assert_eq!(log.list_from(0).unwrap().iter().filter(|f| f.kind.is_checkpoint()).count(), 2);
        for v in 0..=3 {
            log.delete(&commit_file_name(v)).unwrap();
        }
        assert_eq!(Snapshot::load(&log, None).unwrap(), full);
        // a part missing: no usable checkpoint is left
        log.delete(&crate::delta::multipart_checkpoint_file_name(4, 2, 2)).unwrap();
        let err = Snapshot::load(&log, None).unwrap_err().to_string();
        assert!(err.contains("not a Delta table or the log was vacuumed"), "{err}");
    }

    #[test]
    fn a_missing_version_zero_and_gaps_are_errors() {
        let tmp = TempDir::new();
        let log = tmp.log();
        let err = Snapshot::load(&log, None).unwrap_err().to_string();
        assert!(err.contains("not a Delta table or the log was vacuumed"), "{err}");
        commit(&log, 1, Some(1), vec![Action::Protocol(protocol()), Action::Metadata(metadata(&["id"]))]);
        let err = Snapshot::load(&log, None).unwrap_err().to_string();
        assert!(err.contains("not a Delta table or the log was vacuumed") && err.contains("version 0"), "{err}");

        let (_tmp, log) = small_log();
        log.delete(&commit_file_name(2)).unwrap();
        let err = Snapshot::load(&log, None).unwrap_err().to_string();
        assert!(err.contains("missing version 2"), "{err}");
        assert_eq!(Snapshot::load(&log, Some(1)).unwrap().version, 1);
    }

    fn table_with(protocol: Protocol, meta: Metadata, files: Vec<Add>) -> (TempDir, LogStore) {
        let tmp = TempDir::new();
        let log = tmp.log();
        let mut actions = vec![Action::Protocol(protocol), Action::Metadata(meta)];
        actions.extend(files.into_iter().map(Action::Add));
        commit(&log, 0, Some(1), actions);
        (tmp, log)
    }

    fn load_err(protocol: Protocol, meta: Metadata, files: Vec<Add>) -> String {
        let (_tmp, log) = table_with(protocol, meta, files);
        Snapshot::load(&log, None).unwrap_err().to_string()
    }

    #[test]
    fn unsupported_features_are_refused_by_name() {
        let proto = |r: i32, f: &[&str]| Protocol {
            min_reader_version: r,
            min_writer_version: 7,
            reader_features: Some(f.iter().map(|s| s.to_string()).collect()),
            writer_features: Some(f.iter().map(|s| s.to_string()).collect()),
        };
        let m = || metadata(&["id"]);
        for feature in ["deletionVectors", "columnMapping", "v2Checkpoint", "typeWidening"] {
            let err = load_err(proto(3, &[feature]), m(), vec![]);
            assert!(err.contains(feature) && err.contains("not supported"), "{err}");
        }
        assert!(load_err(proto(4, &[]), m(), vec![]).contains("reader protocol version 4"));
        let mut mapped = m();
        mapped.configuration.insert("delta.columnMapping.mode".into(), "name".into());
        assert!(load_err(protocol(), mapped, vec![]).contains("column mapping"));
        let mut dv = add("x.parquet", 1);
        dv.deletion_vector = Some(crate::delta::DeletionVector { storage_type: "i".into(), path_or_inline_dv: "x".into(), offset: None, size_in_bytes: 1, cardinality: 1 });
        assert!(load_err(protocol(), m(), vec![dv]).contains("deletion vectors"));
        // supported: timestampNtz, and column mapping switched off
        let mut off = m();
        off.configuration.insert("delta.columnMapping.mode".into(), "none".into());
        let (_tmp, log) = table_with(proto(3, &["timestampNtz"]), off, vec![add("x.parquet", 1)]);
        assert_eq!(Snapshot::load(&log, None).unwrap().files.len(), 1);
    }
}
