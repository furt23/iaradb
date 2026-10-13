//! The actions of a Delta transaction log. A commit file holds one JSON
//! object per line, each with a single key naming the action
//! (`{"add": {...}}`). Keys this module does not know (`cdc`,
//! `domainMetadata`, ...) are skipped on read.

use std::collections::BTreeMap;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Map, Value};

use super::util::{percent_decode, percent_encode_path};
use crate::error::{Result, WhError};

/// Partition values by column; a null partition is `None`.
pub type PartitionValues = BTreeMap<String, Option<String>>;

fn skip_null_values<'de, D: Deserializer<'de>>(d: D) -> std::result::Result<BTreeMap<String, String>, D::Error> {
    let raw = Option::<BTreeMap<String, Option<String>>>::deserialize(d)?.unwrap_or_default();
    Ok(raw.into_iter().filter_map(|(k, v)| v.map(|v| (k, v))).collect())
}

fn null_as_default<'de, D: Deserializer<'de>, T: Deserialize<'de> + Default>(d: D) -> std::result::Result<T, D::Error> {
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Protocol {
    pub min_reader_version: i32,
    pub min_writer_version: i32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reader_features: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writer_features: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Format {
    pub provider: String,
    #[serde(default, deserialize_with = "skip_null_values")]
    pub options: BTreeMap<String, String>,
}

impl Default for Format {
    fn default() -> Self {
        Format { provider: "parquet".into(), options: BTreeMap::new() }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metadata {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default)]
    pub format: Format,
    /// the table schema as Delta schema JSON (see `schema_json`)
    pub schema_string: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub partition_columns: Vec<String>,
    #[serde(default, deserialize_with = "skip_null_values")]
    pub configuration: BTreeMap<String, String>,
    /// milliseconds since the epoch
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_time: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletionVector {
    /// `u` (relative path, UUID based), `i` (inline) or `p` (absolute path)
    pub storage_type: String,
    pub path_or_inline_dv: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub offset: Option<i32>,
    pub size_in_bytes: i32,
    pub cardinality: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Add {
    /// relative to the table root, URI encoded (see [`Add::file_path`]), or an absolute URI
    pub path: String,
    #[serde(default, deserialize_with = "null_as_default")]
    pub partition_values: PartitionValues,
    pub size: i64,
    /// milliseconds since the epoch
    pub modification_time: i64,
    pub data_change: bool,
    /// JSON text, see `stats`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<BTreeMap<String, Option<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletion_vector: Option<DeletionVector>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub base_row_id: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_row_commit_version: Option<i64>,
}

impl Add {
    /// An add of a file at `file_path` (a plain path, encoded here).
    pub fn new(file_path: &str, partition_values: PartitionValues, size: i64, modification_time: i64, stats: Option<String>) -> Add {
        Add {
            path: percent_encode_path(file_path),
            partition_values,
            size,
            modification_time,
            data_change: true,
            stats,
            tags: None,
            deletion_vector: None,
            base_row_id: None,
            default_row_commit_version: None,
        }
    }

    /// The path decoded: a relative path or an absolute URI.
    pub fn file_path(&self) -> String {
        percent_decode(&self.path)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Remove {
    pub path: String,
    /// milliseconds since the epoch
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletion_timestamp: Option<i64>,
    pub data_change: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extended_file_metadata: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub partition_values: Option<PartitionValues>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stats: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<BTreeMap<String, Option<String>>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deletion_vector: Option<DeletionVector>,
}

impl Remove {
    /// The removal of `add` (same encoded path, with the metadata other readers expect).
    pub fn of(add: &Add, deletion_timestamp: i64, data_change: bool) -> Remove {
        Remove {
            path: add.path.clone(),
            deletion_timestamp: Some(deletion_timestamp),
            data_change,
            extended_file_metadata: Some(true),
            partition_values: Some(add.partition_values.clone()),
            size: Some(add.size),
            stats: add.stats.clone(),
            tags: add.tags.clone(),
            deletion_vector: add.deletion_vector.clone(),
        }
    }

    pub fn file_path(&self) -> String {
        percent_decode(&self.path)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Txn {
    pub app_id: String,
    pub version: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_updated: Option<i64>,
}

/// Provenance of a commit. The spec leaves its content free, so this is the
/// JSON object itself with helpers for the fields writers agree on.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(transparent)]
pub struct CommitInfo(pub Map<String, Value>);

impl CommitInfo {
    /// `operation` (e.g. `WRITE`) at `timestamp` (milliseconds since the epoch).
    pub fn new(operation: &str, timestamp: i64) -> CommitInfo {
        let mut m = Map::new();
        m.insert("timestamp".into(), timestamp.into());
        m.insert("operation".into(), operation.into());
        CommitInfo(m)
    }

    pub fn set(mut self, key: &str, value: impl Into<Value>) -> CommitInfo {
        self.0.insert(key.to_string(), value.into());
        self
    }

    /// Parameters of the operation; delta-spark writes their values as JSON text.
    pub fn with_operation_parameters(self, params: Map<String, Value>) -> CommitInfo {
        self.set("operationParameters", Value::Object(params))
    }

    /// Metrics of the operation; by convention their values are strings.
    pub fn with_operation_metrics(self, metrics: &[(&str, i64)]) -> CommitInfo {
        let m = metrics.iter().map(|(k, v)| (k.to_string(), Value::String(v.to_string()))).collect();
        self.set("operationMetrics", Value::Object(m))
    }

    pub fn timestamp(&self) -> Option<i64> {
        self.0.get("timestamp").and_then(Value::as_i64)
    }

    pub fn operation(&self) -> Option<&str> {
        self.0.get("operation").and_then(Value::as_str)
    }

    pub fn operation_parameters(&self) -> Option<&Map<String, Value>> {
        self.0.get("operationParameters").and_then(Value::as_object)
    }

    pub fn operation_metrics(&self) -> Option<&Map<String, Value>> {
        self.0.get("operationMetrics").and_then(Value::as_object)
    }

    /// A metric as a number (written as a number or as a numeric string).
    pub fn metric(&self, name: &str) -> Option<i64> {
        match self.operation_metrics()?.get(name)? {
            Value::String(s) => s.parse().ok(),
            v => v.as_i64(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Action {
    Protocol(Protocol),
    Metadata(Metadata),
    Add(Add),
    Remove(Remove),
    CommitInfo(CommitInfo),
    Txn(Txn),
}

/// One line of a commit file: at most one of these keys is set.
#[derive(Deserialize)]
struct Line {
    protocol: Option<Protocol>,
    #[serde(rename = "metaData")]
    metadata: Option<Metadata>,
    add: Option<Add>,
    remove: Option<Remove>,
    #[serde(rename = "commitInfo")]
    commit_info: Option<CommitInfo>,
    txn: Option<Txn>,
}

impl Action {
    /// The action on one line; `None` for an action this module does not know.
    pub fn from_line(line: &str) -> Result<Option<Action>> {
        let l: Line = serde_json::from_str(line).map_err(|e| WhError::Execution(format!("invalid Delta log entry: {e}")))?;
        Ok(l.add
            .map(Action::Add)
            .or(l.remove.map(Action::Remove))
            .or(l.metadata.map(Action::Metadata))
            .or(l.protocol.map(Action::Protocol))
            .or(l.commit_info.map(Action::CommitInfo))
            .or(l.txn.map(Action::Txn)))
    }

    /// The action as a JSON line (without the newline).
    pub fn to_line(&self) -> String {
        let (key, body) = match self {
            Action::Protocol(a) => ("protocol", serde_json::to_string(a)),
            Action::Metadata(a) => ("metaData", serde_json::to_string(a)),
            Action::Add(a) => ("add", serde_json::to_string(a)),
            Action::Remove(a) => ("remove", serde_json::to_string(a)),
            Action::CommitInfo(a) => ("commitInfo", serde_json::to_string(a)),
            Action::Txn(a) => ("txn", serde_json::to_string(a)),
        };
        format!("{{\"{key}\":{}}}", body.expect("actions serialize to JSON"))
    }
}

/// The actions of a commit file (newline-delimited JSON; blank lines and
/// unknown actions are skipped).
pub fn parse_commit(bytes: &[u8]) -> Result<Vec<Action>> {
    let text = std::str::from_utf8(bytes).map_err(|e| WhError::Execution(format!("Delta log entry is not UTF-8: {e}")))?;
    let mut actions = Vec::new();
    for line in text.lines().map(str::trim).filter(|l| !l.is_empty()) {
        actions.extend(Action::from_line(line)?);
    }
    Ok(actions)
}

/// The bytes of a commit file holding `actions`, one per line.
pub fn write_commit(actions: &[Action]) -> Vec<u8> {
    let mut out = String::new();
    for a in actions {
        out.push_str(&a.to_line());
        out.push('\n');
    }
    out.into_bytes()
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMMIT: &str = r#"{"commitInfo":{"timestamp":1700000000123,"operation":"WRITE","operationParameters":{"mode":"ErrorIfExists","partitionBy":"[]"},"clientVersion":"delta-rs.0.25.0"}}
{"protocol":{"minReaderVersion":1,"minWriterVersion":2}}
{"metaData":{"id":"5c0d2a0e-4c0e-4c8e-9a0e-2b8b0c7c1a11","name":null,"description":null,"format":{"provider":"parquet","options":{}},"schemaString":"{\"type\":\"struct\",\"fields\":[{\"name\":\"id\",\"type\":\"long\",\"nullable\":true,\"metadata\":{}}]}","partitionColumns":["year"],"createdTime":1700000000100,"configuration":{"delta.appendOnly":"true","x":null}}}
{"add":{"path":"year=2024/part-00000-1d2e%20x.snappy.parquet","partitionValues":{"year":"2024","m":null},"size":1234,"modificationTime":1700000000120,"dataChange":true,"stats":"{\"numRecords\":3,\"minValues\":{\"id\":1},\"maxValues\":{\"id\":3},\"nullCount\":{\"id\":0}}","tags":null}}
{"cdc":{"path":"_change_data/x.parquet","partitionValues":{},"size":1,"dataChange":false}}
{"domainMetadata":{"domain":"d","configuration":"{}","removed":false}}
{"remove":{"path":"old.parquet","deletionTimestamp":1700000000000,"dataChange":true}}
{"txn":{"appId":"app","version":4}}
"#;

    #[test]
    fn parses_a_delta_rs_style_commit() {
        let actions = parse_commit(COMMIT.as_bytes()).unwrap();
        assert_eq!(actions.len(), 6, "cdc and domainMetadata are skipped");
        let Action::CommitInfo(ci) = &actions[0] else { panic!() };
        assert_eq!((ci.timestamp(), ci.operation()), (Some(1700000000123), Some("WRITE")));
        assert_eq!(ci.operation_parameters().unwrap()["mode"], "ErrorIfExists");
        let Action::Protocol(p) = &actions[1] else { panic!() };
        assert_eq!((p.min_reader_version, p.min_writer_version, p.reader_features.is_none()), (1, 2, true));
        let Action::Metadata(m) = &actions[2] else { panic!() };
        assert_eq!(m.partition_columns, vec!["year"]);
        assert_eq!(m.configuration.len(), 1, "null values are dropped");
        assert!(m.schema_string.contains("\"long\""));
        let Action::Add(a) = &actions[3] else { panic!() };
        assert_eq!(a.file_path(), "year=2024/part-00000-1d2e x.snappy.parquet");
        assert_eq!(a.partition_values["year"].as_deref(), Some("2024"));
        assert_eq!(a.partition_values["m"], None);
        assert!(a.stats.as_deref().unwrap().contains("numRecords"));
        let Action::Remove(r) = &actions[4] else { panic!() };
        assert_eq!((r.deletion_timestamp, r.size), (Some(1700000000000), None));
        assert!(matches!(&actions[5], Action::Txn(t) if t.app_id == "app" && t.version == 4));
    }

    #[test]
    fn actions_round_trip() {
        let actions = parse_commit(COMMIT.as_bytes()).unwrap();
        let bytes = write_commit(&actions);
        assert_eq!(parse_commit(&bytes).unwrap(), actions);
        let text = String::from_utf8(bytes).unwrap();
        assert_eq!(text.lines().count(), 6);
        assert!(text.lines().all(|l| l.starts_with("{\"") && !l.contains('\n')));
        assert!(text.contains("\"metaData\":{") && text.contains("\"commitInfo\":{"));
    }

    #[test]
    fn built_actions_serialize_in_the_spec_shape() {
        let add = Add::new("a b/c.parquet", [("p".to_string(), None)].into(), 10, 5, None);
        assert_eq!(add.path, "a%20b/c.parquet");
        let line = Action::Add(add.clone()).to_line();
        assert_eq!(
            line,
            r#"{"add":{"path":"a%20b/c.parquet","partitionValues":{"p":null},"size":10,"modificationTime":5,"dataChange":true}}"#
        );
        let rm = Remove::of(&add, 99, true);
        assert_eq!(Action::from_line(&Action::Remove(rm.clone()).to_line()).unwrap(), Some(Action::Remove(rm)));
        let ci = CommitInfo::new("WRITE", 7).with_operation_metrics(&[("numFiles", 2)]);
        assert_eq!(ci.metric("numFiles"), Some(2));
        let p = Protocol { min_reader_version: 3, min_writer_version: 7, reader_features: Some(vec!["timestampNtz".into()]), writer_features: Some(vec!["timestampNtz".into()]) };
        assert!(Action::Protocol(p).to_line().contains("\"readerFeatures\":[\"timestampNtz\"]"));
    }

    #[test]
    fn unknown_and_empty_lines_are_tolerated() {
        assert!(parse_commit(b"\n{\"someFutureAction\":{\"x\":1}}\n\n").unwrap().is_empty());
        assert!(parse_commit(b"not json").is_err());
    }
}
