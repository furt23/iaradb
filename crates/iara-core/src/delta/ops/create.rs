//! Creating a table: commit 0 holds the protocol, the metadata and the
//! files of the first write.

use arrow::datatypes::Schema;

use super::{WriteArgs, WriteSummary, new_metadata, now_ms, partition_by_param, table_exists};
use crate::delta::actions::Action;
use crate::delta::log_store::LogStore;
use crate::delta::schema_json::protocol_for;
use crate::delta::txn::Transaction;
use crate::delta::write_files::{DataFiles, check_partition_columns, delta_schema, delta_schema_declared, write_data_files};
use crate::error::{Result, WhError};
use crate::io::options::StorageOptions;

/// Create the table at `args.location` with the schema of the query (every
/// column nullable) and its rows. The table must not exist: a table created
/// by another writer meanwhile makes the commit fail.
pub fn create(args: &WriteArgs) -> Result<WriteSummary> {
    let log = LogStore::open(args.location, args.storage)?;
    let schema = delta_schema(args.lf.schema().arrow_schema());
    check_partition_columns(&schema, args.partition_by)?;
    let mut data = write_data_files(args.lf, args.location, args.storage, args.partition_by, &schema)?;
    let version = commit_new(&log, &schema, args.partition_by, &mut data, "CREATE TABLE AS SELECT", None)?;
    Ok(WriteSummary { version, files: data.adds.len(), rows: data.rows, skipped: false })
}

/// Create an empty table of this schema.
pub fn create_empty(location: &str, storage: &StorageOptions, schema: &Schema, partition_by: &[String]) -> Result<WriteSummary> {
    create_empty_with(location, storage, schema, partition_by, None)
}

/// [`create_empty`] with a description (`COMMENT`) for the table. The schema's
/// nullability is kept: a column that is not nullable is `NOT NULL`, enforced by every write.
pub fn create_empty_with(location: &str, storage: &StorageOptions, schema: &Schema, partition_by: &[String], description: Option<&str>) -> Result<WriteSummary> {
    let log = LogStore::open(location, storage)?;
    if table_exists(&log)? {
        return Err(WhError::Plan(format!("a Delta table already exists at {}", log.table())));
    }
    let schema = delta_schema_declared(schema);
    check_partition_columns(&schema, partition_by)?;
    let mut data = DataFiles::empty(storage);
    let version = commit_new(&log, &schema, partition_by, &mut data, "CREATE TABLE", description)?;
    Ok(WriteSummary { version, files: 0, rows: 0, skipped: false })
}

/// Commit 0: protocol, metadata and the files of `data` (kept once committed).
fn commit_new(log: &LogStore, schema: &Schema, partition_by: &[String], data: &mut DataFiles, operation: &str, description: Option<&str>) -> Result<u64> {
    let now = now_ms();
    let mut txn = Transaction::new(None, operation)
        .parameter("mode", "ErrorIfExists")
        .parameter("partitionBy", partition_by_param(partition_by))
        .metric("numOutputRows", data.rows as i64);
    txn.push(Action::Protocol(protocol_for(schema)));
    let mut metadata = new_metadata(schema, partition_by, None, now)?;
    metadata.description = description.map(str::to_string);
    txn.push(Action::Metadata(metadata));
    txn.extend(data.adds.iter().cloned().map(Action::Add));
    let version = txn.commit(log)?;
    data.keep();
    Ok(version)
}
