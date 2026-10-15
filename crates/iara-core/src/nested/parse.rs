//! Parsing nested type names: `INT[]`, `LIST<INT>`, `ARRAY(VARCHAR)`,
//! `STRUCT(a INT, b VARCHAR[])`, `struct<a:int, b:string>`, `ROW(a INT)`.

use arrow::datatypes::DataType;

use super::{list_of, struct_of};
use crate::error::{Result, WhError};

/// The nested type `s` names, or `None` when `s` is a plain type. `parse`
/// reads the inner types (it is the caller's `parse_data_type`).
pub fn parse_nested_type(s: &str, parse: &dyn Fn(&str) -> Result<DataType>) -> Result<Option<DataType>> {
    let s = s.trim();
    if let Some(inner) = s.strip_suffix("[]") {
        return Ok(Some(list_of(parse(inner)?)));
    }
    for open in ["list", "array"] {
        if let Some(inner) = bracketed(s, open) {
            return Ok(Some(list_of(parse(inner)?)));
        }
    }
    for open in ["struct", "row"] {
        if let Some(inner) = bracketed(s, open) {
            return Ok(Some(parse_fields(inner, parse)?));
        }
    }
    Ok(None)
}

/// The text inside `name<..>` or `name(..)` (the keyword is case-insensitive).
fn bracketed<'a>(s: &'a str, name: &str) -> Option<&'a str> {
    if s.len() < name.len() + 2 || !s.is_char_boundary(name.len()) || !s[..name.len()].eq_ignore_ascii_case(name) {
        return None;
    }
    let rest = s[name.len()..].trim_start();
    let (open, close) = match rest.chars().next()? {
        '<' => ('<', '>'),
        '(' => ('(', ')'),
        _ => return None,
    };
    let inner = rest.strip_prefix(open)?.strip_suffix(close)?;
    Some(inner)
}

fn parse_fields(inner: &str, parse: &dyn Fn(&str) -> Result<DataType>) -> Result<DataType> {
    let mut fields = vec![];
    for part in split_top_level(inner) {
        let (name, ty) = split_field(part.trim())?;
        if fields.iter().any(|(n, _): &(String, DataType)| n.eq_ignore_ascii_case(&name)) {
            return Err(WhError::Plan(format!("struct type has the field '{name}' twice")));
        }
        fields.push((name, parse(ty)?));
    }
    if fields.is_empty() {
        return Err(WhError::Plan("a struct type needs at least one field".into()));
    }
    Ok(struct_of(fields))
}

/// `a INT`, `a: INT`, `"a b" INT`: the field name and the type text.
fn split_field(part: &str) -> Result<(String, &str)> {
    let bad = || WhError::Plan(format!("invalid struct field '{part}', expected 'name type'"));
    let (name, rest) = match part.strip_prefix('"') {
        Some(q) => {
            let end = q.find('"').ok_or_else(bad)?;
            (q[..end].to_string(), &q[end + 1..])
        }
        None => {
            let end = part.find(|c: char| c.is_whitespace() || c == ':').ok_or_else(bad)?;
            (part[..end].to_string(), &part[end..])
        }
    };
    let ty = rest.trim_start().trim_start_matches(':').trim();
    if name.is_empty() || ty.is_empty() {
        return Err(bad());
    }
    Ok((name, ty))
}

/// Split at commas that are not inside `()`, `<>` or quotes.
fn split_top_level(s: &str) -> Vec<&str> {
    let (mut parts, mut depth, mut quoted, mut start) = (vec![], 0i32, false, 0);
    for (i, c) in s.char_indices() {
        match c {
            '"' => quoted = !quoted,
            '(' | '<' if !quoted => depth += 1,
            ')' | '>' if !quoted => depth -= 1,
            ',' if !quoted && depth == 0 => {
                parts.push(&s[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&s[start..]);
    parts
}
