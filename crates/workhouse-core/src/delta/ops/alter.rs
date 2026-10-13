//! `ALTER TABLE`: changes of a table's metadata, each one `metaData` action
//! in a commit and no data file touched. Files written before a new column
//! existed read it as NULL.

use std::collections::BTreeMap;

use arrow::datatypes::{Field, Schema};
use serde_json::{Value, json};

use super::{check_writable, new_metadata, now_ms, protocol_upgrade};
use crate::delta::actions::{Action, Metadata, Protocol};
use crate::delta::log_store::LogStore;
use crate::delta::schema_json::schema_to_json;
use crate::delta::snapshot::Snapshot;
use crate::delta::txn::Transaction;
use crate::delta::write_files::delta_type;
use crate::error::{Result, WhError};
use crate::io::options::StorageOptions;

/// Commit the metadata (and protocol) `change` computes from the newest version
/// as `operation`; `None` means nothing changes (no commit). Returns the table's
/// version after it. Another commit that changed the metadata meanwhile is a conflict.
fn alter(
    location: &str,
    storage: &StorageOptions,
    operation: &str,
    change: impl FnOnce(&Snapshot) -> Result<Option<(Metadata, Option<Protocol>, Vec<(&'static str, Value)>)>>,
) -> Result<u64> {
    let log = LogStore::open(location, storage)?;
    let snapshot = Snapshot::load(&log, None)?;
    check_writable(&snapshot)?;
    let Some((metadata, protocol, parameters)) = change(&snapshot)? else { return Ok(snapshot.version) };
    let mut txn = Transaction::new(Some(snapshot.version), operation);
    for (k, v) in parameters {
        txn = txn.parameter(k, v);
    }
    if let Some(p) = protocol {
        txn.push(Action::Protocol(p));
    }
    txn.push(Action::Metadata(metadata));
    txn.commit(&log)
}

/// Add columns at the end of the table's schema; they are nullable whatever
/// the fields say. Returns the table's new version.
pub fn add_columns(location: &str, storage: &StorageOptions, columns: Vec<Field>) -> Result<u64> {
    if columns.is_empty() {
        return Err(WhError::Plan("ADD COLUMNS: no columns to add".into()));
    }
    alter(location, storage, "ADD COLUMNS", |snapshot| {
        let mut fields: Vec<Field> = snapshot.schema.fields().iter().map(|f| f.as_ref().clone()).collect();
        let mut added = vec![];
        for c in &columns {
            if fields.iter().any(|f| f.name().eq_ignore_ascii_case(c.name())) {
                return Err(WhError::Plan(format!("ADD COLUMNS: the table already has a column '{}'", c.name())));
            }
            let field = Field::new(c.name(), delta_type(c.data_type()), true).with_metadata(c.metadata().clone());
            added.push(field.clone());
            fields.push(field);
        }
        let schema = Schema::new(fields);
        let listed: Value = serde_json::from_str(&schema_to_json(&Schema::new(added))?).map_err(|e| WhError::Execution(e.to_string()))?;
        let params = listed["fields"].as_array().map(|f| f.iter().map(|c| json!({"column": c})).collect::<Vec<_>>()).unwrap_or_default();
        let metadata = new_metadata(&schema, &snapshot.partition_columns, Some(&snapshot.metadata), now_ms())?;
        Ok(Some((metadata, protocol_upgrade(&snapshot.protocol, &schema), vec![("columns", Value::String(Value::Array(params).to_string()))])))
    })
}

/// Rename a column. Delta tables name their columns in the Parquet files, so a
/// rename needs column mapping (`delta.columnMapping.mode = 'name'`), which this
/// engine does not implement: always an error.
pub fn rename_column(location: &str, storage: &StorageOptions, from: &str, to: &str) -> Result<u64> {
    let log = LogStore::open(location, storage)?;
    let snapshot = Snapshot::load(&log, None)?;
    if snapshot.schema.field_with_name(from).is_err() {
        return Err(WhError::ColumnNotFound(from.to_string()));
    }
    Err(WhError::NotSupported(format!(
        "RENAME COLUMN {from} TO {to}: Delta stores the column names in its data files, so a rename needs column mapping (delta.columnMapping.mode = 'name'), which is not supported"
    )))
}

fn properties_json(properties: &BTreeMap<String, String>) -> Value {
    Value::String(serde_json::to_string(properties).unwrap_or_else(|_| "{}".into()))
}

/// Set table properties (`TBLPROPERTIES`) in the configuration of the table.
/// Returns the table's new version (the current one if nothing changes).
pub fn set_properties(location: &str, storage: &StorageOptions, properties: &BTreeMap<String, String>) -> Result<u64> {
    if properties.is_empty() {
        return Err(WhError::Plan("SET TBLPROPERTIES: no properties given".into()));
    }
    if properties.keys().any(|k| k.trim().is_empty()) {
        return Err(WhError::Plan("SET TBLPROPERTIES: a property name is empty".into()));
    }
    alter(location, storage, "SET TBLPROPERTIES", |snapshot| {
        let mut metadata = snapshot.metadata.clone();
        metadata.configuration.extend(properties.clone());
        if metadata == snapshot.metadata {
            return Ok(None);
        }
        Ok(Some((metadata, None, vec![("properties", properties_json(properties))])))
    })
}

/// Remove table properties; with `if_exists` unknown names are ignored, else an error.
pub fn unset_properties(location: &str, storage: &StorageOptions, keys: &[String], if_exists: bool) -> Result<u64> {
    alter(location, storage, "UNSET TBLPROPERTIES", |snapshot| {
        let mut metadata = snapshot.metadata.clone();
        for k in keys {
            if metadata.configuration.remove(k).is_none() && !if_exists {
                return Err(WhError::Plan(format!("UNSET TBLPROPERTIES: the table has no property '{k}'")));
            }
        }
        if metadata == snapshot.metadata {
            return Ok(None);
        }
        Ok(Some((metadata, None, vec![("properties", Value::String(serde_json::to_string(keys).unwrap_or_else(|_| "[]".into()))), ("ifExists", Value::Bool(if_exists))])))
    })
}

/// Set (or with `None` clear) the table's description.
pub fn set_comment(location: &str, storage: &StorageOptions, comment: Option<&str>) -> Result<u64> {
    alter(location, storage, "CHANGE COMMENT", |snapshot| {
        let mut metadata = snapshot.metadata.clone();
        metadata.description = comment.map(str::to_string);
        if metadata == snapshot.metadata {
            return Ok(None);
        }
        Ok(Some((metadata, None, vec![("description", comment.map_or(Value::Null, |c| Value::String(c.to_string())))])))
    })
}
