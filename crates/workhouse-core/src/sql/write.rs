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
use crate::catalog_names::{MAIN, TableName, TableRef, parse_schema, unknown_schema};
use crate::error::{Result, WhError};
use crate::io::StorageOptions;
use crate::io::csv::{CsvWriteOptions, sink_csv_with};
use crate::io::dataset;
use crate::io::json::sink_json;
use crate::io::parquet::{DatasetSink, ParquetOptions, new_file_name};
use crate::session::{LazyFrame, SessionContext, TableEntry};

pub fn run(ctx: &SessionContext, command: Command) -> Result<LazyFrame> {
    match command {
        Command::Query => Err(WhError::Plan("not a statement that writes".into())),
        Command::Copy { query, path, options } => copy(ctx, &query, &path, &options),
        Command::CreateTableAs { name, replace, if_not_exists, partition_by, query } => {
            create_table(ctx, &name, replace, if_not_exists, partition_by, &query)
        }
        Command::Insert { name, columns, query } => insert(ctx, &name, &columns, &query),
        Command::DropTable { name, if_exists } => drop_table(ctx, &name, if_exists),
        Command::CreateSchema { name, if_not_exists } => create_schema(ctx, &name, if_not_exists),
        Command::DropSchema { name, if_exists, cascade } => drop_schema(ctx, &name, if_exists, cascade),
        Command::Use { schema } => use_schema(ctx, &schema),
    }
}

