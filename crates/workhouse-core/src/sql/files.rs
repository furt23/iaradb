//! Files in FROM: table functions (`read_parquet('s3://b/t/*.parquet',
//! region => 'us-east-1')`, `read_csv('x.csv', delim => ';')`) and quoted
//! paths or URLs (`FROM "s3://b/t/"`). Named arguments other than the CSV
//! or JSON ones are storage options.

use std::sync::Arc;

use sqlparser::ast as sql;

use crate::error::{Result, WhError};
use crate::io::TableProvider;
use crate::io::csv::args::OptValue;
use crate::io::csv::{CsvOptions, CsvTable};
use crate::io::json::{JsonOptions, JsonTable};
use crate::io::options::StorageOptions;
use crate::io::parquet::ParquetTable;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Format {
    Parquet,
    Csv,
    Json,
    Delta,
}

/// The options of one file read.
#[derive(Default)]
struct ReadOptions {
    csv: CsvOptions,
    json: JsonOptions,
    storage: StorageOptions,
    delta: Option<crate::delta::VersionSpec>,
}

/// A provider for `read_parquet(...)` / `read_csv(...)` / `read_json(...)`.
pub fn table_function(fname: &str, args: &[sql::FunctionArg]) -> Result<Arc<dyn TableProvider>> {
    let format = match fname {
        "read_parquet" | "parquet_scan" | "scan_parquet" => Format::Parquet,
        "read_csv" | "read_csv_auto" | "scan_csv" => Format::Csv,
        "read_json" | "read_json_auto" | "read_ndjson" | "read_ndjson_auto" | "read_jsonl" | "scan_json" | "scan_ndjson" | "read_json_objects" => {
            Format::Json
        }
        "read_delta" | "delta_scan" | "scan_delta" => Format::Delta,
        other => return Err(WhError::NotSupported(format!("table function {other}"))),
    };
    let mut path = None;
    let mut opts = ReadOptions::default();
    if matches!(fname, "read_ndjson" | "read_ndjson_auto" | "read_jsonl" | "scan_ndjson") {
        opts.json.format = crate::io::json::JsonFormat::Ndjson;
    }
    for a in args {
        match a {
            sql::FunctionArg::Unnamed(sql::FunctionArgExpr::Expr(e)) if path.is_none() => path = Some(string_value(e)?),
            sql::FunctionArg::Named { name, arg: sql::FunctionArgExpr::Expr(e), .. } => named(&name.value, e, format, &mut opts)?,
            sql::FunctionArg::ExprNamed { name: sql::Expr::Identifier(name), arg: sql::FunctionArgExpr::Expr(e), .. } => {
                named(&name.value, e, format, &mut opts)?
            }
            other => return Err(WhError::Sql(format!("{fname}(): unexpected argument {other}"))),
        }
    }
    let path = path.ok_or_else(|| WhError::Sql(format!("{fname}() expects a path string")))?;
    provider(format, &path, opts)
}

/// A provider for a path or URL named in FROM, by its extension.
pub fn path_provider(path: &str) -> Result<Arc<dyn TableProvider>> {
    let lower = path.to_ascii_lowercase();
    let format = if lower.ends_with(".csv") || lower.ends_with(".csv*") {
        Format::Csv
    } else if [".json", ".ndjson", ".jsonl"].iter().any(|e| lower.ends_with(e)) {
        Format::Json
    } else {
        Format::Parquet
    };
    provider(format, path, ReadOptions::default())
}

fn provider(format: Format, path: &str, o: ReadOptions) -> Result<Arc<dyn TableProvider>> {
    Ok(match format {
        Format::Parquet => Arc::new(ParquetTable::try_new_with(path, &o.storage)?),
        Format::Csv => Arc::new(CsvTable::try_new_with(path, o.csv, &o.storage)?),
        Format::Json => Arc::new(JsonTable::try_new_with(path, o.json, &o.storage)?),
        Format::Delta => Arc::new(crate::delta::DeltaTable::open(path, &o.storage, o.delta)?),
    })
}

fn named(key: &str, e: &sql::Expr, format: Format, o: &mut ReadOptions) -> Result<()> {
    let key = key.to_ascii_lowercase();
    let value = opt_value(e)?;
    if format == Format::Delta && (key == "version" || key == "timestamp") {
        o.delta = Some(match (key.as_str(), &value) {
            ("version", OptValue::Number(n)) if *n >= 0.0 => crate::delta::VersionSpec::Version(*n as u64),
            ("timestamp", OptValue::Number(n)) => crate::delta::VersionSpec::Timestamp(*n as i64),
            ("timestamp", v) => crate::delta::VersionSpec::Timestamp(super::timetravel::timestamp_millis(&v.text()?)?),
            _ => return Err(WhError::Sql("read_delta(): version expects a number, timestamp a number of milliseconds or a text".into())),
        });
        return Ok(());
    }
    let known = match format {
        Format::Csv => o.csv.set_option(&key, &value)?,
        Format::Json => o.json.set_option(&key, &value)?,
        Format::Parquet | Format::Delta => false,
    };
    if !known {
        o.storage = std::mem::take(&mut o.storage).with(&key, value.text()?);
    }
    Ok(())
}

/// A literal argument (strings, numbers, booleans, lists, maps).
fn opt_value(e: &sql::Expr) -> Result<OptValue> {
    match e {
        sql::Expr::Value(v) => match &v.value {
            sql::Value::Boolean(b) => Ok(OptValue::Bool(*b)),
            sql::Value::Number(n, _) => n.parse().map(OptValue::Number).map_err(|_| WhError::Sql(format!("bad number {n}"))),
            other => other.clone().into_string().map(OptValue::Text).ok_or_else(|| WhError::Sql(format!("expected a literal, got {other}"))),
        },
        sql::Expr::Array(a) => a.elem.iter().map(string_value).collect::<Result<Vec<_>>>().map(OptValue::List),
        sql::Expr::Dictionary(fields) => {
            let pairs = fields.iter().map(|f| Ok((f.key.value.clone(), string_value(&f.value)?))).collect::<Result<Vec<_>>>()?;
            Ok(OptValue::Map(pairs))
        }
        sql::Expr::UnaryOp { op: sql::UnaryOperator::Minus, expr } => match opt_value(expr)? {
            OptValue::Number(n) => Ok(OptValue::Number(-n)),
            _ => Err(WhError::Sql(format!("expected a literal, got {e}"))),
        },
        other => Err(WhError::Sql(format!("expected a literal, got {other}"))),
    }
}

/// A literal argument as text (strings, numbers, booleans).
fn string_value(e: &sql::Expr) -> Result<String> {
    opt_value(e)?.text()
}
