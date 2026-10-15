//! JSON options given by name (SQL `read_json('x.json', format => 'array')`),
//! with DuckDB's names.

use super::{JsonFormat, JsonNested, JsonOptions};
use crate::error::{Result, WhError};
use crate::io::csv::args::OptValue;

impl JsonOptions {
    /// Set an option by its name; false when the name is not a JSON option.
    pub fn set_option(&mut self, key: &str, v: &OptValue) -> Result<bool> {
        match key {
            "sample_size" | "infer_rows" | "infer_schema_length" => self.infer_rows = v.count(key)?,
            "parallel" => self.parallel = v.flag()?,
            "format" => self.format = format_of(&v.text()?)?,
            "nested" => self.nested = nested_of(&v.text()?)?,
            _ => return Ok(false),
        }
        Ok(true)
    }
}

fn format_of(name: &str) -> Result<JsonFormat> {
    match name.to_ascii_lowercase().as_str() {
        "auto" => Ok(JsonFormat::Auto),
        "newline_delimited" | "ndjson" | "jsonl" => Ok(JsonFormat::Ndjson),
        "array" => Ok(JsonFormat::Array),
        other => Err(WhError::Sql(format!("unknown JSON format '{other}' (expected auto, newline_delimited or array)"))),
    }
}

fn nested_of(name: &str) -> Result<JsonNested> {
    match name.to_ascii_lowercase().as_str() {
        "auto" | "struct" => Ok(JsonNested::Auto),
        "text" | "json" | "string" => Ok(JsonNested::Text),
        other => Err(WhError::Sql(format!("unknown nested mode '{other}' (expected auto or text)"))),
    }
}
