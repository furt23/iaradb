//! Running the statements that write or change the catalog (see
//! [`super::command`]). Each runs at once and returns one row saying what it
//! did: `operation, table, path, rows`.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use arrow::array::{ArrayRef, Int64Array, StringArray, new_null_array};
use arrow::compute::cast;
use arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use parking_lot::Mutex;

use super::command::{Command, CopyValue};
use super::create::{CreateSpec, Source, create_table};
use super::{Params, ddl, delta_stmt, describe, dml, maintenance};
use crate::catalog_names::{TableRef, parse_schema, unknown_schema};
use crate::error::{Result, WhError};
use crate::io::{StorageOptions, is_remote};
use crate::io::csv::{CsvWriteOptions, sink_csv_with};
use crate::io::dataset;
use crate::io::json::sink_json;
use crate::io::parquet::{DatasetSink, ParquetOptions, new_file_name};
use crate::session::{LazyFrame, SessionContext, TableEntry};

pub fn run(ctx: &SessionContext, command: Command, params: &Params) -> Result<LazyFrame> {
    match command {
        Command::Query => Err(WhError::Plan("not a statement that writes".into())),
        Command::Copy { query, path, options } => copy(ctx, &query, params, &path, &options),
        Command::CreateTableAs { name, replace, if_not_exists, partition_by, using, query } => {
            let spec = CreateSpec { name: &name, replace, if_not_exists, partition_by, using: using.as_deref(), comment: None };
            create_table(ctx, spec, Source::Query(&query), params)
        }
        Command::CreateTable { name, replace, if_not_exists, columns, partition_by, using, comment } => {
            let spec = CreateSpec { name: &name, replace, if_not_exists, partition_by, using: using.as_deref(), comment: comment.as_deref() };
            create_table(ctx, spec, Source::Columns(&columns), params)
        }
        Command::Insert { name, columns, overwrite, query } => insert(ctx, &name, &columns, overwrite, &query, params),
        Command::Truncate { name } => delta_stmt::truncate(ctx, &name),
        Command::DropTable { name, if_exists } => delta_stmt::drop_table(ctx, &name, if_exists),
        Command::CreateView { name, replace, if_not_exists, temp, query } => ddl::create_view(ctx, &name, replace, if_not_exists, temp, &query, params),
        Command::DropView { name, if_exists } => ddl::drop_view(ctx, &name, if_exists),
        Command::ShowTables { schema } => describe::show_tables(ctx, schema.as_deref()),
        Command::ShowSchemas => describe::show_schemas(ctx),
        Command::Describe { name } => describe::describe(ctx, &name),
        Command::CreateSchema { name, if_not_exists } => create_schema(ctx, &name, if_not_exists),
        Command::DropSchema { name, if_exists, cascade } => drop_schema(ctx, &name, if_exists, cascade),
        Command::Use { schema } => use_schema(ctx, &schema),
        Command::Dml { sql } => dml::run(ctx, &sql, params),
        Command::Maintenance(m) => maintenance::run(ctx, m, params),
    }
}

/// What a statement did, as a one-row result.
fn summary(ctx: &SessionContext, operation: &str, table: Option<&str>, path: Option<&str>, rows: usize) -> Result<LazyFrame> {
    summary_with(ctx, operation, table, path, rows, None, None)
}

/// [`summary`] with the format of the table (`delta`, `parquet`, `memory`; `view` / `temp view` for views)
/// and the Delta version it is at after the statement.
pub(super) fn summary_with(
    ctx: &SessionContext,
    operation: &str,
    table: Option<&str>,
    path: Option<&str>,
    rows: usize,
    format: Option<&str>,
    version: Option<u64>,
) -> Result<LazyFrame> {
    let schema = Arc::new(Schema::new(vec![
        Field::new("operation", DataType::Utf8, false),
        Field::new("table", DataType::Utf8, true),
        Field::new("path", DataType::Utf8, true),
        Field::new("rows", DataType::Int64, false),
        Field::new("format", DataType::Utf8, true),
        Field::new("version", DataType::Int64, true),
    ]));
    let columns: Vec<ArrayRef> = vec![
        Arc::new(StringArray::from(vec![operation])),
        Arc::new(StringArray::from(vec![table])),
        Arc::new(StringArray::from(vec![path])),
        Arc::new(Int64Array::from(vec![rows as i64])),
        Arc::new(StringArray::from(vec![format])),
        Arc::new(Int64Array::from(vec![version.map(|v| v as i64)])),
    ];
    ctx.from_batches(schema.clone(), vec![RecordBatch::try_new(schema, columns)?])
}

