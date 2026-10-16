//! `CREATE OR REPLACE`: the table keeps its id and history, gets the schema
//! and partitioning of the query, and the files of its new data replace all
//! the old ones, in one commit.

use arrow::datatypes::SchemaRef;

use super::{WriteArgs, WriteSummary, check_not_append_only, check_writable, new_metadata, now_ms, partition_by_param, protocol_upgrade, remove_all};
use crate::delta::actions::Action;
use crate::delta::log_store::LogStore;
use crate::delta::snapshot::Snapshot;
use crate::delta::txn::Transaction;
use crate::delta::write_files::{check_partition_columns, delta_schema, write_data_files};
use crate::error::Result;

/// Replace the table, which is at `snapshot`, by the query's rows, schema and `args.partition_by`.
pub fn replace(args: &WriteArgs, log: &LogStore, snapshot: &Snapshot) -> Result<WriteSummary> {
    replace_with_schema(args, log, snapshot, &delta_schema(args.lf.schema().arrow_schema()), None)
}

/// [`replace`] with a declared schema (its `NOT NULL` columns kept) instead of the query's:
/// the rows of `args.lf` are conformed to it. `CREATE OR REPLACE TABLE t (cols) COMMENT '..'`
/// (a `description` replaces the table's).
pub fn replace_with_schema(args: &WriteArgs, log: &LogStore, snapshot: &Snapshot, schema: &SchemaRef, description: Option<&str>) -> Result<WriteSummary> {
    check_writable(snapshot)?;
    check_not_append_only(snapshot)?;
    check_partition_columns(schema, args.partition_by)?;
    let mut data = write_data_files(args.lf, args.location, args.storage, args.partition_by, schema)?;
    let now = now_ms();
    let mut metadata = new_metadata(schema, args.partition_by, Some(&snapshot.metadata), now)?;
    metadata.configuration.clear();
    if let Some(d) = description {
        metadata.description = Some(d.to_string());
    }
    let mut txn = Transaction::new(Some(snapshot.version), "REPLACE TABLE AS SELECT")
        .reads_table(true)
        .parameter("partitionBy", partition_by_param(args.partition_by))
        .metric("numOutputRows", data.rows as i64);
    if let Some(p) = protocol_upgrade(&snapshot.protocol, schema) {
        txn.push(Action::Protocol(p));
    }
    txn.push(Action::Metadata(metadata));
    txn.extend(remove_all(snapshot, now).into_iter().map(Action::Remove));
    txn.extend(data.adds.iter().cloned().map(Action::Add));
    let version = txn.commit(log)?;
    data.keep();
    Ok(WriteSummary { version, files: data.adds.len(), rows: data.rows, skipped: false })
}
