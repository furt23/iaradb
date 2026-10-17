//! Statements on Delta tables that do not change rows, and the result shape the
//! Delta statements share.
//!
//! ```sql
//! DESCRIBE HISTORY t [LIMIT n]      DESCRIBE DETAIL t
//! OPTIMIZE t [WHERE partition_pred]
//! VACUUM t [RETAIN n HOURS] [DRY RUN] [FORCE]
//! RESTORE [TABLE] t TO VERSION AS OF n | TIMESTAMP AS OF '...'
//! ALTER TABLE t ADD COLUMN[S] (c type, ...) | ADD COLUMN c type
//! ALTER TABLE t RENAME COLUMN a TO b            -- not supported: says so
//! ALTER TABLE t SET TBLPROPERTIES ('k' = 'v', ...)
//! ALTER TABLE t UNSET TBLPROPERTIES [IF EXISTS] ('k', ...)
//! COMMENT ON TABLE t IS '...' | NULL
//! ```
//!
//! `VACUUM ... RETAIN n HOURS` with n under 168 is refused unless `FORCE` ends the statement
//! (it can break time travel and readers still on an older version).
//! History and detail are queries' results (frames to read); the others return the one row of
//! [`report`]: `operation, table, path, rows, format, version`, counters, `detail`.

use std::collections::BTreeMap;
use std::sync::Arc;

