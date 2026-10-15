//! The history of a table (`DESCRIBE HISTORY`): the `commitInfo` of each
//! commit file the log still has, newest first. Versions whose commit file
//! was cleaned up (a checkpoint covers them) are not listed.

use std::collections::BTreeMap;
use std::sync::Arc;

use arrow::array::{ArrayRef, Int64Array, StringArray, TimestampMillisecondArray};
use arrow::datatypes::{DataType, Field, Schema, TimeUnit};
use arrow::record_batch::RecordBatch;
use serde_json::{Map, Value};

use crate::delta::actions::{Action, CommitInfo};
use crate::delta::log_store::LogStore;
use crate::delta::names::LogFileKind;
use crate::error::Result;
use crate::io::options::StorageOptions;

/// One commit of the table.
#[derive(Debug, Clone, PartialEq)]
pub struct HistoryEntry {
    pub version: u64,
    /// when it was committed, milliseconds since the epoch
    pub timestamp_ms: i64,
    pub operation: Option<String>,
    /// the operation's parameters; values are JSON text (strings as they are)
    pub operation_parameters: BTreeMap<String, String>,
    /// the operation's metrics; values are JSON text (strings as they are)
    pub operation_metrics: BTreeMap<String, String>,
    pub engine_info: Option<String>,
    pub is_blind_append: bool,
    pub user: Option<String>,
}

fn text_map(map: Option<&Map<String, Value>>) -> BTreeMap<String, String> {
    map.map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().map_or_else(|| v.to_string(), str::to_string))).collect()).unwrap_or_default()
}

fn text(info: &CommitInfo, key: &str) -> Option<String> {
    info.0.get(key).and_then(Value::as_str).map(str::to_string)
}

fn entry(version: u64, info: Option<CommitInfo>, file_time: Option<i64>) -> HistoryEntry {
    let info = info.unwrap_or_default();
    let timestamp_ms = info.0.get("inCommitTimestamp").and_then(Value::as_i64).or(info.timestamp()).or(file_time).unwrap_or(0);
    HistoryEntry {
        version,
        timestamp_ms,
        operation: info.operation().map(str::to_string),
        operation_parameters: text_map(info.operation_parameters()),
        operation_metrics: text_map(info.operation_metrics()),
        engine_info: text(&info, "engineInfo"),
        is_blind_append: info.0.get("isBlindAppend").and_then(Value::as_bool).unwrap_or(false),
        user: text(&info, "userName").or_else(|| text(&info, "userId")),
    }
}

/// The commits of the table at `location`, newest first, at most `limit`.
pub fn history(location: &str, storage: &StorageOptions, limit: Option<usize>) -> Result<Vec<HistoryEntry>> {
    let log = LogStore::open(location, storage)?;
    let mut commits: Vec<_> = log.list_from(0)?.into_iter().filter(|f| f.kind == LogFileKind::Commit).collect();
    commits.sort_by_key(|f| std::cmp::Reverse(f.version));
    commits.truncate(limit.unwrap_or(usize::MAX));
    commits
        .iter()
        .map(|f| {
            let bytes = log.read(&f.name)?;
            let text = String::from_utf8_lossy(&bytes);
            let info = text
                .lines()
                .filter(|l| l.contains("\"commitInfo\""))
                .find_map(|l| match Action::from_line(l.trim()) {
                    Ok(Some(Action::CommitInfo(c))) => Some(c),
                    _ => None,
                });
            Ok(entry(f.version, info, f.modified))
        })
        .collect()
}

fn json_text(map: &BTreeMap<String, String>) -> String {
    serde_json::to_string(map).unwrap_or_else(|_| "{}".into())
}

/// The columns of [`history_batch`].
pub fn history_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("version", DataType::Int64, false),
        Field::new("timestamp", DataType::Timestamp(TimeUnit::Millisecond, Some("UTC".into())), false),
        Field::new("operation", DataType::Utf8, true),
        Field::new("operation_parameters", DataType::Utf8, false),
        Field::new("operation_metrics", DataType::Utf8, false),
        Field::new("engine_info", DataType::Utf8, true),
    ]))
}

/// The entries as a table: `version`, `timestamp` (UTC), `operation`,
/// `operation_parameters` and `operation_metrics` (JSON objects as text), `engine_info`.
pub fn history_entries_batch(entries: &[HistoryEntry]) -> Result<RecordBatch> {
    let columns: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(entries.iter().map(|e| e.version as i64).collect::<Vec<_>>())),
        Arc::new(TimestampMillisecondArray::from(entries.iter().map(|e| e.timestamp_ms).collect::<Vec<_>>()).with_timezone("UTC")),
        Arc::new(StringArray::from(entries.iter().map(|e| e.operation.clone()).collect::<Vec<_>>())),
        Arc::new(StringArray::from(entries.iter().map(|e| json_text(&e.operation_parameters)).collect::<Vec<_>>())),
        Arc::new(StringArray::from(entries.iter().map(|e| json_text(&e.operation_metrics)).collect::<Vec<_>>())),
        Arc::new(StringArray::from(entries.iter().map(|e| e.engine_info.clone()).collect::<Vec<_>>())),
    ];
    Ok(RecordBatch::try_new(history_schema(), columns)?)
}

/// [`history`] as a result table.
pub fn history_batch(location: &str, storage: &StorageOptions, limit: Option<usize>) -> Result<RecordBatch> {
    history_entries_batch(&history(location, storage, limit)?)
}
