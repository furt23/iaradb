//! Statements on tables that may be Delta: `INSERT` (append or overwrite),
//! `TRUNCATE TABLE` and `DROP TABLE` (which deletes the folder of a managed
//! Delta table).
//!
//! A table is *managed* when it is registered at the folder `CREATE TABLE`
//! would give its name in the warehouse (or its schema's location) and is a
//! Delta table; any other table is external and `DROP TABLE` only unregisters it.

use super::create::table_folder;
use super::write::{drop_replaced, missing, summary_with};
use crate::catalog_names::{TableName, TableRef};
use crate::delta::{DeltaTable, WriteMode, write_table};
use crate::error::{Result, WhError};
use crate::expr::Expr;
use crate::io::dataset;
use crate::io::parquet::{ParquetOptions, new_file_name};
use crate::session::{LazyFrame, SessionContext, TableEntry};

/// `INSERT [INTO | OVERWRITE] t [(columns)] query` into a Delta table: one
/// atomic commit (an append, or an overwrite of every row).
pub(super) fn insert(ctx: &SessionContext, key: &str, shown: &str, table: &DeltaTable, columns: &[String], overwrite: bool, lf: LazyFrame) -> Result<LazyFrame> {
    use crate::io::TableProvider;
    let schema = table.schema();
    let given: Vec<String> = if columns.is_empty() { schema.fields().iter().map(|f| f.name().clone()).collect() } else { columns.to_vec() };
    let query = lf.schema().fields().to_vec();
    if given.len() != query.len() {
        return Err(WhError::Plan(format!("the query gives {} columns for {} table columns", query.len(), given.len())));
    }
    let mut exprs = vec![];
    for (g, f) in given.iter().zip(&query) {
        let col = schema.fields().iter().find(|c| c.name().eq_ignore_ascii_case(g)).ok_or_else(|| WhError::Plan(format!("the table has no column '{g}'")))?;
        exprs.push(Expr::Column(f.column()).alias(col.name().clone()));
    }
    let lf = lf.select(exprs)?;
    let mode = if overwrite { WriteMode::Overwrite } else { WriteMode::Append };
    let done = write_table(&lf, table.root(), table.storage(), mode, &[], false)?;
    // the registered table must see the new version
    ctx.register_delta(key, table.root(), table.storage(), None, false)?;
    let op = if overwrite { "insert overwrite" } else { "insert" };
    summary_with(ctx, op, Some(shown), Some(table.root()), done.rows as usize, Some("delta"), Some(done.version))
}

/// `TRUNCATE TABLE name`: every row goes. Delta: one commit (the history stays);
/// Parquet folder: its files are deleted once an empty one is written.
pub(super) fn truncate(ctx: &SessionContext, name: &str) -> Result<LazyFrame> {
    let r = TableRef::strict(name)?;
    let target = ctx.resolve_table(&r).ok_or_else(|| missing(ctx, &r, name))?;
    let (key, shown) = (target.key(), target.display());
    let provider = match ctx.lookup(&key)? {
        Some(TableEntry::Table(t)) => t,
        Some(TableEntry::View(_)) => return Err(WhError::Plan(format!("'{shown}' is a view: rows are in tables"))),
        None => return Err(WhError::Plan(format!("table '{shown}' not found"))),
    };
    let schema = provider.schema();
    let before = provider.num_rows().unwrap_or(0);
    let empty = ctx.from_batches(schema.clone(), vec![])?;
    if let Some(d) = provider.as_delta() {
        let done = write_table(&empty, d.root(), d.storage(), WriteMode::Overwrite, &[], false)?;
        ctx.register_delta(&key, d.root(), d.storage(), None, false)?;
        return summary_with(ctx, "truncate", Some(&shown), Some(d.root()), before, Some("delta"), Some(done.version));
    }
    if let Some(loc) = provider.location() {
        let old = dataset::list_files(&loc.path, &loc.storage)?;
        if loc.partition_by.is_empty() {
            let dest = dataset::join(&loc.path, &new_file_name());
            empty.sink_parquet_files(&dest, &ParquetOptions::default(), &loc.storage)?;
            drop_replaced(&loc.path, &old, &loc.storage)?;
            ctx.register_parquet_with(&key, &loc.path, &loc.storage, false)?;
        } else {
            // no partition, no file: the table stays in memory, empty
            ctx.deregister(&key);
            drop_replaced(&loc.path, &old, &loc.storage)?;
            ctx.register_batches(&key, schema, vec![]);
        }
        return summary_with(ctx, "truncate", Some(&shown), Some(&loc.path), before, Some("parquet"), None);
    }
    if provider.memory_batches().is_some() {
        ctx.register_batches(&key, schema, vec![]);
        return summary_with(ctx, "truncate", Some(&shown), None, before, Some("memory"), None);
    }
    Err(WhError::NotSupported(format!("cannot truncate '{shown}' (a {} table)", provider.kind())))
}

fn same_place(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.replace('\\', "/").trim_end_matches('/').to_string();
    norm(a) == norm(b)
}

/// The folder of a managed Delta table (see the module doc).
fn managed_folder(ctx: &SessionContext, target: &TableName) -> Option<(String, crate::io::StorageOptions)> {
    let (location, storage) = table_folder(ctx, target)?;
    let Ok(Some(TableEntry::Table(t))) = ctx.lookup(&target.key()) else { return None };
    same_place(t.as_delta()?.root(), &location).then_some((location, storage))
}

/// `DROP TABLE [IF EXISTS] name`: the table leaves the session. A managed
/// Delta table's folder (data and log) is deleted; the files of any other
/// table (external, or plain Parquet) stay.
pub(super) fn drop_table(ctx: &SessionContext, name: &str, if_exists: bool) -> Result<LazyFrame> {
    let r = TableRef::strict(name)?;
    match ctx.resolve_table(&r) {
        Some(target) => {
            let managed = managed_folder(ctx, &target);
            ctx.deregister(&target.key());
            let mut removed = None;
            if let Some((location, storage)) = managed {
                dataset::remove(&location, &storage)?;
                removed = Some(location);
            }
            summary_with(ctx, "drop", Some(&target.display()), removed.as_deref(), 0, None, None)
        }
        None if if_exists => summary_with(ctx, "drop", Some(name), None, 0, None, None),
        None => Err(missing(ctx, &r, name)),
    }
}
