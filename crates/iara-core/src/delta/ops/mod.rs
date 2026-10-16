//! The write operations on Delta tables, one per file: `create`, `append`,
//! `overwrite` and `replace`. Each writes the data files first, then commits
//! them in one transaction ([`super::txn::Transaction`]); data files of a
//! write that fails or loses the commit are deleted.

pub mod alter;
pub mod append;
pub mod create;
pub mod delete;
pub mod detail;
pub mod history;
pub mod merge;
pub mod optimize;
pub mod overwrite;
pub mod replace;
pub mod restore;
pub mod rewrite;
pub mod update;
pub mod vacuum;

use std::sync::Arc;

use arrow::datatypes::{Field, Schema, SchemaRef};

use super::actions::{Format, Metadata, Protocol, Remove};
use super::log_store::LogStore;
use super::names::LogFileKind;
use super::schema_json::{protocol_for, schema_to_json};
use super::snapshot::Snapshot;
use super::util::new_uuid;
use crate::error::{Result, WhError};
use crate::io::options::StorageOptions;
use crate::session::LazyFrame;

/// What a write is asked to do.
pub struct WriteArgs<'a> {
    pub lf: &'a LazyFrame,
    pub location: &'a str,
    pub storage: &'a StorageOptions,
    pub partition_by: &'a [String],
    /// add the query's new columns to the table schema (append and overwrite)
    pub merge_schema: bool,
}

/// What a write did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteSummary {
    /// the table's version after the write (the existing one if nothing was written)
    pub version: u64,
    /// data files added
    pub files: usize,
    pub rows: u64,
    /// the write was skipped (`Ignore` on an existing table, or an append of no rows)
    pub skipped: bool,
}

pub(crate) fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// Whether the location holds a Delta log.
pub fn table_exists(log: &LogStore) -> Result<bool> {
    Ok(log.list_from(0)?.iter().any(|f| matches!(f.kind, LogFileKind::Commit | LogFileKind::Checkpoint | LogFileKind::MultiPartCheckpoint { .. })))
}

/// Writer features this crate maintains.
const SUPPORTED_WRITER_FEATURES: &[&str] = &["timestampNtz", "appendOnly"];

/// Refuse to write a table whose protocol needs more than this crate implements.
pub(crate) fn check_writable(snapshot: &Snapshot) -> Result<()> {
    let p = &snapshot.protocol;
    match p.min_writer_version {
        v if v <= 2 => {}
        7 => {
            if let Some(f) = p.writer_features.iter().flatten().find(|f| !SUPPORTED_WRITER_FEATURES.contains(&f.as_str())) {
                return Err(WhError::NotSupported(format!("cannot write a Delta table that uses the writer feature '{f}'")));
            }
        }
        v => return Err(WhError::NotSupported(format!("cannot write a Delta table with writer protocol version {v} (supported: up to 2, and 7 with table features)"))),
    }
    Ok(())
}

/// Refuse to remove files from an append-only table.
pub(crate) fn check_not_append_only(snapshot: &Snapshot) -> Result<()> {
    if snapshot.metadata.configuration.get("delta.appendOnly").is_some_and(|v| v.eq_ignore_ascii_case("true")) {
        return Err(WhError::Plan("the table is append-only (delta.appendOnly): files cannot be removed".into()));
    }
    Ok(())
}

/// The partition columns of a write to an existing table: the table's own
/// (an empty request keeps them; a different one is an error).
pub(crate) fn table_partitioning(snapshot: &Snapshot, requested: &[String], what: &str) -> Result<Vec<String>> {
    let table = &snapshot.partition_columns;
    if !requested.is_empty() && !requested.iter().map(|c| c.to_ascii_lowercase()).eq(table.iter().map(|c| c.to_ascii_lowercase())) {
        return Err(WhError::Plan(format!("the table is partitioned by {table:?}, not {requested:?}: {what}")));
    }
    Ok(table.clone())
}

/// The table schema with the query's new columns added at the end (nullable);
/// the types of columns both have must be castable.
pub(crate) fn merged_schema(table: &Schema, query: &Schema) -> Result<SchemaRef> {
    let mut fields: Vec<Arc<Field>> = table.fields().iter().cloned().collect();
    for q in query.fields() {
        match table.fields().iter().find(|t| t.name().eq_ignore_ascii_case(q.name())) {
            Some(t) if !arrow::compute::can_cast_types(q.data_type(), t.data_type()) => {
                return Err(WhError::Plan(format!("column '{}': cannot write {} into a column of type {}", q.name(), q.data_type(), t.data_type())));
            }
            Some(_) => {}
            None => fields.push(Arc::new(Field::new(q.name(), q.data_type().clone(), true).with_metadata(q.metadata().clone()))),
        }
    }
    Ok(Arc::new(Schema::new(fields)))
}

/// The protocol action a table needs to hold `schema`, if its current one does not do.
pub(crate) fn protocol_upgrade(current: &Protocol, schema: &Schema) -> Option<Protocol> {
    let needed = protocol_for(schema);
    let features = needed.writer_features.clone().unwrap_or_default();
    if features.is_empty() {
        return None;
    }
    if current.min_writer_version < 7 || current.min_reader_version < 3 {
        return Some(needed);
    }
    let with = |have: &Option<Vec<String>>| {
        let mut all = have.clone().unwrap_or_default();
        let before = all.len();
        let missing: Vec<String> = features.iter().filter(|f| !all.contains(f)).cloned().collect();
        all.extend(missing);
        (all.len() != before).then_some(all)
    };
    let (readers, writers) = (with(&current.reader_features), with(&current.writer_features));
    if readers.is_none() && writers.is_none() {
        return None;
    }
    Some(Protocol {
        min_reader_version: current.min_reader_version,
        min_writer_version: current.min_writer_version,
        reader_features: readers.or_else(|| current.reader_features.clone()),
        writer_features: writers.or_else(|| current.writer_features.clone()),
    })
}

/// The `metaData` of a new table (or of a table whose schema or layout changes:
/// keep the `id` and creation time of the old one).
pub(crate) fn new_metadata(schema: &Schema, partition_by: &[String], old: Option<&Metadata>, now: i64) -> Result<Metadata> {
    Ok(Metadata {
        id: old.map_or_else(new_uuid, |m| m.id.clone()),
        name: old.and_then(|m| m.name.clone()),
        description: old.and_then(|m| m.description.clone()),
        format: Format::default(),
        schema_string: schema_to_json(schema)?,
        partition_columns: partition_by.to_vec(),
        configuration: old.map(|m| m.configuration.clone()).unwrap_or_default(),
        created_time: old.and_then(|m| m.created_time).or(Some(now)),
    })
}

/// The `partitionBy` operation parameter: a JSON list as text.
pub(crate) fn partition_by_param(partition_by: &[String]) -> String {
    serde_json::to_string(partition_by).unwrap_or_else(|_| "[]".into())
}

/// Removals of all the files of the snapshot.
pub(crate) fn remove_all(snapshot: &Snapshot, now: i64) -> Vec<Remove> {
    snapshot.files.iter().map(|a| Remove::of(a, now, true)).collect()
}
