//! Column definitions of `CREATE TABLE t (cols)`, and views.

use std::sync::Arc;

use arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use sqlparser::ast as sql;
use sqlparser::parser::Parser;

use super::Params;
use super::dialect::IaraDialect;
use super::write::{missing, summary_with};
use crate::catalog_names::TableRef;
use crate::error::{Result, WhError};
use crate::session::{LazyFrame, SessionContext, TableEntry};
use crate::types::parse_data_type;

/// One declared column.
#[derive(Debug, Clone, PartialEq)]
pub struct ColumnSpec {
    pub name: String,
    pub data_type: DataType,
    /// false: `NOT NULL`
    pub nullable: bool,
}

/// The schema of declared columns.
pub fn schema_of(columns: &[ColumnSpec]) -> SchemaRef {
    Arc::new(Schema::new(columns.iter().map(|c| Field::new(&c.name, c.data_type.clone(), c.nullable)).collect::<Vec<_>>()))
}

/// The text between the parentheses of `CREATE TABLE t (...)`, as columns.
/// Types are parsed by sqlparser and mapped as `CAST` maps them.
pub fn parse_columns(inner: &str) -> Result<Vec<ColumnSpec>> {
    let text = format!("CREATE TABLE t ({inner})");
    let mut stmts = Parser::parse_sql(&IaraDialect, &text).map_err(|e| WhError::Sql(format!("column definitions: {e}")))?;
    let Some(sql::Statement::CreateTable(create)) = stmts.pop() else {
        return Err(WhError::Sql("expected column definitions: (name type [NOT NULL], ...)".into()));
    };
    if !create.constraints.is_empty() {
        return Err(WhError::NotSupported("table constraints (PRIMARY KEY, UNIQUE, ...): declare columns with NOT NULL only".into()));
    }
    let mut out: Vec<ColumnSpec> = vec![];
    for col in create.columns {
        let mut nullable = true;
        for o in &col.options {
            match &o.option {
                sql::ColumnOption::NotNull => nullable = false,
                sql::ColumnOption::Null => nullable = true,
                other => return Err(WhError::NotSupported(format!("column option '{other}' (column '{}'): only NOT NULL is supported", col.name.value))),
            }
        }
        let data_type = parse_data_type(&col.data_type.to_string())?;
        if out.iter().any(|c| c.name.eq_ignore_ascii_case(&col.name.value)) {
            return Err(WhError::Plan(format!("column '{}' is declared twice", col.name.value)));
        }
        out.push(ColumnSpec { name: col.name.value, data_type, nullable });
    }
    if out.is_empty() {
        return Err(WhError::Sql("a table needs at least one column".into()));
    }
    Ok(out)
}

/// `CREATE [OR REPLACE] [TEMP] VIEW name AS query`: a view of the session,
/// planned now (the query's parameters are bound now).
pub fn create_view(ctx: &SessionContext, name: &str, replace: bool, if_not_exists: bool, temp: bool, query: &str, params: &Params) -> Result<LazyFrame> {
    let target = super::create::create_target(ctx, name)?;
    let shown = ctx.display_name(&target);
    if ctx.table_exists(&target) {
        if if_not_exists {
            return summary_with(ctx, "create view", Some(&shown), None, 0, Some("view"), None);
        }
        let is_view = matches!(ctx.entry(&target), Ok(Some(TableEntry::View(_))));
        if !replace || !is_view {
            return Err(WhError::Plan(if is_view {
                format!("view '{shown}' already exists: use CREATE OR REPLACE VIEW")
            } else {
                format!("'{shown}' is a table: it cannot be replaced by a view")
            }));
        }
    }
    let lf = ctx.sql_with(query, params)?;
    ctx.put_view(&target, lf.plan.clone())?;
    // not persisted yet: `format` says view (or temp view) so a workspace can decide
    summary_with(ctx, "create view", Some(&shown), None, 0, Some(if temp { "temp view" } else { "view" }), None)
}

/// `DROP VIEW [IF EXISTS] name`
pub fn drop_view(ctx: &SessionContext, name: &str, if_exists: bool) -> Result<LazyFrame> {
    let r = TableRef::strict(name)?;
    match ctx.resolve_table(&r) {
        Some(target) => {
            if !matches!(ctx.entry(&target), Ok(Some(TableEntry::View(_)))) {
                return Err(WhError::Plan(format!("'{}' is a table, not a view: use DROP TABLE", ctx.display_name(&target))));
            }
            ctx.remove_table(&target);
            summary_with(ctx, "drop view", Some(&ctx.display_name(&target)), None, 0, Some("view"), None)
        }
        None if if_exists => summary_with(ctx, "drop view", Some(name), None, 0, Some("view"), None),
        None => Err(missing(ctx, &r, name)),
    }
}
