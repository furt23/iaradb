//! Regex kernels. Semantics follow DuckDB for SQL:
//! - `regexp_replace` replaces the first match unless the `g` flag is given;
//!   the replacement uses `\1` back-references (flag `r` = Rust `$1` syntax,
//!   used by the Python API).
//! - `regexp_extract` returns '' when nothing matches (flag `n` = NULL, as
//!   Polars does).
//! - flags: `i` case-insensitive, `c` case-sensitive, `l` literal, `s` dot
//!   matches newline, `m` multi-line anchors, `g` global.
//!
//! Each distinct (pattern, flags) is compiled once and cached, so the planner
//! compiles a literal once and batches reuse it.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock};

use arrow::array::*;
use parking_lot::Mutex;
use regex::{Regex, RegexBuilder};

use crate::error::{Result, WhError};
use crate::physical::expr::ColumnarValue;

type Key = (String, String);
static CACHE: LazyLock<Mutex<HashMap<Key, Arc<Regex>>>> = LazyLock::new(Default::default);

/// Parsed flag string.
#[derive(Default)]
pub struct Opts {
    key: String,
    global: bool,
    raw_repl: bool,
    literal: bool,
    null_on_miss: bool,
}

impl Opts {
    pub fn parse(flags: &str) -> Result<Self> {
        let mut o = Opts::default();
        for c in flags.chars() {
            match c {
                'i' | 'c' | 's' | 'm' => o.key.push(c),
                'l' => {
                    o.key.push(c);
                    o.literal = true;
                }
                'g' => o.global = true,
                'r' => o.raw_repl = true,
                'n' => o.null_on_miss = true,
                other => return Err(WhError::Plan(format!("unknown regex flag '{other}'"))),
            }
        }
        Ok(o)
    }
}

pub fn compile(pat: &str, flags: &str) -> Result<Arc<Regex>> {
    let o = Opts::parse(flags)?;
    regex_for(pat, &o)
}

fn regex_for(pat: &str, o: &Opts) -> Result<Arc<Regex>> {
    let key = (pat.to_string(), o.key.clone());
    if let Some(r) = CACHE.lock().get(&key) {
        return Ok(r.clone());
    }
    let src = if o.literal { regex::escape(pat) } else { pat.to_string() };
    let mut b = RegexBuilder::new(&src);
    b.case_insensitive(o.key.contains('i') && !o.key.contains('c'))
        .dot_matches_new_line(o.key.contains('s'))
        .multi_line(o.key.contains('m'));
    let re = Arc::new(b.build().map_err(|e| WhError::Plan(format!("invalid regex '{pat}': {e}")))?);
    let mut cache = CACHE.lock();
    if cache.len() > 512 {
        cache.clear();
    }
    cache.insert(key, re.clone());
    Ok(re)
}

/// The group index must exist in the pattern.
pub fn check_group(pat: &str, flags: &str, group: i64) -> Result<()> {
    let re = compile(pat, flags)?;
    if group < 0 || group as usize >= re.captures_len() {
        return Err(WhError::Plan(format!("regexp_extract: pattern '{pat}' has no group {group}")));
    }
    Ok(())
}

fn const_str(v: Option<&ColumnarValue>) -> Result<Option<String>> {
    match v {
        None => Ok(Some(String::new())),
        Some(ColumnarValue::Scalar(s)) => Ok(s.as_str().map(str::to_string)),
        Some(_) => Err(WhError::NotSupported("regex pattern and flags must be constants".into())),
    }
}

/// Regex and options for a call: pattern at `args[1]`, flags at `flags_at`.
/// `None` when the pattern is NULL (result is all NULL).
fn setup(args: &[ColumnarValue], flags_at: usize) -> Result<Option<(Arc<Regex>, Opts)>> {
    let flags = const_str(args.get(flags_at))?.unwrap_or_default();
    let o = Opts::parse(&flags)?;
    let Some(pat) = const_str(args.get(1))? else { return Ok(None) };
    Ok(Some((regex_for(&pat, &o)?, o)))
}

fn subject(args: &[ColumnarValue], m: usize) -> Result<ArrayRef> {
    args[0].clone().into_array(m)
}

/// The rows of a Utf8 or Utf8View subject.
fn texts(a: &ArrayRef) -> Box<dyn Iterator<Item = Option<&str>> + '_> {
    match a.as_string_view_opt() {
        Some(v) => Box::new(v.iter()),
        None => Box::new(a.as_string::<i32>().iter()),
    }
}

/// Bytes of the subject's strings (an output capacity).
fn text_bytes(a: &ArrayRef) -> usize {
    match a.as_string_view_opt() {
        Some(v) => v.total_buffer_bytes_used().max(v.len() * 8),
        None => a.as_string::<i32>().value_data().len(),
    }
}

pub fn like(args: &[ColumnarValue], m: usize) -> Result<ArrayRef> {
    let Some((re, _)) = setup(args, 2)? else { return Ok(new_null_array(&arrow::datatypes::DataType::Boolean, m)) };
    let a = subject(args, m)?;
    let out: BooleanArray = texts(&a).map(|v| v.map(|s| re.is_match(s))).collect();
    Ok(Arc::new(out))
}

