//! A write transaction on a Delta table: the actions to commit and the
//! version of the table they were computed from.
//!
//! [`Transaction::commit`] writes the next commit file without replacing an
//! existing one. When another writer got there first, the commits made
//! since the transaction's read version are checked against it:
//!
//! - a changed schema or protocol conflicts with every transaction;
//! - a file this transaction removes that was removed already conflicts;
//! - when the transaction read the table (overwrite, replace, update,
//!   delete, merge), any file added or removed meanwhile conflicts;
//! - otherwise (blind appends above all) the commit is tried again at the
//!   next version, [`MAX_COMMIT_ATTEMPTS`] times at most.
//!
//! Creating a table has no read version: any commit that exists conflicts.

use std::collections::HashSet;

use serde_json::{Map, Value};

use super::actions::{Action, CommitInfo, parse_commit, write_commit};
use super::checkpoint::{should_checkpoint, write_checkpoint};
use super::log_store::LogStore;
use super::names::{LogFileKind, commit_file_name};
use super::snapshot::Snapshot;
use crate::error::{Result, WhError};

/// Commit attempts of one transaction (the first and the retries after a harmless conflict).
pub const MAX_COMMIT_ATTEMPTS: usize = 10;

pub struct Transaction {
    /// the version the actions were computed from; `None` creates the table
    read_version: Option<u64>,
    /// whether the actions depend on the files the table held
    reads_table: bool,
    blind_append: bool,
    operation: String,
    parameters: Map<String, Value>,
    metrics: Vec<(String, i64)>,
    actions: Vec<Action>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

impl Transaction {
    /// A transaction on the table as of `read_version` (`None`: it creates the
    /// table), recorded in the log as `operation` (`WRITE`, `CREATE TABLE AS SELECT`, ...).
    pub fn new(read_version: Option<u64>, operation: &str) -> Transaction {
        Transaction {
            read_version,
            reads_table: false,
            blind_append: false,
            operation: operation.to_string(),
            parameters: Map::new(),
            metrics: vec![],
            actions: vec![],
        }
    }

    /// The transaction's actions depend on the files the table held (it removes
    /// files or rewrites them): files added or removed meanwhile conflict.
    pub fn reads_table(mut self, yes: bool) -> Transaction {
        self.reads_table = yes;
        self
    }

    /// The transaction only adds files, whatever the table holds.
    pub fn blind_append(mut self, yes: bool) -> Transaction {
        self.blind_append = yes;
        self
    }

    pub fn parameter(mut self, key: &str, value: impl Into<Value>) -> Transaction {
        self.parameters.insert(key.to_string(), value.into());
        self
    }

    pub fn metric(mut self, name: &str, value: i64) -> Transaction {
        self.metrics.push((name.to_string(), value));
        self
    }

    pub fn push(&mut self, action: Action) {
        self.actions.push(action);
    }

    pub fn extend(&mut self, actions: impl IntoIterator<Item = Action>) {
        self.actions.extend(actions);
    }

    pub fn actions(&self) -> &[Action] {
        &self.actions
    }

    fn commit_info(&self, timestamp: i64) -> CommitInfo {
        let adds: Vec<_> = self.actions.iter().filter_map(|a| if let Action::Add(a) = a { Some(a) } else { None }).collect();
        let removed = self.actions.iter().filter(|a| matches!(a, Action::Remove(_))).count();
        let mut metrics: Vec<(&str, i64)> = vec![
            ("numFiles", adds.len() as i64),
            ("numAddedFiles", adds.len() as i64),
            ("numRemovedFiles", removed as i64),
            ("numOutputBytes", adds.iter().map(|a| a.size).sum()),
        ];
        metrics.extend(self.metrics.iter().map(|(k, v)| (k.as_str(), *v)));
        let mut info = CommitInfo::new(&self.operation, timestamp)
            .with_operation_parameters(self.parameters.clone())
            .with_operation_metrics(&metrics)
            .set("engineInfo", format!("iara/{}", env!("CARGO_PKG_VERSION")))
            .set("isBlindAppend", self.blind_append);
        if let Some(v) = self.read_version {
            info = info.set("readVersion", v);
        }
        info
    }

    /// Commit the actions as the next version of the table; returns that version.
    pub fn commit(&self, log: &LogStore) -> Result<u64> {
        let mut version = self.read_version.map_or(0, |v| v + 1);
        // the newest version whose commit has been checked against this transaction
        let mut checked = self.read_version;
        let mut newest_time = 0;
        for _ in 0..MAX_COMMIT_ATTEMPTS {
            // commit times grow with the version: never earlier than a commit before
            let mut actions = vec![Action::CommitInfo(self.commit_info(now_ms().max(newest_time + 1)))];
            actions.extend(self.actions.iter().cloned());
            if log.put_if_absent(&commit_file_name(version), write_commit(&actions))? {
                self.after_commit(log, version);
                return Ok(version);
            }
            let from = checked.map_or(0, |v| v + 1);
            let mut rivals: Vec<u64> = log.list_from(from)?.into_iter().filter(|f| f.kind == LogFileKind::Commit).map(|f| f.version).collect();
            rivals.sort_unstable();
            for (i, v) in rivals.iter().enumerate() {
                if *v != from + i as u64 {
                    return Err(WhError::Execution(format!("the Delta log of {} is missing version {}", log.table(), from + i as u64)));
                }
                let rival = parse_commit(&log.read(&commit_file_name(*v))?)?;
                self.check_conflicts(log, *v, &rival)?;
                newest_time = newest_time.max(rival.iter().find_map(|a| if let Action::CommitInfo(c) = a { c.timestamp() } else { None }).unwrap_or(0));
            }
            match rivals.last() {
                Some(last) if *last >= version => {
                    checked = Some(*last);
                    version = last + 1;
                }
                _ => return Err(WhError::Execution(format!("the Delta log of {} already has version {version} but does not list it", log.table()))),
            }
        }
        Err(WhError::ConcurrentModification(format!(
            "could not commit to {} after {MAX_COMMIT_ATTEMPTS} attempts: other writers kept committing",
            log.table()
        )))
    }