fn word(v: &CopyValue) -> Option<String> {
    match v {
        CopyValue::Word(w) | CopyValue::Text(w) => Some(w.to_ascii_lowercase()),
        _ => None,
    }
}

fn flag(key: &str, v: &CopyValue) -> Result<bool> {
    match word(v).as_deref() {
        Some("true" | "1" | "on") => Ok(true),
        Some("false" | "0" | "off") => Ok(false),
        _ => match v {
            CopyValue::Number(n) => Ok(*n != 0.0),
            _ => Err(WhError::Plan(format!("{} expects true or false", key.to_ascii_uppercase()))),
        },
    }
}

/// The format a path's extension says (Parquet when it says none).
fn format_of_path(path: &str) -> String {
    let p = path.to_ascii_lowercase();
    let is = |exts: &[&str]| exts.iter().any(|e| p.ends_with(e));
    if is(&[".csv"]) {
        "csv"
    } else if is(&[".json", ".ndjson", ".jsonl"]) {
        "json"
    } else {
        "parquet"
    }
    .to_string()
}

/// A COPY option holding one character: `QUOTE '"'`.
fn byte_option(key: &str, v: &CopyValue) -> Result<u8> {
    match v {
        CopyValue::Text(t) if t.len() == 1 => Ok(t.as_bytes()[0]),
        _ => Err(WhError::Plan(format!("{} expects one character, quoted", key.to_ascii_uppercase()))),
    }
}

/// Whether COPY's target names a folder: a trailing separator, or a local folder.
fn is_folder_target(path: &str) -> bool {
    path.ends_with(['/', '\\']) || (!is_remote(path) && std::path::Path::new(path).is_dir())
}

/// After a write succeeded: delete the files the target held before. The new
/// files have names of their own, so none of them is among `old`.
pub(super) fn drop_replaced(root: &str, old: &[String], storage: &StorageOptions) -> Result<()> {
    if old.is_empty() {
        return Ok(());
    }
    dataset::remove_files(old, storage)?;
    dataset::prune_empty_dirs(root);
    Ok(())
}

