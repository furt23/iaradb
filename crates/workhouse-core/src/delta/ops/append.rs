//! Appending: new files in a commit that removes nothing. The rows are
//! conformed to the table's schema by column name; with `merge_schema`
//! columns the table lacks are added to it (nullable) in the same commit.

use super::{WriteArgs, WriteSummary, check_writable, merged_schema, new_metadata, now_ms, partition_by_param, protocol_upgrade, table_partitioning};
use crate::delta::actions::Action;
use crate::delta::log_store::LogStore;
use crate::delta::snapshot::Snapshot;
use crate::delta::txn::Transaction;
use crate::delta::write_files::{delta_schema, write_data_files};
use crate::error::Result;

/// Append the rows of `args.lf` to the table, which is at `snapshot`.
pub fn append(args: &WriteArgs, log: &LogStore, snapshot: &Snapshot) -> Result<WriteSummary> {
    check_writable(snapshot)?;
    let partition_by = table_partitioning(snapshot, args.partition_by, "append keeps the partitioning of the table")?;
    let query = delta_schema(args.lf.schema().arrow_schema());
    let (target, changed) = if args.merge_schema {
        let merged = merged_schema(&snapshot.schema, &query)?;
        let changed = merged.fields().len() != snapshot.schema.fields().len();
        (merged, changed)
    } else {
        (snapshot.schema.clone(), false)
    };
    let mut data = write_data_files(args.lf, args.location, args.storage, &partition_by, &target)?;
    if data.adds.is_empty() && !changed {
        return Ok(WriteSummary { version: snapshot.version, files: 0, rows: 0, skipped: true });
    }
    let mut txn = Transaction::new(Some(snapshot.version), "WRITE")
        .blind_append(true)
        .parameter("mode", "Append")
        .parameter("partitionBy", partition_by_param(&partition_by))
        .metric("numOutputRows", data.rows as i64);
    if changed {
        if let Some(p) = protocol_upgrade(&snapshot.protocol, &target) {
            txn.push(Action::Protocol(p));
        }
        txn.push(Action::Metadata(new_metadata(&target, &partition_by, Some(&snapshot.metadata), now_ms())?));
    }
    txn.extend(data.adds.iter().cloned().map(Action::Add));
    let version = txn.commit(log)?;
    data.keep();
    Ok(WriteSummary { version, files: data.adds.len(), rows: data.rows, skipped: false })
}
