//! Helpers of the Delta tests: temporary tables and hand-built logs.

use std::collections::BTreeMap;
use std::path::PathBuf;

use super::actions::{Action, Add, CommitInfo, Format, Metadata, Protocol, write_commit};
use super::log_store::LogStore;
use super::names::commit_file_name;
use super::util::new_uuid;
use crate::io::options::StorageOptions;

pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new() -> TempDir {
        let p = std::env::temp_dir().join(format!("workhouse-delta-{}", new_uuid()));
        std::fs::create_dir_all(&p).unwrap();
        TempDir(p)
    }

    pub fn log(&self) -> LogStore {
        LogStore::open(self.0.to_str().unwrap(), &StorageOptions::new()).unwrap()
    }

    pub fn log_path(&self, name: &str) -> PathBuf {
        self.0.join("_delta_log").join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// A schema string of `long` columns.
pub fn schema_string(cols: &[&str]) -> String {
    let fields: Vec<String> = cols.iter().map(|c| format!(r#"{{"name":"{c}","type":"long","nullable":true,"metadata":{{}}}}"#)).collect();
    format!(r#"{{"type":"struct","fields":[{}]}}"#, fields.join(","))
}

pub fn metadata(cols: &[&str]) -> Metadata {
    Metadata {
        id: "test-table".into(),
        name: None,
        description: None,
        format: Format::default(),
        schema_string: schema_string(cols),
        partition_columns: vec![],
        configuration: BTreeMap::new(),
        created_time: Some(0),
    }
}

pub fn protocol() -> Protocol {
    Protocol { min_reader_version: 1, min_writer_version: 2, reader_features: None, writer_features: None }
}

pub fn add(path: &str, size: i64) -> Add {
    Add::new(path, BTreeMap::new(), size, 1, Some(r#"{"numRecords":1}"#.to_string()))
}

/// Write commit `version`, with a `commitInfo` at `timestamp` when given.
pub fn commit(log: &LogStore, version: u64, timestamp: Option<i64>, actions: Vec<Action>) {
    let mut all = Vec::new();
    all.extend(timestamp.map(|t| Action::CommitInfo(CommitInfo::new("WRITE", t))));
    all.extend(actions);
    assert!(log.put_if_absent(&commit_file_name(version), write_commit(&all)).unwrap(), "version {version} exists");
}

pub fn adds(log_files: &[Add]) -> Vec<String> {
    log_files.iter().map(Add::file_path).collect()
}