/// `COPY (query) TO 'path' (FORMAT parquet | csv | json, PARTITION_BY (...), COMPRESSION ..., ROW_GROUP_SIZE n, HEADER, DELIMITER ',', OVERWRITE)`
fn copy(ctx: &SessionContext, query: &str, params: &Params, path: &str, options: &[(String, CopyValue)]) -> Result<LazyFrame> {
    let mut format = format_of_path(path);
    let mut parquet = ParquetOptions::default();
    let mut csv = CsvWriteOptions::default();
    let mut overwrite = false;
    for (key, value) in options {
        match key.as_str() {
            "format" => format = word(value).ok_or_else(|| WhError::Plan("FORMAT expects parquet or csv".into()))?,
            "partition_by" => match value {
                CopyValue::List(cols) => parquet.partition_by = cols.clone(),
                _ => return Err(WhError::Plan("PARTITION_BY expects a list of columns: PARTITION_BY (year, month)".into())),
            },
            "compression" | "codec" => parquet.compression = word(value).ok_or_else(|| WhError::Plan("COMPRESSION expects a codec name".into()))?,
            "row_group_size" => match value {
                CopyValue::Number(n) if *n >= 1.0 => parquet.row_group_size = Some(*n as usize),
                _ => return Err(WhError::Plan("ROW_GROUP_SIZE expects a positive number".into())),
            },
            "header" => csv.header = flag(key, value)?,
            "delimiter" | "sep" => csv.delimiter = byte_option(key, value)?,
            "quote" => csv.quote = byte_option(key, value)?,
            "escape" => csv.escape = byte_option(key, value)?,
            "nullstr" | "null" => match value {
                CopyValue::Text(t) | CopyValue::Word(t) => csv.null = Some(t.clone()),
                _ => return Err(WhError::Plan("NULL expects a quoted text".into())),
            },
            "overwrite" | "overwrite_or_ignore" => overwrite = flag(key, value)?,
            other => {
                return Err(WhError::Plan(format!(
                    "unknown COPY option '{other}' (expected FORMAT, PARTITION_BY, COMPRESSION, ROW_GROUP_SIZE, HEADER, DELIMITER, QUOTE, ESCAPE, NULL, OVERWRITE)"
                )));
            }
        }
    }
    let storage = StorageOptions::default();
    let lf = ctx.sql_with(query, params)?;
    let rows = match format.as_str() {
        "parquet" => {
            // a folder (partitioned, or named as one) gets new files; what it held goes only once they are written
            let partitioned = !parquet.partition_by.is_empty();
            let folder = partitioned || is_folder_target(path);
            let mut old = vec![];
            if folder && dataset::holds_data(path, &storage)? {
                if !overwrite {
                    return Err(WhError::Plan(format!("'{path}' already holds files: add OVERWRITE to replace them")));
                }
                old = dataset::list_files(path, &storage)?;
            }
            let dest = if folder && !partitioned { dataset::join(path, &new_file_name()) } else { path.to_string() };
            let files = lf.sink_parquet_files(&dest, &parquet, &storage)?;
            drop_replaced(path, &old, &storage)?;
            files.iter().map(|f| f.rows as usize).sum()
        }
        "csv" => {
            if !parquet.partition_by.is_empty() {
                return Err(WhError::NotSupported("PARTITION_BY writes Parquet only".into()));
            }
            sink_csv_with(&lf, path, &csv, &storage)?
        }
        "json" | "ndjson" | "jsonl" => {
            if !parquet.partition_by.is_empty() {
                return Err(WhError::NotSupported("PARTITION_BY writes Parquet only".into()));
            }
            sink_json(&lf, path, &storage)?
        }
        other => return Err(WhError::Plan(format!("unknown FORMAT '{other}' (expected parquet, csv or json)"))),
    };
    summary(ctx, "copy", None, Some(path), rows)
}

/// Where each column of the table comes from: a column of the query, or null.
fn column_mapping(table: &Schema, columns: &[String], query: &Schema) -> Result<Vec<Option<usize>>> {
    let given = if columns.is_empty() { table.fields().iter().map(|f| f.name().clone()).collect() } else { columns.to_vec() };
    if given.len() != query.fields().len() {
        return Err(WhError::Plan(format!("the query gives {} columns for {} table columns", query.fields().len(), given.len())));
    }
    for c in &given {
        if table.index_of(c).is_err() {
            return Err(WhError::Plan(format!("the table has no column '{c}'")));
        }
    }
    Ok(table.fields().iter().map(|f| given.iter().position(|c| c.eq_ignore_ascii_case(f.name()))).collect())
}

/// The table's schema with every column nullable (inserted rows may lack some).
fn nullable(table: &Schema) -> SchemaRef {
    Arc::new(Schema::new(table.fields().iter().map(|f| f.as_ref().clone().with_nullable(true)).collect::<Vec<_>>()))
}

