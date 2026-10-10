//! The CSV read options and how they shape the schema.

use std::collections::BTreeMap;
use std::io::Cursor;
use std::sync::Arc;

use arrow::csv::reader::{Format, ReaderBuilder};
use arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use bytes::Bytes;
use regex::Regex;

use crate::error::{Result, WhError};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CsvEncoding {
    /// Invalid UTF-8 is an error.
    #[default]
    Utf8,
    /// Invalid bytes become U+FFFD.
    Utf8Lossy,
}

#[derive(Debug, Clone)]
pub struct CsvOptions {
    pub has_header: bool,
    pub delimiter: u8,
    pub infer_rows: usize,
    /// Split files into byte ranges (cut outside quoted fields, see `csv::split`).
    pub parallel: bool,
    /// Bytes per range (default: enough ranges for every thread, at least
    /// 4 MiB locally and 8 MiB remotely).
    pub chunk_bytes: Option<usize>,
    /// The quote byte (Polars `quote_char`, DuckDB `quote`); 0 never quotes.
    pub quote: u8,
    pub escape: Option<u8>,
    /// Lines starting with this byte are skipped.
    pub comment: Option<u8>,
    /// Texts read as null, besides the empty string.
    pub null_values: Vec<String>,
    /// Lines skipped at the start of every file, before the header.
    pub skip_rows: usize,
    /// Keep only these columns, in this order (by name).
    pub columns: Option<Vec<String>>,
    /// Types forced on columns, by name.
    pub schema_overrides: BTreeMap<String, DataType>,
    pub encoding: CsvEncoding,
    /// Infer dates and timestamps from text (on by default; off keeps them as text).
    pub try_parse_dates: bool,
}

impl Default for CsvOptions {
    fn default() -> Self {
        Self {
            has_header: true,
            delimiter: b',',
            infer_rows: 10_000,
            parallel: true,
            chunk_bytes: None,
            quote: b'"',
            escape: None,
            comment: None,
            null_values: vec![],
            skip_rows: 0,
            columns: None,
            schema_overrides: BTreeMap::new(),
            encoding: CsvEncoding::Utf8,
            try_parse_dates: true,
        }
    }
}

impl CsvOptions {
    /// Bytes as valid UTF-8 text (invalid sequences replaced when lossy).
    pub fn decode(&self, b: Bytes) -> Bytes {
        if self.encoding == CsvEncoding::Utf8 || std::str::from_utf8(&b).is_ok() {
            return b;
        }
        Bytes::from(String::from_utf8_lossy(&b).into_owned())
    }

    fn null_regex(&self) -> Result<Option<Regex>> {
        if self.null_values.is_empty() {
            return Ok(None);
        }
        let alts: Vec<String> = self.null_values.iter().map(|v| regex::escape(v)).chain([String::new()]).collect();
        Regex::new(&format!("^(?:{})$", alts.join("|"))).map(Some).map_err(|e| WhError::Plan(format!("null_values: {e}")))
    }

    fn format(&self) -> Result<Format> {
        let mut f = Format::default().with_header(self.has_header).with_delimiter(self.delimiter).with_quote(self.quote);
        if let Some(e) = self.escape {
            f = f.with_escape(e);
        }
        if let Some(c) = self.comment {
            f = f.with_comment(c);
        }
        if let Some(r) = self.null_regex()? {
            f = f.with_null_regex(r);
        }
        Ok(f)
    }

    /// A batch reader over `slice`, which starts at a line start. The
    /// header is read only when `at_start`.
    pub fn reader(&self, schema: SchemaRef, projection: Option<&[usize]>, slice: Bytes, at_start: bool, batch: usize) -> Result<impl Iterator<Item = std::result::Result<arrow::record_batch::RecordBatch, arrow::error::ArrowError>>> {
        let mut b = ReaderBuilder::new(schema)
            .with_format(self.format()?.with_header(self.has_header && at_start))
            .with_batch_size(batch);
        if let Some(p) = projection {
            b = b.with_projection(p.to_vec());
        }
        Ok(b.build_buffered(Cursor::new(slice))?)
    }
}

/// The schema of `body` (the file from its first line to the end of the sample).
pub fn infer(body: &[u8], o: &CsvOptions) -> Result<Schema> {
    let (schema, _) = o.format()?.infer_schema(Cursor::new(body), Some(o.infer_rows))?;
    Ok(schema)
}

/// The file schema (overrides applied), the selected columns, and the table schema.
pub fn shape(inferred: Schema, o: &CsvOptions) -> Result<(SchemaRef, Option<Vec<usize>>, SchemaRef)> {
    let mut fields: Vec<Field> = inferred.fields().iter().map(|f| f.as_ref().clone()).collect();
    if !o.try_parse_dates {
        for f in &mut fields {
            if matches!(f.data_type(), DataType::Date32 | DataType::Date64 | DataType::Timestamp(..)) {
                *f = f.clone().with_data_type(DataType::Utf8);
            }
        }
    }
    for (name, t) in &o.schema_overrides {
        let f = fields.iter_mut().find(|f| f.name() == name).ok_or_else(|| WhError::Plan(format!("schema_overrides: no column '{name}'")))?;
        *f = f.clone().with_data_type(t.clone());
    }
    let file_schema = Arc::new(Schema::new(fields));
    let Some(cols) = &o.columns else {
        return Ok((file_schema.clone(), None, file_schema));
    };
    let idx = cols
        .iter()
        .map(|c| file_schema.index_of(c).map_err(|_| WhError::Plan(format!("columns: no column '{c}'"))))
        .collect::<Result<Vec<_>>>()?;
    let schema = Arc::new(file_schema.project(&idx)?);
    Ok((file_schema, Some(idx), schema))
}
