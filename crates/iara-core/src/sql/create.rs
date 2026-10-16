//! `CREATE [OR REPLACE] TABLE`: from a query or from column definitions, as a
//! Delta table (the default) or plain Parquet files (`USING PARQUET`) in the
//! warehouse, or in memory when the session has no warehouse.

use arrow::datatypes::SchemaRef;

use super::Params;
use super::ddl::{ColumnSpec, schema_of};
use super::write::{drop_replaced, summary_with};
use crate::catalog_names::{MAIN, TableName, TableRef, unknown_schema};
use crate::delta::ops::{self, WriteArgs};
use crate::delta::write_files::delta_schema_declared;
use crate::delta::{LogStore, Snapshot, WriteMode, is_delta_table, write_table};
use crate::error::{Result, WhError};
use crate::io::StorageOptions;
use crate::io::dataset;
use crate::io::parquet::{ParquetOptions, new_file_name};
use crate::session::{LazyFrame, SessionContext};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Format {
    Delta,
    Parquet,
}

/// The format `USING` names; Delta when it is absent.
pub(super) fn format_of(using: Option<&str>) -> Result<Format> {
    match using {
        None | Some("delta") => Ok(Format::Delta),
        Some("parquet") => Ok(Format::Parquet),
        Some(other) => Err(WhError::Plan(format!("unknown table format '{other}' (expected DELTA or PARQUET)"))),
    }
}

/// What a created table holds.
pub(super) enum Source<'a> {
    Query(&'a str),
    Columns(&'a [ColumnSpec]),
}

/// Where `CREATE TABLE name` puts a table: `name`'s schema, else the current one,
/// which must exist.
pub(super) fn create_target(ctx: &SessionContext, name: &str) -> Result<TableName> {
    let target = TableRef::strict(name)?.in_schema(&ctx.current_schema());
    if !ctx.has_schema(&target.schema) {
        return Err(unknown_schema(&target.schema));
    }
    Ok(target)
}

/// A table's folder in the warehouse: `<root>/<table>` in `main`, `<root>/<schema>/<table>` elsewhere.
fn table_location(root: &str, name: &TableName) -> String {
    if name.schema == MAIN {
        return dataset::join(root, &name.table);
    }
    dataset::join(&dataset::join(root, &name.schema), &name.table)
}

/// Where a created table is written: under its schema's location if it has one, else the warehouse.
pub(super) fn table_folder(ctx: &SessionContext, name: &TableName) -> Option<(String, StorageOptions)> {
    if let Some((root, storage)) = ctx.schema_location(&name.schema) {
        return Some((dataset::join(&root, &name.table), storage));
    }
    ctx.warehouse().map(|(root, storage)| (table_location(&root, name), storage))
}

pub(super) struct CreateSpec<'a> {
    pub name: &'a str,
    pub replace: bool,
    pub if_not_exists: bool,
    pub partition_by: Vec<String>,
    pub using: Option<&'a str>,
    pub comment: Option<&'a str>,
}

pub(super) fn create_table(ctx: &SessionContext, spec: CreateSpec<'_>, source: Source<'_>, params: &Params) -> Result<LazyFrame> {
    let CreateSpec { name, replace, if_not_exists, partition_by, using, comment } = spec;
    let target = create_target(ctx, name)?;
    let (key, shown) = (target.key(), target.display());
    let format = format_of(using)?;
    if ctx.table_exists(&target) && !replace {
        if if_not_exists {
            return summary_with(ctx, "create", Some(&shown), None, 0, None, None);
        }
        return Err(WhError::Plan(format!("table '{shown}' already exists: use CREATE OR REPLACE TABLE to overwrite it")));
    }
    let (lf, declared) = match source {
        Source::Query(q) => (ctx.sql_with(q, params)?, None),
        Source::Columns(cols) => {
            let schema = schema_of(cols);
            (ctx.from_batches(schema.clone(), vec![])?, Some(schema))
        }
    };
    let Some((location, storage)) = table_folder(ctx, &target) else {
        if using.is_some() && format == Format::Delta {
            return Err(WhError::Plan("USING DELTA needs a warehouse: a folder or s3:// prefix where tables are written".into()));
        }
        if !partition_by.is_empty() {
            return Err(WhError::Plan("PARTITIONED BY needs a warehouse: a folder or s3:// prefix where tables are written".into()));
        }
        let (schema, batches) = lf.collect()?;
        let rows = batches.iter().map(|b| b.num_rows()).sum();
        ctx.register_batches(&key, schema, batches);
        return summary_with(ctx, "create", Some(&shown), None, rows, Some("memory"), None);
    };
    let existing_delta = is_delta_table(&location, &storage);
    if format == Format::Parquet && existing_delta {
        return Err(WhError::Plan(format!("'{location}' holds a Delta table: DROP it first, or create the table USING DELTA")));
    }
    if format == Format::Parquet && comment.is_some() {
        return Err(WhError::Plan("COMMENT is supported on Delta tables".into()));
    }
    let place = Place { ctx, key: &key, shown: &shown, location: &location, storage: &storage, replace };
    if format == Format::Delta {
        return place.delta(existing_delta, &partition_by, comment, &lf, declared);
    }
    place.parquet(partition_by, &lf)
}