pub fn count(args: &[ColumnarValue], m: usize) -> Result<ArrayRef> {
    let Some((re, _)) = setup(args, 2)? else { return Ok(new_null_array(&arrow::datatypes::DataType::Int64, m)) };
    let a = subject(args, m)?;
    let out: Int64Array = texts(&a).map(|v| v.map(|s| re.find_iter(s).count() as i64)).collect();
    Ok(Arc::new(out))
}

pub fn extract(args: &[ColumnarValue], m: usize) -> Result<ArrayRef> {
    let flags_at = 3;
    let Some((re, o)) = setup(args, flags_at)? else { return Ok(new_null_array(&arrow::datatypes::DataType::Utf8, m)) };
    let group = match args.get(2) {
        Some(ColumnarValue::Scalar(s)) => s.as_i64().unwrap_or(0) as usize,
        _ => 0,
    };
    let a = subject(args, m)?;
    let mut b = StringBuilder::with_capacity(a.len(), text_bytes(&a));
    // capture slots reused across rows (no allocation per row)
    let mut locs = re.capture_locations();
    for v in texts(&a) {
        let Some(text) = v else {
            b.append_null();
            continue;
        };
        let hit = if group == 0 {
            re.find(text).map(|x| x.as_str())
        } else {
            re.captures_read(&mut locs, text).and_then(|_| locs.get(group)).map(|(x, y)| &text[x..y])
        };
        match hit {
            Some(h) => b.append_value(h),
            None if o.null_on_miss => b.append_null(),
            None => b.append_value(""),
        }
    }
    Ok(Arc::new(b.finish()))
}

pub fn replace(args: &[ColumnarValue], m: usize) -> Result<ArrayRef> {
    let Some((re, o)) = setup(args, 3)? else { return Ok(new_null_array(&arrow::datatypes::DataType::Utf8, m)) };
    let Some(rep) = const_str(args.get(2))? else { return Ok(new_null_array(&arrow::datatypes::DataType::Utf8, m)) };
    let a = subject(args, m)?;
    let mut b = StringBuilder::with_capacity(a.len(), text_bytes(&a));
    if !o.global && !o.raw_repl {
        // the first match: its capture slots reused across rows, the
        // replacement written straight into the output
        let pieces = pieces(&rep, &o);
        let mut locs = re.capture_locations();
        let mut out = String::new();
        for v in texts(&a) {
            let Some(text) = v else {
                b.append_null();
                continue;
            };
            let Some(m) = re.captures_read(&mut locs, text) else {
                b.append_value(text);
                continue;
            };
            out.clear();
            out.push_str(&text[..m.start()]);
            for p in &pieces {
                match p {
                    Piece::Text(t) => out.push_str(t),
                    Piece::Group(g) => {
                        if let Some((x, y)) = locs.get(*g) {
                            out.push_str(&text[x..y]);
                        }
                    }
                }
            }
            out.push_str(&text[m.end()..]);
            b.append_value(&out);
        }
        return Ok(Arc::new(b.finish()));
    }
    let rep = replacement(&rep, &o);
    for v in texts(&a) {
        match v {
            None => b.append_null(),
            Some(text) => {
                let r = if o.global { re.replace_all(text, rep.as_str()) } else { re.replace(text, rep.as_str()) };
                b.append_value(r)
            }
        }
    }
    Ok(Arc::new(b.finish()))
}

enum Piece {
    Text(String),
    Group(usize),
}

/// A SQL replacement (`\1` back-references, `\\` for a backslash) as
/// literal text and group references.
fn pieces(rep: &str, o: &Opts) -> Vec<Piece> {
    if o.literal {
        return vec![Piece::Text(rep.to_string())];
    }
    let mut out = vec![];
    let mut text = String::new();
    let mut it = rep.chars().peekable();
    while let Some(c) = it.next() {
        match (c, it.peek().copied()) {
            ('\\', Some(d)) if d.is_ascii_digit() => {
                it.next();
                if !text.is_empty() {
                    out.push(Piece::Text(std::mem::take(&mut text)));
                }
                out.push(Piece::Group(d as usize - '0' as usize));
            }
            ('\\', Some('\\')) => {
                it.next();
                text.push('\\');
            }
            (c, _) => text.push(c),
        }
    }
    if !text.is_empty() {
        out.push(Piece::Text(text));
    }
    out
}

/// Translate the user's replacement into the `regex` crate's syntax.
fn replacement(rep: &str, o: &Opts) -> String {
    if o.raw_repl && !o.literal {
        return rep.to_string();
    }
    let mut out = String::with_capacity(rep.len() + 4);
    let mut it = rep.chars().peekable();
    while let Some(c) = it.next() {
        match c {
            '$' => out.push_str("$$"),
            '\\' if !o.literal => match it.peek().copied() {
                Some(d) if d.is_ascii_digit() => {
                    it.next();
                    out.push_str(&format!("${{{d}}}"));
                }
                Some('\\') => {
                    it.next();
                    out.push('\\');
                }
                _ => out.push('\\'),
            },
            c => out.push(c),
        }
    }
    out
}
