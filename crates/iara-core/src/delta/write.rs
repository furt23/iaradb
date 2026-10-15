//! Writing a query to a Delta table: [`write_table`] picks the operation
//! (`ops/`) from the write mode and whether the table exists.

use super::log_store::LogStore;
use super::ops::{self, WriteArgs, WriteSummary, table_exists};
use super::snapshot::Snapshot;
use crate::error::{Result, WhError};
use crate::io::options::StorageOptions;
use crate::session::LazyFrame;

/// What to do with the rows, given what the location holds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    /// `CREATE TABLE AS`: a new table; an error if one exists
    Create,
    /// a new table, or more rows for the existing one
    Append,
    /// a new table, or the rows replace the contents of the existing one (its schema and partitioning stay)
    Overwrite,
    /// `CREATE OR REPLACE`: a new table, or the existing one gets the schema, partitioning and rows of the query
    Replace,
    /// a new table; an error if one exists (the dataframe writers' `error` mode)
    ErrorIfExists,
    /// a new table; nothing is written if one exists
    Ignore,
}

impl WriteMode {
    /// A mode by its name in the dataframe APIs: `error`, `append`, `overwrite`, `ignore`
    /// (also `create` and `replace`).
    pub fn parse(s: &str) -> Result<WriteMode> {
        Ok(match s.to_ascii_lowercase().as_str() {
            "error" | "errorifexists" | "error_if_exists" => WriteMode::ErrorIfExists,
            "append" => WriteMode::Append,
            "overwrite" => WriteMode::Overwrite,
            "ignore" => WriteMode::Ignore,
            "create" => WriteMode::Create,
            "replace" => WriteMode::Replace,
            other => return Err(WhError::Plan(format!("unknown write mode '{other}' (expected error, append, overwrite or ignore)"))),
        })
    }
}

/// Write the rows of `lf` to the Delta table at `location` (a directory or
/// object store URL); returns the table's new version. The data files are
/// written first and added by one commit: a failing query leaves the table as
/// it was. `merge_schema` lets an append or overwrite add the query's new
/// columns to the table.
pub fn write_table(
    lf: &LazyFrame,
    location: &str,
    storage: &StorageOptions,
    mode: WriteMode,
    partition_by: &[String],
    merge_schema: bool,
) -> Result<WriteSummary> {
    let log = LogStore::open(location, storage)?;
    let args = WriteArgs { lf, location, storage, partition_by, merge_schema };
    if !table_exists(&log)? {
        return ops::create::create(&args);
    }
    let exists = || WhError::Plan(format!("a Delta table already exists at {location}: use mode append or overwrite"));
    match mode {
        WriteMode::Create | WriteMode::ErrorIfExists => Err(exists()),
        WriteMode::Ignore => Ok(WriteSummary { version: Snapshot::load(&log, None)?.version, files: 0, rows: 0, skipped: true }),
        WriteMode::Append => ops::append::append(&args, &log, &Snapshot::load(&log, None)?),
        WriteMode::Overwrite => ops::overwrite::overwrite(&args, &log, &Snapshot::load(&log, None)?),
        WriteMode::Replace => ops::replace::replace(&args, &log, &Snapshot::load(&log, None)?),
    }
}
