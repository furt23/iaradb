//! Writing NDJSON (one object per row) to a local file or an object.
//! Numbers and booleans are JSON values, nulls are `null`, lists are arrays
//! and structs are objects; every other type (strings, dates, timestamps, ...)
//! is written as a JSON string.

use std::fmt::Write as _;
use std::io::Write;

use arrow::array::{Array, ArrayRef, AsArray, ListArray, StringArray, StringBuilder};
use arrow::datatypes::{DataType, Float32Type, Float64Type};
use arrow::record_batch::RecordBatch;
use arrow::util::display::{ArrayFormatter, FormatOptions};

use crate::error::{Result, WhError};
use crate::io::options::StorageOptions;
use crate::io::output::Output;

/// Bytes buffered before they go to the output.
const FLUSH: usize = 1 << 20;

pub struct JsonSink {
    out: Output,
}

impl JsonSink {
    pub fn create(path: &str, storage: &StorageOptions) -> Result<Self> {
        Ok(Self { out: Output::create(path, storage)? })
    }

    pub fn write(&mut self, batch: &RecordBatch) -> Result<()> {
        let schema = batch.schema();
        let keys: Vec<String> = schema.fields().iter().map(|f| format!("{}:", quoted(f.name()))).collect();
        let columns = batch.columns().iter().map(Column::new).collect::<Result<Vec<_>>>()?;
        let mut buf = String::with_capacity(FLUSH + 4096);
        for row in 0..batch.num_rows() {
            buf.push('{');
            for (i, c) in columns.iter().enumerate() {
                if i > 0 {
                    buf.push(',');
                }
                buf.push_str(&keys[i]);
                c.write(row, &mut buf)?;
            }
            buf.push_str("}\n");
            if buf.len() >= FLUSH {
                self.out.write_all(buf.as_bytes())?;
                buf.clear();
            }
        }
        Ok(self.out.write_all(buf.as_bytes())?)
    }

    pub fn finish(self) -> Result<()> {
        self.out.finish()
    }
}

pub fn write_json(path: &str, batches: &[RecordBatch]) -> Result<()> {
    write_json_with(path, batches, &StorageOptions::default())
}

pub fn write_json_with(path: &str, batches: &[RecordBatch], storage: &StorageOptions) -> Result<()> {
    let mut sink = JsonSink::create(path, storage)?;
    for b in batches {
        sink.write(b)?;
    }
    sink.finish()
}

enum Kind<'a> {
    /// Written as is (integers, booleans, decimals).
    Plain,
    Float,
    /// Written as a JSON string.
    Text,
    /// A JSON array of the elements.
    List(&'a ListArray, Box<Column<'a>>),
    /// A JSON object: member keys (`"name":`) and columns.
    Struct(Vec<(String, Column<'a>)>),
}

struct Column<'a> {
    array: &'a ArrayRef,
    fmt: ArrayFormatter<'a>,
    kind: Kind<'a>,
}

impl<'a> Column<'a> {
    fn new(array: &'a ArrayRef) -> Result<Self> {
        let kind = match array.data_type() {
            DataType::Boolean | DataType::Decimal128(..) | DataType::Decimal256(..) => Kind::Plain,
            t if t.is_integer() => Kind::Plain,
            DataType::Float32 | DataType::Float64 => Kind::Float,
            DataType::List(_) => {
                let list = array.as_list::<i32>();
                Kind::List(list, Box::new(Column::new(list.values())?))
            }
            DataType::Struct(_) => {
                let s = array.as_struct();
                let members = s.fields().iter().zip(s.columns()).map(|(f, c)| Ok((format!("{}:", quoted(f.name())), Column::new(c)?)));
                Kind::Struct(members.collect::<Result<Vec<_>>>()?)
            }
            _ => Kind::Text,
        };
        let fmt = ArrayFormatter::try_new(array.as_ref(), &FormatOptions::default()).map_err(|e| WhError::NotSupported(format!("writing JSON: {e}")))?;
        Ok(Self { array, fmt, kind })
    }

    fn write(&self, row: usize, buf: &mut String) -> Result<()> {
        if self.array.is_null(row) {
            buf.push_str("null");
            return Ok(());
        }
        match &self.kind {
            Kind::Plain => self.display(row, buf),
            Kind::Float => {
                let v = match self.array.data_type() {
                    DataType::Float32 => self.array.as_primitive::<Float32Type>().value(row) as f64,
                    _ => self.array.as_primitive::<Float64Type>().value(row),
                };
                // JSON has no NaN or infinity
                match (v.is_finite(), self.array.data_type()) {
                    (false, _) => Ok(buf.push_str("null")),
                    (true, DataType::Float32) => write_fmt(buf, format_args!("{:?}", v as f32)),
                    (true, _) => write_fmt(buf, format_args!("{v:?}")),
                }
            }
            Kind::Text => {
                let mut s = String::new();
                self.display(row, &mut s)?;
                escape_into(&s, buf);
                Ok(())
            }
            Kind::List(list, items) => {
                let offsets = list.value_offsets();
                buf.push('[');
                for i in offsets[row]..offsets[row + 1] {
                    if i > offsets[row] {
                        buf.push(',');
                    }
                    items.write(i as usize, buf)?;
                }
                buf.push(']');
                Ok(())
            }
            Kind::Struct(members) => {
                buf.push('{');
                for (i, (key, c)) in members.iter().enumerate() {
                    if i > 0 {
                        buf.push(',');
                    }
                    buf.push_str(key);
                    c.write(row, buf)?;
                }
                buf.push('}');
                Ok(())
            }
        }
    }

    fn display(&self, row: usize, buf: &mut String) -> Result<()> {
        write_fmt(buf, format_args!("{}", self.fmt.value(row)))
    }
}

/// Every row of `array` as JSON text (NULL stays NULL): strings are quoted,
/// lists are arrays and structs are objects.
pub fn json_text(array: &ArrayRef) -> Result<StringArray> {
    let column = Column::new(array)?;
    let mut out = StringBuilder::with_capacity(array.len(), array.len() * 8);
    let mut buf = String::new();
    for row in 0..array.len() {
        if array.is_null(row) {
            out.append_null();
            continue;
        }
        buf.clear();
        column.write(row, &mut buf)?;
        out.append_value(&buf);
    }
    Ok(out.finish())
}

fn write_fmt(buf: &mut String, args: std::fmt::Arguments<'_>) -> Result<()> {
    buf.write_fmt(args).map_err(|e| WhError::Execution(format!("writing JSON: {e}")))
}

fn quoted(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    escape_into(s, &mut out);
    out
}

/// `s` as a JSON string literal.
pub fn escape_into(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                let _ = write!(out as &mut dyn std::fmt::Write, "\\u{:04x}", c as u32);
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes() {
        assert_eq!(quoted("a\"b\\c\n\u{1}é"), r#""a\"b\\c\n\u0001é""#);
    }
}
