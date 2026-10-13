//! Delta Lake tables, implemented against the protocol directly (the
//! `deltalake` crates pin other Arrow versions). This is the foundation:
//! the actions of the transaction log and their JSON files (`actions`,
//! `names`), schemas as Delta schema strings (`schema_json`), per-file
//! statistics (`stats`, `stats_parquet`) and access to `_delta_log/` on disk
//! and in object stores (`log_store`).

pub mod actions;
pub mod checkpoint;
mod checkpoint_read;
mod checkpoint_write;
mod features;
pub mod log_store;
pub mod names;
pub mod ops;
pub mod provider;
pub mod schema_json;
pub mod snapshot;
pub mod stats;
mod stats_parquet;
#[cfg(test)]
mod test_support;
pub mod txn;
pub mod util;
pub mod write;
pub mod write_files;

pub use checkpoint::{CHECKPOINT_INTERVAL, read_checkpoint, should_checkpoint, write_checkpoint, write_checkpoint_parts};
pub use provider::{DeltaTable, VersionSpec, is_delta_table};
pub use snapshot::{Snapshot, latest_version};

pub use actions::{Action, Add, CommitInfo, DeletionVector, Format, Metadata, Protocol, Remove, Txn, parse_commit, write_commit};
pub use log_store::{LogFile, LogStore};
pub use names::{
    LAST_CHECKPOINT, LOG_DIR, LastCheckpoint, LogFileKind, checkpoint_file_name, commit_file_name, multipart_checkpoint_file_name,
    multipart_checkpoint_file_names, parse_file_name,
};
pub use schema_json::{protocol_for, schema_from_json, schema_to_json};
pub use ops::{WriteArgs, WriteSummary};
pub use ops::merge::MergeClause;
pub use ops::rewrite::DmlSummary;
pub use stats::FileStats;
pub use txn::Transaction;
pub use write::{WriteMode, write_table};
