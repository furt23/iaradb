//! Schema inference for JSON records: boolean, Int64, Float64 or Utf8, and
//! nested objects and arrays as `Struct<..>` and `List<..>` (or, with
//! `nested = "text"`, as their JSON text). The shapes seen in the sample are
//! merged: a field missing from some records is simply nullable, Int64 and
//! Float64 make Float64, and anything else that conflicts (a number and a
//! string, an object and an array, ...) is read as Utf8 JSON text. A column
//! that only holds nulls is Utf8 too.

use arrow::datatypes::{DataType, Field, Schema};

use super::JsonNested;
use super::parse::{Member, Parser, Value};
use crate::error::Result;
use crate::nested::{list_of, struct_of};

#[derive(Debug, Clone, PartialEq)]
enum Shape {
    /// Only nulls (or empty arrays) seen so far.
    Unknown,
    Bool,
    Int,
    Float,
    Text,
    List(Box<Shape>),
    Struct(Vec<(String, Shape)>),
}

impl Shape {
    fn of(v: &Value, nested: JsonNested) -> Result<Shape> {
        Ok(match v {
            Value::Null => Shape::Unknown,
            Value::Bool(_) => Shape::Bool,
            Value::Num(n) if n.parse::<i64>().is_ok() => Shape::Int,
            Value::Num(_) => Shape::Float,
            Value::Str(_) => Shape::Text,
            Value::Raw(_) if nested == JsonNested::Text => Shape::Text,
            Value::Raw(text) => Shape::of_nested(text, nested)?,
        })
    }

    /// The shape of the object or array `text`.
    fn of_nested(text: &str, nested: JsonNested) -> Result<Shape> {
        let mut p = Parser::new(text.as_bytes());
        if text.starts_with('{') {
            let mut members: Vec<Member> = vec![];
            p.object(&mut members)?;
            let mut fields: Vec<(String, Shape)> = vec![];
            for (k, v) in &members {
                add_field(&mut fields, k, Shape::of(v, nested)?);
            }
            return Ok(Shape::Struct(fields));
        }
        let mut elem = Shape::Unknown;
        let mut more = p.array_open()?;
        while more {
            elem = elem.merge(Shape::of(&p.value()?, nested)?);
            more = p.array_next()?;
        }
        Ok(Shape::List(Box::new(elem)))
    }

    fn merge(self, other: Shape) -> Shape {
        use Shape::*;
        match (self, other) {
            (Unknown, b) => b,
            (a, Unknown) => a,
            (Int, Float) | (Float, Int) => Float,
            (List(a), List(b)) => List(Box::new(a.merge(*b))),
            (Struct(mut a), Struct(b)) => {
                for (k, s) in b {
                    add_field(&mut a, &k, s);
                }
                Struct(a)
            }
            (a, b) if a == b => a,
            _ => Text,
        }
    }

    fn data_type(&self) -> DataType {
        match self {
            Shape::Bool => DataType::Boolean,
            Shape::Int => DataType::Int64,
            Shape::Float => DataType::Float64,
            Shape::Unknown | Shape::Text => DataType::Utf8,
            Shape::List(e) => list_of(e.data_type()),
            // a struct needs fields: `{}` is read as text
            Shape::Struct(f) if f.is_empty() => DataType::Utf8,
            Shape::Struct(f) => struct_of(f.iter().map(|(n, s)| (n.clone(), s.data_type()))),
        }
    }
}

/// Merge `shape` into the field `name` of `fields` (added at the end if new).
fn add_field(fields: &mut Vec<(String, Shape)>, name: &str, shape: Shape) {
    match fields.iter_mut().find(|(n, _)| n == name) {
        Some((_, s)) => *s = std::mem::replace(s, Shape::Unknown).merge(shape),
        None => fields.push((name.to_string(), shape)),
    }
}

/// The schema of the records in `lines` (one JSON object each), looking at
/// the first `max_rows`. Columns are in order of first appearance.
pub fn infer_schema<'a>(lines: impl Iterator<Item = &'a [u8]>, max_rows: usize, nested: JsonNested) -> Result<Schema> {
    let mut cols: Vec<(String, Shape)> = vec![];
    let mut index = std::collections::HashMap::<String, usize>::new();
    let mut members: Vec<Member> = vec![];
    for line in lines.take(max_rows) {
        Parser::new(line).object(&mut members)?;
        for (k, v) in &members {
            let i = *index.entry(k.to_string()).or_insert_with(|| {
                cols.push((k.to_string(), Shape::Unknown));
                cols.len() - 1
            });
            cols[i].1 = std::mem::replace(&mut cols[i].1, Shape::Unknown).merge(Shape::of(v, nested)?);
        }
    }
    Ok(Schema::new(cols.into_iter().map(|(n, s)| Field::new(n, s.data_type(), true)).collect::<Vec<_>>()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn types_with(lines: &[&str], nested: JsonNested) -> Vec<DataType> {
        let s = infer_schema(lines.iter().map(|l| l.as_bytes()), 100, nested).unwrap();
        s.fields().iter().map(|f| f.data_type().clone()).collect()
    }

    fn types(lines: &[&str]) -> Vec<DataType> {
        types_with(lines, JsonNested::Auto)
    }

    #[test]
    fn kinds_merge() {
        use DataType::*;
        assert_eq!(types(&[r#"{"a":1,"b":true,"c":"x","d":null}"#, r#"{"a":2.5,"b":false,"c":3,"e":null}"#]), vec![Float64, Boolean, Utf8, Utf8, Utf8]);
        assert_eq!(types(&[r#"{"a":1}"#, r#"{"a":9223372036854775808}"#]), vec![Float64]);
    }

    #[test]
    fn objects_and_arrays_become_structs_and_lists() {
        use DataType::*;
        let s = |f: &[(&str, DataType)]| struct_of(f.iter().map(|(n, t)| (n.to_string(), t.clone())));
        assert_eq!(types(&[r#"{"a":{"x":1,"y":"s"},"l":[1,2],"m":[]}"#]), vec![s(&[("x", Int64), ("y", Utf8)]), list_of(Int64), list_of(Utf8)]);
        // fields missing from some records join the struct, ints and floats merge
        assert_eq!(types(&[r#"{"a":{"x":1}}"#, r#"{"a":{"y":[{"z":true}],"x":2.5}}"#]), vec![s(&[("x", Float64), ("y", list_of(s(&[("z", Boolean)])))])]);
        // conflicts become text, for that field only
        assert_eq!(types(&[r#"{"a":{"x":1,"y":2},"b":[1]}"#, r#"{"a":{"x":"s","y":3},"b":{"k":1}}"#]), vec![s(&[("x", Utf8), ("y", Int64)]), Utf8]);
        assert_eq!(types(&[r#"{"a":[1,"x"],"b":{}}"#]), vec![list_of(Utf8), Utf8]);
    }

    #[test]
    fn nested_text_keeps_the_old_behavior() {
        use DataType::*;
        assert_eq!(types_with(&[r#"{"a":{"x":1},"l":[1,2]}"#], JsonNested::Text), vec![Utf8, Utf8]);
    }
}
