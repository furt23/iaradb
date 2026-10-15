//! CSV options given by name (SQL `read_csv('x.csv', quote => '''')`, catalog
//! entries): DuckDB's names, with the Polars ones as aliases.

use crate::error::{Result, WhError};
use crate::types::parse_data_type;

use super::{CsvEncoding, CsvOptions};

/// The value of a named option.
#[derive(Debug, Clone, PartialEq)]
pub enum OptValue {
    Text(String),
    Number(f64),
    Bool(bool),
    List(Vec<String>),
    /// `{'name': 'type', ...}`
    Map(Vec<(String, String)>),
}

impl OptValue {
    /// A scalar as text (how storage options hold it).
    pub fn text(&self) -> Result<String> {
        match self {
            OptValue::Text(t) => Ok(t.clone()),
            OptValue::Bool(b) => Ok(b.to_string()),
            OptValue::Number(n) if n.fract() == 0.0 => Ok((*n as i64).to_string()),
            OptValue::Number(n) => Ok(n.to_string()),
            other => Err(WhError::Sql(format!("expected a single value, got {other:?}"))),
        }
    }

    pub fn flag(&self) -> Result<bool> {
        match self {
            OptValue::Bool(b) => Ok(*b),
            OptValue::Number(n) => Ok(*n != 0.0),
            other => Ok(matches!(other.text()?.to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on")),
        }
    }

    pub fn count(&self, key: &str) -> Result<usize> {
        match self {
            OptValue::Number(n) if *n >= 0.0 && n.fract() == 0.0 => Ok(*n as usize),
            other => other.text()?.parse().map_err(|_| WhError::Sql(format!("{key} must be a non-negative number"))),
        }
    }

    pub fn list(&self) -> Result<Vec<String>> {
        match self {
            OptValue::List(l) => Ok(l.clone()),
            other => Ok(vec![other.text()?]),
        }
    }

    /// One byte (`'\t'` and `'\\t'` mean a tab); None when empty.
    pub fn byte(&self, key: &str) -> Result<Option<u8>> {
        let t = self.text()?;
        let t = if t == "\\t" { "\t".to_string() } else { t };
        match t.as_bytes() {
            [] => Ok(None),
            [b] => Ok(Some(*b)),
            _ => Err(WhError::Sql(format!("{key} must be a single ASCII character, got '{t}'"))),
        }
    }
}

/// A map of column name to type name as arrow types.
pub fn types_of(pairs: &[(String, String)]) -> Result<std::collections::BTreeMap<String, arrow::datatypes::DataType>> {
    pairs.iter().map(|(n, t)| Ok((n.clone(), parse_data_type(t)?))).collect()
}

pub fn encoding_of(name: &str) -> Result<CsvEncoding> {
    match name.to_ascii_lowercase().replace('_', "-").as_str() {
        "utf8" | "utf-8" => Ok(CsvEncoding::Utf8),
        "utf8-lossy" | "utf-8-lossy" | "lossy" => Ok(CsvEncoding::Utf8Lossy),
        other => Err(WhError::Plan(format!("unsupported encoding '{other}' (expected utf8 or utf8-lossy)"))),
    }
}

impl CsvOptions {
    /// Set an option by its name; false when the name is not a CSV option.
    pub fn set_option(&mut self, key: &str, v: &OptValue) -> Result<bool> {
        match key {
            "header" | "has_header" => self.has_header = v.flag()?,
            "delim" | "delimiter" | "sep" | "separator" => {
                self.delimiter = v.byte(key)?.ok_or_else(|| WhError::Sql("empty delimiter".into()))?
            }
            "quote" | "quote_char" => self.quote = v.byte(key)?.unwrap_or(0),
            "escape" | "escape_char" => self.escape = v.byte(key)?,
            "comment" | "comment_prefix" | "comment_char" => self.comment = v.byte(key)?,
            "nullstr" | "null_values" | "null_str" => self.null_values = v.list()?,
            "skip" | "skip_rows" => self.skip_rows = v.count(key)?,
            "columns" => match v {
                OptValue::Map(m) => self.schema_overrides = types_of(m)?,
                other => self.columns = Some(other.list()?),
            },
            "types" | "dtypes" | "schema_overrides" | "column_types" => match v {
                OptValue::Map(m) => self.schema_overrides = types_of(m)?,
                _ => return Err(WhError::Sql(format!("{key} expects a map of column name to type: {{'a': 'INTEGER'}}"))),
            },
            "encoding" => self.encoding = encoding_of(&v.text()?)?,
            "try_parse_dates" => self.try_parse_dates = v.flag()?,
            "sample_size" | "infer_rows" | "infer_schema_length" => self.infer_rows = v.count(key)?,
            "parallel" => self.parallel = v.flag()?,
            _ => return Ok(false),
        }
        Ok(true)
    }
}
