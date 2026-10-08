//! Files in FROM: table functions (`read_parquet('s3://b/t/*.parquet',
//! region => 'us-east-1')`, `read_csv('x.csv', delim => ';')`) and quoted
//! paths or URLs (`FROM "s3://b/t/"`). Named arguments other than the CSV
//! ones are storage options.

use std::sync::Arc;

use sqlparser::ast as sql;

use crate::error::{Result, WhError};
use crate::io::TableProvider;
use crate::io::csv::{CsvOptions, CsvTable};
use crate::io::options::StorageOptions;
use crate::io::parquet::ParquetTable;

#[derive(Debug, Clone, Copy, PartialEq)]
enum Format {
    Parquet,
    Csv,
}

/// A provider for `read_parquet(...)` / `read_csv(...)`.
pub fn table_function(fname: &str, args: &[sql::FunctionArg]) -> Result<Arc<dyn TableProvider>> {
    let format = match fname {
        "read_parquet" | "parquet_scan" | "scan_parquet" => Format::Parquet,
        "read_csv" | "read_csv_auto" | "scan_csv" => Format::Csv,
        other => return Err(WhError::NotSupported(format!("table function {other}"))),
    };
    let mut path = None;
    let mut csv = CsvOptions::default();
    let mut storage = StorageOptions::new();
    for a in args {
        match a {
            sql::FunctionArg::Unnamed(sql::FunctionArgExpr::Expr(e)) if path.is_none() => path = Some(string_value(e)?),
            sql::FunctionArg::Named { name, arg: sql::FunctionArgExpr::Expr(e), .. } => {
                named(&name.value, e, format, &mut csv, &mut storage)?
            }
            sql::FunctionArg::ExprNamed { name: sql::Expr::Identifier(name), arg: sql::FunctionArgExpr::Expr(e), .. } => {
                named(&name.value, e, format, &mut csv, &mut storage)?
            }
            other => return Err(WhError::Sql(format!("{fname}(): unexpected argument {other}"))),
        }
    }
    let path = path.ok_or_else(|| WhError::Sql(format!("{fname}() expects a path string")))?;
    provider(format, &path, csv, &storage)
}

/// A provider for a path or URL named in FROM, by its extension.
pub fn path_provider(path: &str) -> Result<Arc<dyn TableProvider>> {
    let lower = path.to_ascii_lowercase();
    let format = if lower.ends_with(".csv") || lower.ends_with(".csv*") { Format::Csv } else { Format::Parquet };
    provider(format, path, CsvOptions::default(), &StorageOptions::new())
}

fn provider(format: Format, path: &str, csv: CsvOptions, storage: &StorageOptions) -> Result<Arc<dyn TableProvider>> {
    Ok(match format {
        Format::Parquet => Arc::new(ParquetTable::try_new_with(path, storage)?),
        Format::Csv => Arc::new(CsvTable::try_new_with(path, csv, storage)?),
    })
}

fn named(key: &str, e: &sql::Expr, format: Format, csv: &mut CsvOptions, storage: &mut StorageOptions) -> Result<()> {
    let key = key.to_ascii_lowercase();
    let value = string_value(e)?;
    let flag = || matches!(value.to_ascii_lowercase().as_str(), "true" | "1" | "yes");
    match key.as_str() {
        "header" if format == Format::Csv => csv.has_header = flag(),
        "delim" | "delimiter" | "sep" if format == Format::Csv => {
            csv.delimiter = *value.as_bytes().first().ok_or_else(|| WhError::Sql("empty delimiter".into()))?
        }
        "sample_size" | "infer_rows" if format == Format::Csv => {
            csv.infer_rows = value.parse().map_err(|_| WhError::Sql(format!("{key} must be a number")))?
        }
        "parallel" if format == Format::Csv => csv.parallel = flag(),
        _ => *storage = std::mem::take(storage).with(&key, value),
    }
    Ok(())
}

/// A literal argument as text (strings, numbers, booleans).
fn string_value(e: &sql::Expr) -> Result<String> {
    match e {
        sql::Expr::Value(v) => match &v.value {
            sql::Value::Boolean(b) => Ok(b.to_string()),
            sql::Value::Number(n, _) => Ok(n.to_string()),
            other => other.clone().into_string().ok_or_else(|| WhError::Sql(format!("expected a literal, got {other}"))),
        },
        other => Err(WhError::Sql(format!("expected a literal, got {other}"))),
    }
}
