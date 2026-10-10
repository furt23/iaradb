//! Records into Arrow columns, for a fixed schema.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{ArrayRef, BooleanBuilder, Float64Builder, Int64Builder, StringBuilder};
use arrow::datatypes::{DataType, SchemaRef};
use arrow::record_batch::{RecordBatch, RecordBatchOptions};

use super::build_nested::{ListColumn, StructColumn};
use super::parse::{Member, Value};
use crate::error::{Result, WhError};

pub(super) enum Column {
    Bool(BooleanBuilder),
    Int(Int64Builder),
    Float(Float64Builder),
    Text(StringBuilder),
    List(ListColumn),
    Struct(StructColumn),
}

impl Column {
    pub(super) fn new(t: &DataType) -> Result<Column> {
        Ok(match t {
            DataType::Boolean => Column::Bool(BooleanBuilder::new()),
            DataType::Int64 => Column::Int(Int64Builder::new()),
            DataType::Float64 => Column::Float(Float64Builder::new()),
            DataType::Utf8 => Column::Text(StringBuilder::new()),
            DataType::List(item) => Column::List(ListColumn::new(item.data_type())?),
            DataType::Struct(fields) => Column::Struct(StructColumn::new(fields)?),
            other => return Err(WhError::NotSupported(format!("JSON column of type {other}"))),
        })
    }

    pub(super) fn push(&mut self, v: Option<&Value>, name: &str) -> Result<()> {
        let mismatch = |want: &str, v: &Value| WhError::Execution(format!("JSON column '{name}': expected {want}, found {v:?} (raise the schema sample size or read it as text)"));
        match (self, v) {
            (Column::Bool(b), None | Some(Value::Null)) => b.append_null(),
            (Column::Int(b), None | Some(Value::Null)) => b.append_null(),
            (Column::Float(b), None | Some(Value::Null)) => b.append_null(),
            (Column::Text(b), None | Some(Value::Null)) => b.append_null(),
            (Column::List(l), None | Some(Value::Null)) => l.push_null(),
            (Column::Struct(s), None | Some(Value::Null)) => s.push_null(name)?,
            (Column::Bool(b), Some(Value::Bool(x))) => b.append_value(*x),
            (Column::Int(b), Some(Value::Num(n))) => b.append_value(n.parse().map_err(|_| mismatch("an integer", &Value::Num(n)))?),
            (Column::Float(b), Some(Value::Num(n))) => b.append_value(n.parse().map_err(|_| mismatch("a number", &Value::Num(n)))?),
            (Column::Text(b), Some(Value::Str(s))) => b.append_value(s),
            (Column::Text(b), Some(Value::Num(s) | Value::Raw(s))) => b.append_value(s),
            (Column::Text(b), Some(Value::Bool(x))) => b.append_value(if *x { "true" } else { "false" }),
            (Column::List(l), Some(Value::Raw(text))) if text.starts_with('[') => l.push_array(text, name)?,
            (Column::Struct(s), Some(Value::Raw(text))) if text.starts_with('{') => s.push_object(text, name)?,
            (Column::Bool(_), Some(v)) => return Err(mismatch("a boolean", v)),
            (Column::Int(_), Some(v)) => return Err(mismatch("an integer", v)),
            (Column::Float(_), Some(v)) => return Err(mismatch("a number", v)),
            (Column::List(_), Some(v)) => return Err(mismatch("an array", v)),
            (Column::Struct(_), Some(v)) => return Err(mismatch("an object", v)),
        }
        Ok(())
    }

    pub(super) fn finish(&mut self) -> Result<ArrayRef> {
        Ok(match self {
            Column::Bool(b) => Arc::new(b.finish()),
            Column::Int(b) => Arc::new(b.finish()),
            Column::Float(b) => Arc::new(b.finish()),
            Column::Text(b) => Arc::new(b.finish()),
            Column::List(l) => l.finish()?,
            Column::Struct(s) => s.finish()?,
        })
    }
}

/// Collects records into batches with the columns of `out` (a projection of
/// the file schema); the other members of a record are ignored.
pub struct BatchBuilder {
    out: SchemaRef,
    columns: Vec<Column>,
    slot: HashMap<String, usize>,
    rows: usize,
    found: Vec<Option<usize>>,
}

impl BatchBuilder {
    pub fn new(out: SchemaRef) -> Result<Self> {
        let columns = out.fields().iter().map(|f| Column::new(f.data_type())).collect::<Result<Vec<_>>>()?;
        let slot = out.fields().iter().enumerate().map(|(i, f)| (f.name().clone(), i)).collect();
        let found = vec![None; columns.len()];
        Ok(Self { out, columns, slot, rows: 0, found })
    }

    pub fn len(&self) -> usize {
        self.rows
    }

    pub fn is_empty(&self) -> bool {
        self.rows == 0
    }

    pub fn push(&mut self, members: &[Member]) -> Result<()> {
        self.found.iter_mut().for_each(|f| *f = None);
        for (i, (k, _)) in members.iter().enumerate() {
            if let Some(&c) = self.slot.get(k.as_ref()) {
                self.found[c] = Some(i); // a repeated name: the last one wins
            }
        }
        for (c, col) in self.columns.iter_mut().enumerate() {
            col.push(self.found[c].map(|i| &members[i].1), self.out.field(c).name())?;
        }
        self.rows += 1;
        Ok(())
    }

    pub fn finish(&mut self) -> Result<RecordBatch> {
        let arrays = self.columns.iter_mut().map(Column::finish).collect::<Result<Vec<ArrayRef>>>()?;
        let opts = RecordBatchOptions::new().with_row_count(Some(self.rows));
        self.rows = 0;
        Ok(RecordBatch::try_new_with_options(self.out.clone(), arrays, &opts)?)
    }
}