/// A query's batch as a batch of the table.
fn conform(batch: &RecordBatch, mapping: &[Option<usize>], table: &SchemaRef) -> Result<RecordBatch> {
    let n = batch.num_rows();
    let columns = mapping
        .iter()
        .zip(table.fields())
        .map(|(m, f)| match m {
            Some(i) => Ok(cast(batch.column(*i), f.data_type())?),
            None => Ok(new_null_array(f.data_type(), n)),
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(RecordBatch::try_new_with_options(nullable(table), columns, &RecordBatchOptions::new().with_row_count(Some(n)))?)
}

/// Why a name refers to no table.
pub(super) fn missing(ctx: &SessionContext, r: &TableRef, name: &str) -> WhError {
    match &r.schema {
        Some(s) if !ctx.has_schema(s) => unknown_schema(s),
        _ => WhError::Plan(format!("table '{name}' not found")),
    }
}

/// `INSERT INTO name [(columns)] query`: new files in a folder table (in
/// their partitions), or more rows for an in-memory table.
fn insert(ctx: &SessionContext, name: &str, columns: &[String], overwrite: bool, query: &str, params: &Params) -> Result<LazyFrame> {
    let r = TableRef::strict(name)?;
    let target = ctx.resolve_table(&r).ok_or_else(|| missing(ctx, &r, name))?;
    let (key, shown) = (target.key(), target.display());
    let provider = match ctx.lookup(&key)? {
        Some(TableEntry::Table(t)) => t,
        Some(TableEntry::View(_)) => return Err(WhError::Plan(format!("'{shown}' is a view: rows go into tables"))),
        None => return Err(WhError::Plan(format!("table '{shown}' not found"))),
    };
    let table = provider.schema();
    let lf = ctx.sql_with(query, params)?;
    if let Some(d) = provider.as_delta() {
        return delta_stmt::insert(ctx, &key, &shown, d, columns, overwrite, lf);
    }
    let op = if overwrite { "insert overwrite" } else { "insert" };
    if let Some(loc) = provider.location() {
        // an overwrite deletes what the folder held once the new files are written
        let old = if overwrite { dataset::list_files(&loc.path, &loc.storage)? } else { vec![] };
        let partitioned = !loc.partition_by.is_empty();
        let target = if partitioned { loc.path.clone() } else { dataset::join(&loc.path, &new_file_name()) };
        let opts = ParquetOptions { partition_by: loc.partition_by.clone(), ..Default::default() };
        let sink = Mutex::new(None::<(DatasetSink, Vec<Option<usize>>)>);
        let rows = AtomicUsize::new(0);
        lf.stream(
            &mut |schema| {
                let mapping = column_mapping(&table, columns, schema)?;
                *sink.lock() = Some((DatasetSink::create(&target, table.clone(), &opts, &loc.storage)?, mapping));
                Ok(())
            },
            &mut |b| {
                rows.fetch_add(b.num_rows(), Ordering::Relaxed);
                let mut guard = sink.lock();
                let (w, mapping) = guard.as_mut().expect("writer");
                w.write(&conform(&b, mapping, &table)?)
            },
        )?;
        sink.into_inner().expect("writer").0.finish()?;
        drop_replaced(&loc.path, &old, &loc.storage)?;
        // the folder has new files: list it again
        ctx.register_parquet_with(&key, &loc.path, &loc.storage, false)?;
        return summary_with(ctx, op, Some(&shown), Some(&loc.path), rows.into_inner(), Some("parquet"), None);
    }
    if let Some(old) = provider.memory_batches() {
        let (schema, batches) = lf.collect()?;
        let mapping = column_mapping(&table, columns, &schema)?;
        let rows = batches.iter().map(|b| b.num_rows()).sum();
        let same: Vec<Option<usize>> = (0..table.fields().len()).map(Some).collect();
        let old = old.iter().filter(|_| !overwrite).map(|b| conform(b, &same, &table));
        let new = batches.iter().map(|b| conform(b, &mapping, &table));
        ctx.register_batches(&key, nullable(&table), old.chain(new).collect::<Result<Vec<_>>>()?);
        return summary_with(ctx, op, Some(&shown), None, rows, Some("memory"), None);
    }
    Err(WhError::NotSupported(format!(
        "cannot insert into '{shown}' (a {} table): rows go into folders of Parquet files and in-memory tables",
        provider.kind()
    )))
}

/// `CREATE SCHEMA [IF NOT EXISTS] name`
fn create_schema(ctx: &SessionContext, name: &str, if_not_exists: bool) -> Result<LazyFrame> {
    ctx.create_schema(name, if_not_exists)?;
    summary(ctx, "create schema", Some(&parse_schema(name)?), None, 0)
}

/// `DROP SCHEMA [IF EXISTS] name [CASCADE | RESTRICT]`: with CASCADE its tables
/// leave the session too (their files stay).
fn drop_schema(ctx: &SessionContext, name: &str, if_exists: bool, cascade: bool) -> Result<LazyFrame> {
    ctx.drop_schema(name, if_exists, cascade)?;
    summary(ctx, "drop schema", Some(&parse_schema(name)?), None, 0)
}

/// `USE name`: bare table names are looked up in that schema first.
fn use_schema(ctx: &SessionContext, name: &str) -> Result<LazyFrame> {
    ctx.use_schema(name)?;
    summary(ctx, "use", Some(&parse_schema(name)?), None, 0)
}