    /// Whether the commit `version` (by another writer) is compatible with this transaction.
    fn check_conflicts(&self, log: &LogStore, version: u64, rival: &[Action]) -> Result<()> {
        let conflict = |what: &str| {
            Err(WhError::ConcurrentModification(format!(
                "{} of the Delta table {} conflicts with version {version}, committed meanwhile: {what}",
                self.operation,
                log.table()
            )))
        };
        if self.read_version.is_none() {
            return conflict("the table was created by another writer");
        }
        let removing: HashSet<String> = self.actions.iter().filter_map(|a| if let Action::Remove(r) = a { Some(r.file_path()) } else { None }).collect();
        for action in rival {
            match action {
                Action::Metadata(_) | Action::Protocol(_) => return conflict("the schema or protocol of the table changed"),
                Action::Remove(r) if removing.contains(&r.file_path()) => return conflict(&format!("the file '{}' was already removed", r.file_path())),
                Action::Remove(_) if self.reads_table => return conflict("files this operation read were removed"),
                Action::Add(_) if self.reads_table => return conflict("files were added to the table this operation read"),
                _ => {}
            }
        }
        Ok(())
    }

    /// Drop cached listings; write a checkpoint when the version calls for one
    /// (a failure to do so does not undo the commit: readers just replay more commits).
    fn after_commit(&self, log: &LogStore, version: u64) {
        log.invalidate_listings();
        if should_checkpoint(version) {
            let _ = Snapshot::load(log, Some(version)).and_then(|s| write_checkpoint(log, &s));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::delta::test_support::{TempDir, add, commit, metadata, protocol};
    use crate::delta::{Remove, latest_version};

    fn table() -> (TempDir, LogStore) {
        let tmp = TempDir::new();
        let log = tmp.log();
        commit(&log, 0, Some(1000), vec![Action::Protocol(protocol()), Action::Metadata(metadata(&["id"])), Action::Add(add("a.parquet", 1))]);
        (tmp, log)
    }

    fn appending(read: u64, file: &str) -> Transaction {
        let mut t = Transaction::new(Some(read), "WRITE").blind_append(true);
        t.push(Action::Add(add(file, 1)));
        t
    }

    #[test]
    fn blind_appends_retry_at_the_next_version() {
        let (_tmp, log) = table();
        assert_eq!(appending(0, "b.parquet").commit(&log).unwrap(), 1);
        assert_eq!(appending(0, "c.parquet").commit(&log).unwrap(), 2);
        let s = Snapshot::load(&log, None).unwrap();
        assert_eq!(s.files.len(), 3);
        assert_eq!(latest_version(&log).unwrap(), 2);
    }

    #[test]
    fn a_reading_transaction_conflicts_with_an_append() {
        let (_tmp, log) = table();
        appending(0, "b.parquet").commit(&log).unwrap();
        let mut t = Transaction::new(Some(0), "WRITE").reads_table(true);
        t.push(Action::Remove(Remove::of(&add("a.parquet", 1), 5, true)));
        let err = t.commit(&log).unwrap_err();
        assert!(matches!(err, WhError::ConcurrentModification(_)), "{err}");
        assert_eq!(latest_version(&log).unwrap(), 1);
    }

    #[test]
    fn removing_the_same_file_twice_conflicts_even_for_a_blind_writer() {
        let (_tmp, log) = table();
        let remove = |v| {
            let mut t = Transaction::new(Some(v), "DELETE");
            t.push(Action::Remove(Remove::of(&add("a.parquet", 1), 5, true)));
            t
        };
        remove(0).commit(&log).unwrap();
        assert!(matches!(remove(0).commit(&log), Err(WhError::ConcurrentModification(_))));
    }

    #[test]
    fn creating_over_an_existing_table_conflicts() {
        let (_tmp, log) = table();
        let mut t = Transaction::new(None, "CREATE TABLE");
        t.push(Action::Protocol(protocol()));
        assert!(matches!(t.commit(&log), Err(WhError::ConcurrentModification(_))));
    }

    #[test]
    fn a_checkpoint_follows_version_ten() {
        let (_tmp, log) = table();
        for i in 1..=10u64 {
            assert_eq!(appending(i - 1, &format!("f{i}.parquet")).commit(&log).unwrap(), i);
        }
        assert_eq!(log.read_last_checkpoint().unwrap().map(|c| c.version), Some(10));
    }
}