/// What a statement did, as a one-row result.
fn summary(ctx: &SessionContext, operation: &str, table: Option<&str>, path: Option<&str>, rows: usize) -> Result<LazyFrame> {
    let schema = Arc::new(Schema::new(vec![
        Field::new("operation", DataType::Utf8, false),
        Field::new("table", DataType::Utf8, true),
        Field::new("path", DataType::Utf8, true),
        Field::new("rows", DataType::Int64, false),
    ]));
    let columns: Vec<ArrayRef> = vec![
        Arc::new(StringArray::from(vec![operation])),
        Arc::new(StringArray::from(vec![table])),
        Arc::new(StringArray::from(vec![path])),
        Arc::new(Int64Array::from(vec![rows as i64])),
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

/// `COPY (query) TO 'path' (FORMAT parquet | csv | json, PARTITION_BY (...), COMPRESSION ..., ROW_GROUP_SIZE n, HEADER, DELIMITER ',', OVERWRITE)`
fn copy(ctx: &SessionContext, query: &str, path: &str, options: &[(String, CopyValue)]) -> Result<LazyFrame> {
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
    let lf = ctx.sql(query)?;
    let rows = match format.as_str() {
        "parquet" => {
            if !parquet.partition_by.is_empty() && dataset::holds_data(path, &storage)? {
                if !overwrite {
                    return Err(WhError::Plan(format!("'{path}' already holds files: add OVERWRITE to replace them")));
                }
                dataset::remove(path, &storage)?;
            }
            lf.sink_parquet(path, &parquet, &storage)?
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

/// Where `CREATE TABLE name` puts a table: `name`'s schema, else the current one,
/// which must exist.
fn create_target(ctx: &SessionContext, name: &str) -> Result<TableName> {
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

/// `CREATE [OR REPLACE] TABLE [IF NOT EXISTS] name [PARTITIONED BY (...)] AS query`:
/// Parquet in the warehouse's `name/` folder (`schema/name/` outside `main`), or in
/// memory without a warehouse.
fn create_table(ctx: &SessionContext, name: &str, replace: bool, if_not_exists: bool, partition_by: Vec<String>, query: &str) -> Result<LazyFrame> {
    let target = create_target(ctx, name)?;
    let (key, shown) = (target.key(), target.display());
    if ctx.table_exists(&target) && !replace {
        if if_not_exists {
            return summary(ctx, "create", Some(&shown), None, 0);
        }
        return Err(WhError::Plan(format!("table '{shown}' already exists: use CREATE OR REPLACE TABLE to overwrite it")));
    }
    let lf = ctx.sql(query)?;
    let Some((root, storage)) = ctx.warehouse() else {
        if !partition_by.is_empty() {
            return Err(WhError::Plan("PARTITIONED BY needs a warehouse: a folder or s3:// prefix where tables are written".into()));
        }
        let (schema, batches) = lf.collect()?;
        let rows = batches.iter().map(|b| b.num_rows()).sum();
        ctx.register_batches(&key, schema, batches);
        return summary(ctx, "create", Some(&shown), None, rows);
    };
    let location = table_location(&root, &target);
    if dataset::holds_data(&location, &storage)? {
        if !replace {
            return Err(WhError::Plan(format!("'{location}' already holds data: use CREATE OR REPLACE TABLE to overwrite it")));
        }
        dataset::remove(&location, &storage)?;
    }
    let partitioned = !partition_by.is_empty();
    let dest = if partitioned { location.clone() } else { dataset::join(&location, &new_file_name()) };
    let opts = ParquetOptions { partition_by, ..Default::default() };
    let rows = lf.sink_parquet(&dest, &opts, &storage)?;
    if rows == 0 && partitioned {
        // no partition, no file: an empty table, in memory, of the right shape
        let (schema, batches) = lf.limit(0).collect()?;
        ctx.register_batches(&key, schema, batches);
    } else {
        ctx.register_parquet_with(&key, &location, &storage, false)?;
    }
    summary(ctx, "create", Some(&shown), Some(&location), rows)
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
fn missing(ctx: &SessionContext, r: &TableRef, name: &str) -> WhError {
    match &r.schema {
        Some(s) if !ctx.has_schema(s) => unknown_schema(s),
        _ => WhError::Plan(format!("table '{name}' not found")),
    }
}

/// `INSERT INTO name [(columns)] query`: new files in a folder table (in
/// their partitions), or more rows for an in-memory table.
fn insert(ctx: &SessionContext, name: &str, columns: &[String], query: &str) -> Result<LazyFrame> {
    let r = TableRef::strict(name)?;
    let target = ctx.resolve_table(&r).ok_or_else(|| missing(ctx, &r, name))?;
    let (key, shown) = (target.key(), target.display());
    let provider = match ctx.lookup(&key)? {
        Some(TableEntry::Table(t)) => t,
        Some(TableEntry::View(_)) => return Err(WhError::Plan(format!("'{shown}' is a view: rows go into tables"))),
        None => return Err(WhError::Plan(format!("table '{shown}' not found"))),
    };
    let table = provider.schema();
    let lf = ctx.sql(query)?;
    if let Some(loc) = provider.location() {
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
        // the folder has new files: list it again
        ctx.register_parquet_with(&key, &loc.path, &loc.storage, false)?;
        return summary(ctx, "insert", Some(&shown), Some(&loc.path), rows.into_inner());
    }
    if let Some(old) = provider.memory_batches() {
        let (schema, batches) = lf.collect()?;
        let mapping = column_mapping(&table, columns, &schema)?;
        let rows = batches.iter().map(|b| b.num_rows()).sum();
        let same: Vec<Option<usize>> = (0..table.fields().len()).map(Some).collect();
        let old = old.iter().map(|b| conform(b, &same, &table));
        let new = batches.iter().map(|b| conform(b, &mapping, &table));
        ctx.register_batches(&key, nullable(&table), old.chain(new).collect::<Result<Vec<_>>>()?);
        return summary(ctx, "insert", Some(&shown), None, rows);
    }
    Err(WhError::NotSupported(format!(
        "cannot insert into '{shown}' (a {} table): rows go into folders of Parquet files and in-memory tables",
        provider.kind()
    )))
}

/// `DROP TABLE [IF EXISTS] name`: the table leaves the session; its files stay.
fn drop_table(ctx: &SessionContext, name: &str, if_exists: bool) -> Result<LazyFrame> {
    let r = TableRef::strict(name)?;
    match ctx.resolve_table(&r) {
        Some(target) => {
            ctx.deregister(&target.key());
            summary(ctx, "drop", Some(&target.display()), None, 0)
        }
        None if if_exists => summary(ctx, "drop", Some(name), None, 0),
        None => Err(missing(ctx, &r, name)),
    }
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
