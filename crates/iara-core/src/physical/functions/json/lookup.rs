//! Reading values out of JSON text along a path.

use arrow::array::{Array, ArrayRef, Int64Array, StringArray, StringBuilder};
use arrow::array::AsArray;

use super::path::Step;
use crate::error::Result;
use crate::io::json::escape_into;
use crate::io::json::parse::{Member, Parser, Value};

/// The value at `steps` in `text`, if there is one.
fn find<'a>(text: &'a str, steps: &[Step]) -> Result<Option<Value<'a>>> {
    let mut v = Parser::whole(text.trim())?;
    for step in steps {
        let Value::Raw(raw) = v else { return Ok(None) };
        let next = match step {
            Step::Key(k) => member(raw, k)?,
            Step::Index(i) => element(raw, Some(*i), None)?,
            Step::FromEnd(n) => element(raw, None, Some(*n))?,
        };
        match next {
            Some(n) => v = n,
            None => return Ok(None),
        }
    }
    Ok(Some(v))
}

/// The member `key` of the object `raw` (the last one if repeated).
fn member<'a>(raw: &'a str, key: &str) -> Result<Option<Value<'a>>> {
    if !raw.starts_with('{') {
        return Ok(None);
    }
    let mut members: Vec<Member> = vec![];
    Parser::new(raw.as_bytes()).object(&mut members)?;
    Ok(members.into_iter().rev().find(|(k, _)| k == key).map(|(_, v)| v))
}

/// An element of the array `raw`: position `from_start` (0-based) or `from_end` (1 is the last).
fn element<'a>(raw: &'a str, from_start: Option<usize>, from_end: Option<usize>) -> Result<Option<Value<'a>>> {
    if !raw.starts_with('[') {
        return Ok(None);
    }
    let mut items = elements(raw)?;
    let at = match (from_start, from_end) {
        (Some(i), _) => i,
        (_, Some(n)) if n <= items.len() => items.len() - n,
        _ => return Ok(None),
    };
    Ok((at < items.len()).then(|| items.swap_remove(at)))
}

fn elements(raw: &str) -> Result<Vec<Value<'_>>> {
    let mut p = Parser::new(raw.as_bytes());
    let (mut out, mut more) = (vec![], p.array_open()?);
    while more {
        out.push(p.value()?);
        more = p.array_next()?;
    }
    Ok(out)
}

/// A value as JSON text.
fn json_of(v: &Value) -> String {
    match v {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Num(n) => n.to_string(),
        Value::Str(s) => {
            let mut out = String::with_capacity(s.len() + 2);
            escape_into(s, &mut out);
            out
        }
        Value::Raw(r) => minify(r),
    }
}

/// An object or array without the whitespace between its tokens (DuckDB prints it so).
fn minify(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let (mut in_string, mut escaped) = (false, false);
    for c in raw.chars() {
        match (in_string, c) {
            (true, _) if escaped => escaped = false,
            (true, '\\') => escaped = true,
            (true, '"') => in_string = false,
            (false, '"') => in_string = true,
            (false, c) if c.is_ascii_whitespace() => continue,
            _ => {}
        }
        out.push(c);
    }
    out
}

/// A value as a string: strings unquoted, JSON null is NULL.
fn text_of(v: &Value) -> Option<String> {
    match v {
        Value::Null => None,
        Value::Str(s) => Some(s.to_string()),
        other => Some(json_of(other)),
    }
}

fn map_rows(input: &ArrayRef, mut f: impl FnMut(&str) -> Result<Option<String>>) -> Result<ArrayRef> {
    let strings = input.as_string::<i32>();
    let mut out = StringBuilder::with_capacity(strings.len(), strings.value_data().len() / 2 + 16);
    for i in 0..strings.len() {
        match strings.is_valid(i).then(|| f(strings.value(i))).transpose()?.flatten() {
            Some(s) => out.append_value(s),
            None => out.append_null(),
        }
    }
    Ok(std::sync::Arc::new(out.finish()))
}

/// `json_extract(text, path)`: the value as JSON text.
pub fn extract(input: &ArrayRef, steps: &[Step]) -> Result<ArrayRef> {
    map_rows(input, |t| Ok(find(t, steps)?.map(|v| json_of(&v))))
}

/// `json_extract_string(text, path)`: the value as a string.
pub fn extract_string(input: &ArrayRef, steps: &[Step]) -> Result<ArrayRef> {
    map_rows(input, |t| Ok(find(t, steps)?.and_then(|v| text_of(&v))))
}

/// `json_array_length(text[, path])`: the length of an array, 0 for any other value.
pub fn array_length(input: &ArrayRef, steps: &[Step]) -> Result<ArrayRef> {
    let strings: &StringArray = input.as_string::<i32>();
    let mut out: Vec<Option<i64>> = Vec::with_capacity(strings.len());
    for i in 0..strings.len() {
        let len = match strings.is_valid(i) {
            false => None,
            true => find(strings.value(i), steps)?.map(|v| match v {
                Value::Raw(r) if r.starts_with('[') => elements(r).map(|e| e.len() as i64),
                _ => Ok(0),
            }).transpose()?,
        };
        out.push(len);
    }
    Ok(std::sync::Arc::new(Int64Array::from(out)))
}
