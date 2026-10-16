//! JSON paths: `$.a.b[0]`, `$."a b"`, `$.list[#-1]`, a bare key (`a`) or an
//! array position (`2`).

use crate::error::{Result, WhError};

#[derive(Debug, Clone, PartialEq)]
pub enum Step {
    Key(String),
    /// 0-based from the start
    Index(usize),
    /// 1 is the last element
    FromEnd(usize),
}

fn bad(path: &str, why: &str) -> WhError {
    WhError::Plan(format!("invalid JSON path '{path}': {why}"))
}

/// The steps of a path given as text.
pub fn parse(path: &str) -> Result<Vec<Step>> {
    let Some(rest) = path.strip_prefix('$') else { return Ok(vec![Step::Key(path.to_string())]) };
    let mut steps = vec![];
    let mut s = rest;
    while !s.is_empty() {
        if let Some(r) = s.strip_prefix('.') {
            let (key, after) = key(r).ok_or_else(|| bad(path, "expected a field name after '.'"))?;
            steps.push(Step::Key(key));
            s = after;
        } else if let Some(r) = s.strip_prefix('[') {
            let end = r.find(']').ok_or_else(|| bad(path, "missing ']'"))?;
            steps.push(subscript(path, &r[..end])?);
            s = &r[end + 1..];
        } else {
            return Err(bad(path, "expected '.' or '['"));
        }
    }
    Ok(steps)
}

/// A field name at the start of `s` (quoted or not) and the rest.
fn key(s: &str) -> Option<(String, &str)> {
    if let Some(q) = s.strip_prefix('"') {
        let end = q.find('"')?;
        return Some((q[..end].to_string(), &q[end + 1..]));
    }
    let end = s.find(['.', '[']).unwrap_or(s.len());
    (end > 0).then(|| (s[..end].to_string(), &s[end..]))
}

fn subscript(path: &str, inner: &str) -> Result<Step> {
    let inner = inner.trim();
    if let Some(n) = inner.strip_prefix("#-") {
        let n: usize = n.trim().parse().map_err(|_| bad(path, "bad position after '#-'"))?;
        return Ok(Step::FromEnd(n.max(1)));
    }
    if let Some(q) = inner.strip_prefix('\'').and_then(|q| q.strip_suffix('\'')).or_else(|| inner.strip_prefix('"').and_then(|q| q.strip_suffix('"'))) {
        return Ok(Step::Key(q.to_string()));
    }
    match inner.parse::<i64>() {
        Ok(n) if n >= 0 => Ok(Step::Index(n as usize)),
        Ok(n) => Ok(Step::FromEnd(n.unsigned_abs() as usize)),
        Err(_) => Err(bad(path, "expected a position, '#-n' or a quoted name inside [..]")),
    }
}

/// An array position given as a number (`json -> 1`).
pub fn position(n: i64) -> Step {
    if n >= 0 { Step::Index(n as usize) } else { Step::FromEnd(n.unsigned_abs() as usize) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths() {
        use Step::*;
        assert_eq!(parse("$").unwrap(), vec![]);
        assert_eq!(parse("$.a.b[2].c").unwrap(), vec![Key("a".into()), Key("b".into()), Index(2), Key("c".into())]);
        assert_eq!(parse("$.\"a b\"[#-1]").unwrap(), vec![Key("a b".into()), FromEnd(1)]);
        assert_eq!(parse("$['x y'][-2]").unwrap(), vec![Key("x y".into()), FromEnd(2)]);
        assert_eq!(parse("name").unwrap(), vec![Key("name".into())]);
        assert!(parse("$a").is_err());
        assert!(parse("$.a[").is_err());
        assert!(parse("$.a[x]").is_err());
        assert!(parse("$.").is_err());
    }
}
