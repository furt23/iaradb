//! A small JSON reader for the lines of an NDJSON file: an object's top-level
//! members, with nested objects and arrays kept as their source text.

use std::borrow::Cow;

use crate::error::{Result, WhError};

#[derive(Debug, Clone, PartialEq)]
pub enum Value<'a> {
    Null,
    Bool(bool),
    /// A number, as written.
    Num(&'a str),
    Str(Cow<'a, str>),
    /// A nested object or array, as written.
    Raw(&'a str),
}

pub type Member<'a> = (Cow<'a, str>, Value<'a>);

/// A decimal number as Rust's `f64` parser reads one (what was accepted
/// before): `[+-]? (digits [. digits*] | . digits) [(e|E) [+-]? digits]`,
/// checked without converting it (the column converts it once).
fn is_number(b: &[u8]) -> bool {
    let digits = |i: &mut usize| {
        let s = *i;
        while *i < b.len() && b[*i].is_ascii_digit() {
            *i += 1;
        }
        *i > s
    };
    let mut i = usize::from(matches!(b.first(), Some(b'+' | b'-')));
    let int = digits(&mut i);
    let frac = if b.get(i) == Some(&b'.') {
        i += 1;
        digits(&mut i)
    } else {
        false
    };
    if !int && !frac {
        return false;
    }
    if matches!(b.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(b.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        if !digits(&mut i) {
            return false;
        }
    }
    i == b.len()
}

fn err(msg: impl std::fmt::Display, at: usize) -> WhError {
    WhError::Execution(format!("invalid JSON: {msg} (at byte {at} of the record)"))
}

pub struct Parser<'a> {
    s: &'a [u8],
    pos: usize,
    /// `s` is known to be UTF-8: its strings are not checked one by one
    utf8: bool,
}

impl<'a> Parser<'a> {
    pub fn new(s: &'a [u8]) -> Self {
        Self { s, pos: 0, utf8: false }
    }

    /// A parser over text already checked to be UTF-8 (all of it at once is
    /// much faster than every string on its own).
    pub fn utf8(s: &'a [u8], checked: bool) -> Self {
        Self { s, pos: 0, utf8: checked }
    }

    /// `s[start..end]` as text; both ends are at ASCII bytes of the JSON
    /// syntax (quotes, brackets, a number's ends), so on char boundaries.
    fn text(&self, start: usize, end: usize) -> Result<&'a str> {
        let b = &self.s[start..end];
        if self.utf8 {
            // SAFETY: `s` is UTF-8 and both ends are char boundaries
            return Ok(unsafe { std::str::from_utf8_unchecked(b) });
        }
        std::str::from_utf8(b).map_err(|_| err("invalid UTF-8", start))
    }

    pub fn at_end(&mut self) -> bool {
        self.skip_ws();
        self.pos >= self.s.len()
    }

    fn skip_ws(&mut self) {
        while self.pos < self.s.len() && matches!(self.s[self.pos], b' ' | b'\t' | b'\r' | b'\n') {
            self.pos += 1;
        }
    }

    fn peek(&mut self) -> Option<u8> {
        self.skip_ws();
        self.s.get(self.pos).copied()
    }

    fn expect(&mut self, c: u8) -> Result<()> {
        match self.peek() {
            Some(b) if b == c => {
                self.pos += 1;
                Ok(())
            }
            Some(b) => Err(err(format!("expected '{}', found '{}'", c as char, b as char), self.pos)),
            None => Err(err(format!("expected '{}', found the end", c as char), self.pos)),
        }
    }

    /// The members of the object at the cursor, appended to `out`.
    pub fn object(&mut self, out: &mut Vec<Member<'a>>) -> Result<()> {
        out.clear();
        self.expect(b'{')?;
        if self.peek() == Some(b'}') {
            self.pos += 1;
            return Ok(());
        }
        loop {
            if self.peek() != Some(b'"') {
                return Err(err("expected a member name", self.pos));
            }
            let key = self.string()?;
            self.expect(b':')?;
            out.push((key, self.value()?));
            match self.peek() {
                Some(b',') => self.pos += 1,
                Some(b'}') => {
                    self.pos += 1;
                    return Ok(());
                }
                _ => return Err(err("expected ',' or '}'", self.pos)),
            }
        }
    }

    /// The source text of the value at the cursor (any kind), moving past it.
    pub fn skip_value(&mut self) -> Result<&'a str> {
        self.skip_ws();
        let start = self.pos;
        self.value()?;
        self.text(start, self.pos)
    }

    /// The whole of `text` as one value (nothing may follow it).
    pub fn whole(text: &'a str) -> Result<Value<'a>> {
        let mut p = Parser::new(text.as_bytes());
        let v = p.value()?;
        if !p.at_end() {
            return Err(err("text after the value", p.pos));
        }
        Ok(v)
    }

    /// Move past the `[` of an array; whether it has elements.
    pub fn array_open(&mut self) -> Result<bool> {
        self.expect(b'[')?;
        if self.peek() == Some(b']') {
            self.pos += 1;
            return Ok(false);
        }
        Ok(true)
    }

    /// After an array element: true when another follows.
    pub fn array_next(&mut self) -> Result<bool> {
        match self.peek() {
            Some(b',') => {
                self.pos += 1;
                Ok(true)
            }
            Some(b']') => {
                self.pos += 1;
                Ok(false)
            }
            _ => Err(err("expected ',' or ']'", self.pos)),
        }
    }

    /// The value at the cursor; nested objects and arrays come as their text.
    pub fn value(&mut self) -> Result<Value<'a>> {
        let Some(c) = self.peek() else { return Err(err("expected a value", self.pos)) };
        match c {
            b'"' => Ok(Value::Str(self.string()?)),
            b'{' | b'[' => self.nested(),
            b't' => self.word("true", Value::Bool(true)),
            b'f' => self.word("false", Value::Bool(false)),
            b'n' => self.word("null", Value::Null),
            b'-' | b'0'..=b'9' => self.number(),
            other => Err(err(format!("unexpected '{}'", other as char), self.pos)),
        }
    }

    fn word(&mut self, w: &str, v: Value<'a>) -> Result<Value<'a>> {
        if self.s[self.pos..].starts_with(w.as_bytes()) {
            self.pos += w.len();
            Ok(v)
        } else {
            Err(err(format!("expected {w}"), self.pos))
        }
    }

    fn number(&mut self) -> Result<Value<'a>> {
        let start = self.pos;
        while self.pos < self.s.len() && matches!(self.s[self.pos], b'0'..=b'9' | b'-' | b'+' | b'.' | b'e' | b'E') {
            self.pos += 1;
        }
        let text = self.text(start, self.pos)?;
        if !is_number(text.as_bytes()) {
            return Err(err(format!("bad number '{text}'"), start));
        }
        Ok(Value::Num(text))
    }

    /// An object or array, kept as text: brackets are matched outside strings.
    fn nested(&mut self) -> Result<Value<'a>> {
        let start = self.pos;
        let mut depth = 0usize;
        while self.pos < self.s.len() {
            match self.s[self.pos] {
                b'{' | b'[' => depth += 1,
                b'}' | b']' => {
                    depth -= 1;
                    if depth == 0 {
                        self.pos += 1;
                        return Ok(Value::Raw(self.text(start, self.pos)?));
                    }
                }
                b'"' => {
                    self.skip_string()?;
                    continue;
                }
                _ => {}
            }
            self.pos += 1;
        }
        Err(err("unterminated object or array", start))
    }

    /// Move past the string at the cursor.
    fn skip_string(&mut self) -> Result<()> {
        let start = self.pos;
        self.pos += 1;
        while self.pos < self.s.len() {
            match self.s[self.pos] {
                b'\\' => self.pos += 2,
                b'"' => {
                    self.pos += 1;
                    return Ok(());
                }
                _ => self.pos += 1,
            }
        }
        Err(err("unterminated string", start))
    }

    fn string(&mut self) -> Result<Cow<'a, str>> {
        let start = self.pos + 1;
        let mut i = start;
        // the common case: no escapes, a slice of the input
        while i < self.s.len() && self.s[i] != b'"' && self.s[i] != b'\\' {
            i += 1;
        }
        match self.s.get(i) {
            Some(b'"') => {
                self.pos = i + 1;
                self.text(start, i).map(Cow::Borrowed)
            }
            Some(_) => self.escaped(start, i),
            None => Err(err("unterminated string", start - 1)),
        }
    }

    fn escaped(&mut self, start: usize, mut i: usize) -> Result<Cow<'a, str>> {
        let mut out: Vec<u8> = self.s[start..i].to_vec();
        while i < self.s.len() {
            match self.s[i] {
                b'"' => {
                    self.pos = i + 1;
                    return String::from_utf8(out).map(Cow::Owned).map_err(|_| err("invalid UTF-8", start));
                }
                b'\\' => {
                    let Some(&e) = self.s.get(i + 1) else { break };
                    i += 2;
                    match e {
                        b'"' | b'\\' | b'/' => out.push(e),
                        b'b' => out.push(8),
                        b'f' => out.push(12),
                        b'n' => out.push(b'\n'),
                        b'r' => out.push(b'\r'),
                        b't' => out.push(b'\t'),
                        b'u' => {
                            let (c, next) = self.unicode(i)?;
                            let mut buf = [0u8; 4];
                            out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
                            i = next;
                        }
                        other => return Err(err(format!("bad escape '\\{}'", other as char), i - 1)),
                    }
                }
                b => {
                    out.push(b);
                    i += 1;
                }
            }
        }
        Err(err("unterminated string", start - 1))
    }

    /// The character of a `\uXXXX` escape (its hex digits start at `i`), with a
    /// following low surrogate when needed; and the offset after it.
    fn unicode(&self, i: usize) -> Result<(char, usize)> {
        let hi = self.hex4(i)?;
        if !(0xD800..0xDC00).contains(&hi) {
            return Ok((char::from_u32(hi).unwrap_or('\u{FFFD}'), i + 4));
        }
        if self.s.get(i + 4) == Some(&b'\\') && self.s.get(i + 5) == Some(&b'u') {
            let lo = self.hex4(i + 6)?;
            if (0xDC00..0xE000).contains(&lo) {
                let c = 0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00);
                return Ok((char::from_u32(c).unwrap_or('\u{FFFD}'), i + 10));
            }
        }
        Ok(('\u{FFFD}', i + 4))
    }

    fn hex4(&self, i: usize) -> Result<u32> {
        let h = self.s.get(i..i + 4).and_then(|h| std::str::from_utf8(h).ok()).and_then(|h| u32::from_str_radix(h, 16).ok());
        h.ok_or_else(|| err("bad \\u escape", i))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_as_f64_reads_them() {
        for t in ["0", "-12", "+7", "3.25", "1.", ".5", "1e9", "2.5E-3", "-0.0e+1"] {
            assert!(is_number(t.as_bytes()) && t.parse::<f64>().is_ok(), "{t}");
        }
        for t in ["", "-", ".", "1e", "1e+", "1-2", "1.2.3", "e5", "--1", "1+"] {
            assert!(!is_number(t.as_bytes()) && t.parse::<f64>().is_err(), "{t}");
        }
    }

    fn members(line: &str) -> Vec<(String, Value<'_>)> {
        let mut out = vec![];
        Parser::new(line.as_bytes()).object(&mut out).unwrap();
        out.into_iter().map(|(k, v)| (k.into_owned(), v)).collect()
    }

    #[test]
    fn scalars_and_nested() {
        let m = members(r#" {"a": 1, "b": -2.5e3, "c": "x\ny", "d": null, "e": true, "f": {"k": [1, "}"]}, "g": [] } "#);
        assert_eq!(m[0].1, Value::Num("1"));
        assert_eq!(m[1].1, Value::Num("-2.5e3"));
        assert_eq!(m[2].1, Value::Str("x\ny".into()));
        assert_eq!(m[3].1, Value::Null);
        assert_eq!(m[4].1, Value::Bool(true));
        assert_eq!(m[5].1, Value::Raw(r#"{"k": [1, "}"]}"#));
        assert_eq!(m[6].1, Value::Raw("[]"));
    }

    #[test]
    fn unicode_escapes() {
        let m = members(r#"{"a": "café 😀 \"q\"", "b": "héllo 日本"}"#);
        assert_eq!(m[0].1, Value::Str("café \u{1F600} \"q\"".into()));
        assert_eq!(m[1].1, Value::Str("héllo 日本".into()));
    }

    #[test]
    fn errors() {
        let mut out = vec![];
        for bad in ["[1]", r#"{"a" 1}"#, r#"{"a": }"#, r#"{"a": "x"#, r#"{"a": tru}"#] {
            assert!(Parser::new(bad.as_bytes()).object(&mut out).is_err(), "{bad}");
        }
    }
}
