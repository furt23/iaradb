//! Statements that answer with a table about the catalog: `SHOW TABLES`,
//! `SHOW SCHEMAS`, `DESCRIBE t` / `SHOW COLUMNS FROM t`.

use std::sync::Arc;

use arrow::array::{ArrayRef, BooleanArray, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;

use super::write::missing;
use crate::catalog_names::{TableRef, parse_schema, unknown_schema};
use crate::error::{Result, WhError};
use crate::nested::type_name;
use crate::session::{LazyFrame, SessionContext, TableEntry};

fn strings(v: Vec<Option<String>>) -> ArrayRef {
    Arc::new(StringArray::from(v))
}

fn frame(ctx: &SessionContext, fields: Vec<Field>, columns: Vec<ArrayRef>) -> Result<LazyFrame> {
    let schema = Arc::new(Schema::new(fields));
    ctx.from_batches(schema.clone(), vec![RecordBatch::try_new(schema, columns)?])
}

/// `SHOW TABLES [IN schema]`: `schema, table, type, format` (the format of a
/// table not used yet is null: listing does not load tables).
pub fn show_tables(ctx: &SessionContext, schema: Option<&str>) -> Result<LazyFrame> {
    let schema = match schema {
        Some(s) => parse_schema(s)?,
        None => ctx.current_schema(),
    };
    if !ctx.has_schema(&schema) {
        return Err(unknown_schema(&schema));
    }
    let listing = ctx.list_tables(&schema);
    let col = |f: &dyn Fn(&crate::session::TableListing) -> Option<String>| strings(listing.iter().map(f).collect());
    frame(
        ctx,
        vec![
            Field::new("schema", DataType::Utf8, false),
            Field::new("table", DataType::Utf8, false),
            Field::new("type", DataType::Utf8, false),
            Field::new("format", DataType::Utf8, true),
        ],
        vec![
            col(&|t| Some(t.name.schema.clone())),
            col(&|t| Some(t.name.table.clone())),
            col(&|t| Some(if t.is_view { "view" } else { "table" }.to_string())),
            col(&|t| t.kind.map(str::to_string)),
        ],
    )
}

/// `SHOW SCHEMAS`: `schema, current`
pub fn show_schemas(ctx: &SessionContext) -> Result<LazyFrame> {
    let schemas = ctx.schemas();
    let current = ctx.current_schema();
    let flags: Vec<bool> = schemas.iter().map(|s| *s == current).collect();
    frame(
        ctx,
        vec![Field::new("schema", DataType::Utf8, false), Field::new("current", DataType::Boolean, false)],
        vec![strings(schemas.into_iter().map(Some).collect()), Arc::new(BooleanArray::from(flags))],
    )
}

/// `DESCRIBE t`: `column_name, data_type, nullable, is_partition`
pub fn describe(ctx: &SessionContext, name: &str) -> Result<LazyFrame> {
    let r = TableRef::strict(name)?;
    let target = ctx.resolve_table(&r).ok_or_else(|| missing(ctx, &r, name))?;
    let (schema, partitions): (Arc<Schema>, Vec<String>) = match ctx.lookup(&target.key())? {
        Some(TableEntry::Table(t)) => {
            let partitions = match t.as_delta() {
                Some(d) => d.snapshot().partition_columns.clone(),
                None => t.location().map(|l| l.partition_by).unwrap_or_default(),
            };
            (t.schema(), partitions)
        }
        Some(TableEntry::View(p)) => (p.schema().arrow_schema().clone(), vec![]),
        None => return Err(WhError::Plan(format!("table '{name}' not found"))),
    };
    let fields = schema.fields();
    frame(
        ctx,
        vec![
            Field::new("column_name", DataType::Utf8, false),
            Field::new("data_type", DataType::Utf8, false),
            Field::new("nullable", DataType::Boolean, false),
            Field::new("is_partition", DataType::Boolean, false),
        ],
        vec![
            strings(fields.iter().map(|f| Some(f.name().clone())).collect()),
            strings(fields.iter().map(|f| Some(type_name(f.data_type()))).collect()),
            Arc::new(BooleanArray::from(fields.iter().map(|f| f.is_nullable()).collect::<Vec<_>>())),
            Arc::new(BooleanArray::from(fields.iter().map(|f| partitions.iter().any(|p| p.eq_ignore_ascii_case(f.name()))).collect::<Vec<_>>())),
        ],
    )
}