/// A table being created at its folder.
struct Place<'a> {
    ctx: &'a SessionContext,
    key: &'a str,
    shown: &'a str,
    location: &'a str,
    storage: &'a StorageOptions,
    replace: bool,
}

impl Place<'_> {
    fn delta(&self, existing_delta: bool, partition_by: &[String], comment: Option<&str>, lf: &LazyFrame, declared: Option<SchemaRef>) -> Result<LazyFrame> {
        let (ctx, location, storage, replace) = (self.ctx, self.location, self.storage, self.replace);
        // plain Parquet files the folder holds (a legacy table being replaced) go once the Delta table is committed
        let mut old = vec![];
        if existing_delta {
            if !replace {
                return Err(WhError::Plan(format!("'{location}' already holds a Delta table: use CREATE OR REPLACE TABLE to overwrite it")));
            }
        } else if dataset::holds_data(location, storage)? {
            if !replace {
                return Err(WhError::Plan(format!("'{location}' already holds data: use CREATE OR REPLACE TABLE to overwrite it")));
            }
            old = dataset::list_files(location, storage)?;
        }
        let done = match (&declared, existing_delta) {
            (None, _) => {
                let mode = if replace { WriteMode::Replace } else { WriteMode::Create };
                write_table(lf, location, storage, mode, partition_by, false)?
            }
            (Some(schema), false) => ops::create::create_empty_with(location, storage, schema, partition_by, comment)?,
            (Some(schema), true) => {
                let log = LogStore::open(location, storage)?;
                let snapshot = Snapshot::load(&log, None)?;
                let args = WriteArgs { lf, location, storage, partition_by, merge_schema: false };
                ops::replace::replace_with_schema(&args, &log, &snapshot, &delta_schema_declared(schema), comment)?
            }
        };
        drop_replaced(location, &old, storage)?;
        ctx.register_delta(self.key, location, storage, None, false)?;
        summary_with(ctx, "create", Some(self.shown), Some(location), done.rows as usize, Some("delta"), Some(done.version))
    }

    fn parquet(&self, partition_by: Vec<String>, lf: &LazyFrame) -> Result<LazyFrame> {
        let (ctx, location, storage, key) = (self.ctx, self.location, self.storage, self.key);
        // the old files are listed now and deleted once the new ones are written: a query that fails loses nothing
        let mut old = vec![];
        if dataset::holds_data(location, storage)? {
            if !self.replace {
                return Err(WhError::Plan(format!("'{location}' already holds data: use CREATE OR REPLACE TABLE to overwrite it")));
            }
            old = dataset::list_files(location, storage)?;
        }
        let partitioned = !partition_by.is_empty();
        let dest = if partitioned { location.to_string() } else { dataset::join(location, &new_file_name()) };
        let opts = ParquetOptions { partition_by, ..Default::default() };
        let rows: usize = lf.sink_parquet_files(&dest, &opts, storage)?.iter().map(|f| f.rows as usize).sum();
        if !old.is_empty() {
            ctx.deregister(key);
            drop_replaced(location, &old, storage)?;
        }
        if rows == 0 && partitioned {
            // no partition, no file: an empty table, in memory, of the right shape
            let (schema, batches) = lf.limit(0).collect()?;
            ctx.register_batches(key, schema, batches);
        } else {
            ctx.register_parquet_with(key, location, storage, false)?;
        }
        summary_with(ctx, "create", Some(self.shown), Some(location), rows, Some("parquet"), None)
    }
}