use arrow::array::{ArrayRef, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;

use super::command::{Maintenance, RestoreTo};
use super::timetravel::timestamp_millis;
use super::write::missing;
use super::{Params, dml};
use crate::catalog_names::{TableName, TableRef};
use crate::delta::ops::{alter, detail, history, optimize, restore, vacuum};
use crate::delta::{DeltaTable, VersionSpec};
use crate::error::{Result, WhError};
use crate::io::TableProvider;
use crate::logical::LogicalPlan;
use crate::schema::PlanSchemaRef;
use crate::session::{LazyFrame, SessionContext, TableEntry};

/// A registered Delta table a statement acts on.
pub(super) struct DeltaRef {
    pub name: TableName,
    pub shown: String,
    pub provider: Arc<dyn TableProvider>,
}

impl DeltaRef {
    pub fn delta(&self) -> &DeltaTable {
        self.provider.as_delta().expect("checked by delta_table")
    }

    /// The table's columns as a query names them, qualified by `alias`.
    pub fn scope(&self, alias: &str) -> Result<PlanSchemaRef> {
        let plan = LogicalPlan::scan(&self.name.table, Some(alias.to_string()), self.provider.clone(), None, vec![], None)?;
        Ok(plan.schema().clone())
    }
}

/// The Delta table `name` refers to; `what` is the error for any other table.
pub(super) fn delta_table(ctx: &SessionContext, name: &str, what: &str) -> Result<DeltaRef> {
    let r = TableRef::strict(name)?;
    let target = ctx.resolve_table(&r).ok_or_else(|| missing(ctx, &r, name))?;
    let shown = ctx.display_name(&target);
    match ctx.entry(&target)? {
        Some(TableEntry::Table(t)) if t.as_delta().is_some() => Ok(DeltaRef { name: target, shown, provider: t }),
        Some(TableEntry::Table(t)) => Err(WhError::NotSupported(format!("{what}: '{shown}' is a {} table", t.kind()))),
        Some(TableEntry::View(_)) => Err(WhError::Plan(format!("{what}: '{shown}' is a view"))),
        None => Err(WhError::Plan(format!("table '{shown}' not found"))),
    }
}

/// The registered table must see the version the statement committed.
pub(super) fn refresh(ctx: &SessionContext, t: &DeltaRef) -> Result<()> {
    let d = t.delta();
    ctx.put_delta(&t.name, d.root(), d.storage())
}

/// The one-row result of a statement on a Delta table: the columns every write has, then `counters`
/// (integers) and a free `detail` text.
#[allow(clippy::too_many_arguments)]
pub(super) fn report(
    ctx: &SessionContext,
    operation: &str,
    table: &str,
    path: &str,
    rows: i64,
    version: Option<u64>,
    counters: &[(&str, i64)],
    detail: Option<String>,
) -> Result<LazyFrame> {
    let mut fields = vec![
        Field::new("operation", DataType::Utf8, false),
        Field::new("table", DataType::Utf8, true),
        Field::new("path", DataType::Utf8, true),
        Field::new("rows", DataType::Int64, false),
        Field::new("format", DataType::Utf8, true),
        Field::new("version", DataType::Int64, true),
    ];
    let mut columns: Vec<ArrayRef> = vec![
        Arc::new(StringArray::from(vec![operation])),
        Arc::new(StringArray::from(vec![table])),
        Arc::new(StringArray::from(vec![path])),
        Arc::new(Int64Array::from(vec![rows])),
        Arc::new(StringArray::from(vec!["delta"])),
        Arc::new(Int64Array::from(vec![version.map(|v| v as i64)])),
    ];
    for (name, n) in counters {
        fields.push(Field::new(*name, DataType::Int64, false));
        columns.push(Arc::new(Int64Array::from(vec![*n])));
    }
    fields.push(Field::new("detail", DataType::Utf8, true));
    columns.push(Arc::new(StringArray::from(vec![detail])));
    let schema = Arc::new(Schema::new(fields));
    ctx.from_batches(schema.clone(), vec![RecordBatch::try_new(schema, columns)?])
}

fn frame(ctx: &SessionContext, batch: RecordBatch) -> Result<LazyFrame> {
    ctx.from_batches(batch.schema(), vec![batch])
}

pub(super) fn run(ctx: &SessionContext, m: Maintenance, params: &Params) -> Result<LazyFrame> {
    use Maintenance::*;
    match m {
        History { name, limit } => {
            let t = delta_table(ctx, &name, "DESCRIBE HISTORY needs a Delta table")?;
            let d = t.delta();
            frame(ctx, history::history_batch(d.root(), d.storage(), limit)?)
        }
        Detail { name } => {
            let t = delta_table(ctx, &name, "DESCRIBE DETAIL needs a Delta table")?;
            let d = t.delta();
            frame(ctx, detail::detail_batch(d.root(), d.storage())?)
        }
        Optimize { name, predicate } => {
            let t = delta_table(ctx, &name, "OPTIMIZE needs a Delta table")?;
            let d = t.delta();
            let predicate = predicate.map(|x| dml::plan_plain_expr(ctx, params, &x, &t.provider.schema())).transpose()?;
            let done = optimize::optimize(ctx, d.root(), d.storage(), None, predicate.as_ref())?;
            refresh(ctx, &t)?;
            report(
                ctx,
                "optimize",
                &t.shown,
                d.root(),
                0,
                Some(done.version),
                &[
                    ("files_removed", done.files_removed as i64),
                    ("files_added", done.files_added as i64),
                    ("bytes_removed", done.bytes_removed as i64),
                    ("bytes_added", done.bytes_added as i64),
                    ("partitions_optimized", done.partitions_optimized as i64),
                ],
                None,
            )
        }
        Vacuum { name, retain_hours, dry_run, force } => {
            let t = delta_table(ctx, &name, "VACUUM needs a Delta table")?;
            let d = t.delta();
            let done = vacuum::vacuum(d.root(), d.storage(), retain_hours, dry_run, force)?;
            let listed: Vec<&String> = done.files.iter().take(10_000).collect();
            report(
                ctx,
                "vacuum",
                &t.shown,
                d.root(),
                done.files.len() as i64,
                None,
                &[("dry_run", dry_run as i64), ("bytes", done.bytes as i64)],
                Some(serde_json::to_string(&listed).unwrap_or_default()),
            )
        }
        Restore { name, to } => {
            let t = delta_table(ctx, &name, "RESTORE needs a Delta table")?;
            let d = t.delta();
            let spec = match to {
                RestoreTo::Version(v) => VersionSpec::Version(v),
                RestoreTo::Timestamp(text) => VersionSpec::Timestamp(timestamp_millis(&text)?),
            };
            let done = restore::restore(d.root(), d.storage(), spec)?;
            refresh(ctx, &t)?;
            report(
                ctx,
                "restore",
                &t.shown,
                d.root(),
                0,
                Some(done.version),
                &[
                    ("restored_version", done.restored_version as i64),
                    ("files_removed", done.files_removed as i64),
                    ("files_restored", done.files_restored as i64),
                ],
                None,
            )
        }
        AddColumns { name, columns } => altered(ctx, &name, "ADD COLUMNS", |root, storage| {
            let fields = columns.iter().map(|c| Field::new(&c.name, c.data_type.clone(), true)).collect();
            alter::add_columns(root, storage, fields)
        }),
        RenameColumn { name, from, to } => altered(ctx, &name, "RENAME COLUMN", |root, storage| alter::rename_column(root, storage, &from, &to)),
        SetProperties { name, properties } => altered(ctx, &name, "SET TBLPROPERTIES", |root, storage| {
            let map: BTreeMap<String, String> = properties.iter().cloned().collect();
            alter::set_properties(root, storage, &map)
        }),
        UnsetProperties { name, keys, if_exists } => {
            altered(ctx, &name, "UNSET TBLPROPERTIES", |root, storage| alter::unset_properties(root, storage, &keys, if_exists))
        }
        Comment { name, comment } => altered(ctx, &name, "COMMENT ON TABLE", |root, storage| alter::set_comment(root, storage, comment.as_deref())),
    }
}

/// An `ALTER`: run `change` on the table's folder (it returns the new version), re-register the table
/// (its schema may differ now) and report.
fn altered(ctx: &SessionContext, name: &str, what: &str, change: impl FnOnce(&str, &crate::io::StorageOptions) -> Result<u64>) -> Result<LazyFrame> {
    let t = delta_table(ctx, name, &format!("{what} needs a Delta table"))?;
    let d = t.delta();
    let version = change(d.root(), d.storage())?;
    refresh(ctx, &t)?;
    report(ctx, "alter", &t.shown, d.root(), 0, Some(version), &[], Some(what.to_string()))
}
