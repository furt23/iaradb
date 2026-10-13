//! Overwriting: one commit removes every file the table holds and adds the
//! new ones, so readers see the old table or the new one. The removed files
//! stay on disk (time travel); partitioning and schema are the table's (with
//! `merge_schema`, plus the query's new columns). Replacing only some
//! partitions (`replaceWhere`) is not supported.

use super::{
    WriteArgs, WriteSummary, check_not_append_only, check_writable, merged_schema, new_metadata, now_ms, partition_by_param, protocol_upgrade, remove_all,
    table_partitioning,
};
use crate::delta::actions::Action;
use crate::delta::log_store::LogStore;
use crate::delta::snapshot::Snapshot;
use crate::delta::txn::Transaction;
use crate::delta::write_files::{delta_schema, write_data_files};
use crate::error::Result;

/// Replace the contents of the table, which is at `snapshot`, with the rows of `args.lf`.
pub fn overwrite(args: &WriteArgs, log: &LogStore, snapshot: &Snapshot) -> Result<WriteSummary> {
    check_writable(snapshot)?;
    check_not_append_only(snapshot)?;
    let partition_by = table_partitioning(snapshot, args.partition_by, "overwrite keeps the partitioning of the table (use replace to change it)")?;
    let query = delta_schema(args.lf.schema().arrow_schema());
    let (target, changed) = if args.merge_schema {
        let merged = merged_schema(&snapshot.schema, &query)?;
        let changed = merged.fields().len() != snapshot.schema.fields().len();
        (merged, changed)
    } else {
        (snapshot.schema.clone(), false)
    };
    let mut data = write_data_files(args.lf, args.location, args.storage, &partition_by, &target)?;
    let now = now_ms();
    let mut txn = Transaction::new(Some(snapshot.version), "WRITE")
        .reads_table(true)
        .parameter("mode", "Overwrite")
        .parameter("partitionBy", partition_by_param(&partition_by))
        .metric("numOutputRows", data.rows as i64);
    if changed {
        if let Some(p) = protocol_upgrade(&snapshot.protocol, &target) {
            txn.push(Action::Protocol(p));
        }
        txn.push(Action::Metadata(new_metadata(&target, &partition_by, Some(&snapshot.metadata), now)?));
    }
    txn.extend(remove_all(snapshot, now).into_iter().map(Action::Remove));
    txn.extend(data.adds.iter().cloned().map(Action::Add));
    let version = txn.commit(log)?;
    data.keep();
    Ok(WriteSummary { version, files: data.adds.len(), rows: data.rows, skipped: false })
}
