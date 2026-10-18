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

/// A pattern ending in a greedy `.*` (or `.*$`) split before it. The
/// capture search runs over the head's match only; the tail's span follows
/// from the text: up to the first line break (or the end, with the `s`
/// flag). `^https?://([^/]+)/.*$` then backtracks over the scheme and host,
/// not the whole URL.
struct Tail {
    head: Regex,
    /// the `.` also matches line breaks
    dot_nl: bool,
    /// the pattern ends with `$` (end of text)
    end: bool,
}

static TAILS: LazyLock<Mutex<HashMap<Key, Option<Arc<Tail>>>>> = LazyLock::new(Default::default);

fn tail_for(pat: &str, o: &Opts, full: &Regex) -> Option<Arc<Tail>> {
    let key = (pat.to_string(), o.key.clone());
    if let Some(t) = TAILS.lock().get(&key) {
        return t.clone();
    }
    let t = split_tail(pat, o, full).map(Arc::new);
    let mut cache = TAILS.lock();
    if cache.len() > 512 {
        cache.clear();
    }
    cache.insert(key, t.clone());
    t
}

fn split_tail(pat: &str, o: &Opts, full: &Regex) -> Option<Tail> {
    use regex_syntax::hir::{Dot, Hir, HirKind, Look};
    if o.literal || o.key.contains('m') {
        return None;
    }
    let hir = regex_syntax::ParserBuilder::new()
        .case_insensitive(o.key.contains('i') && !o.key.contains('c'))
        .dot_matches_new_line(o.key.contains('s'))
        .build()
        .parse(pat)
        .ok()?;
    let HirKind::Concat(parts) = hir.kind() else { return None };
    let end = matches!(parts.last()?.kind(), HirKind::Look(Look::End));
    let k = parts.len() - end as usize;
    let HirKind::Repetition(r) = parts.get(k.checked_sub(1)?)?.kind() else { return None };
    if r.min != 0 || r.max.is_some() || !r.greedy {
        return None;
    }
    let dot_nl = match r.sub.as_ref() {
        d if *d == Hir::dot(Dot::AnyChar) => true,
        d if *d == Hir::dot(Dot::AnyCharExceptLF) => false,
        _ => return None,
    };
    let head = Regex::new(&Hir::concat(parts[..k - 1].to_vec()).to_string()).ok()?;
    (head.captures_len() == full.captures_len()).then_some(Tail { head, dot_nl, end })
}

/// A regex's capture search: the split head (see [`Tail`]) when it
/// answers, the whole pattern otherwise.
struct Captures {
    full: Arc<Regex>,
    full_locs: regex::CaptureLocations,
    tail: Option<(Arc<Tail>, regex::CaptureLocations)>,
}

impl Captures {
    fn new(full: Arc<Regex>, pat: &str, o: &Opts) -> Self {
        let tail = tail_for(pat, o, &full).map(|t| {
            let locs = t.head.capture_locations();
            (t, locs)
        });
        Self { full_locs: full.capture_locations(), full, tail }
    }

    /// The first match's span and its groups.
    fn find(&mut self, text: &str) -> Option<((usize, usize), &regex::CaptureLocations)> {
        if let Some((t, locs)) = &mut self.tail {
            // no head match: no match of the whole either
            let m = t.head.captures_read(locs, text)?;
            let stop = if t.dot_nl { None } else { memchr::memchr(b'\n', &text.as_bytes()[m.end()..]) };
            match stop {
                None => return Some(((m.start(), text.len()), locs)),
                Some(i) if !t.end => return Some(((m.start(), m.end() + i), locs)),
                // `.*$` cannot cross the line break after this head match
                Some(_) => {}
            }
        }
        let m = self.full.captures_read(&mut self.full_locs, text)?;
        Some(((m.start(), m.end()), &self.full_locs))
    }
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
    Ok(setup_pattern(args, flags_at)?.map(|(re, o, _)| (re, o)))
}

/// [`setup`], and the pattern.
fn setup_pattern(args: &[ColumnarValue], flags_at: usize) -> Result<Option<(Arc<Regex>, Opts, String)>> {
    let flags = const_str(args.get(flags_at))?.unwrap_or_default();
    let o = Opts::parse(&flags)?;
    let Some(pat) = const_str(args.get(1))? else { return Ok(None) };
    Ok(Some((regex_for(&pat, &o)?, o, pat)))
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

/// Rows a memo sees before it judges whether repeats pay for it.
const MEMO_PROBE: usize = 512;

/// Results of a costly function by input string, within one batch: a
/// string that repeats (a URL or referer seen on many rows) is evaluated
/// once. The memo turns itself off when its first rows repeat too little.
struct Memo<'a, V> {
    map: hashbrown::HashMap<&'a str, V, foldhash::fast::FixedState>,
    rows: usize,
    hits: usize,
    on: bool,
}

impl<'a, V: Copy> Memo<'a, V> {
    fn new() -> Self {
        Self { map: hashbrown::HashMap::with_capacity_and_hasher(256, Default::default()), rows: 0, hits: 0, on: true }
    }

    fn get_or(&mut self, s: &'a str, f: impl FnOnce(&str) -> V) -> V {
        if !self.on {
            return f(s);
        }
        self.rows += 1;
        if let Some(&v) = self.map.get(s) {
            self.hits += 1;
            return v;
        }
        let v = f(s);
        self.map.insert(s, v);
        // under one repeat in ten: hashing costs more than it saves
        if self.rows == MEMO_PROBE && self.hits * 10 < MEMO_PROBE {
            self.on = false;
            self.map = Default::default();
        }
        v
    }
}

/// `f` over the subject's strings, once per distinct string (see [`Memo`]).
fn memo_map<V: Copy>(a: &ArrayRef, mut f: impl FnMut(&str) -> V, mut each: impl FnMut(Option<V>)) {
    let mut memo = Memo::new();
    for t in texts(a) {
        each(t.map(|t| memo.get_or(t, &mut f)));
    }
}

/// A Utf8 array of `f` over the subject's strings (`f` writes the value
/// and returns false for NULL), once per distinct string (see [`Memo`]).
fn map_texts(a: &ArrayRef, mut f: impl FnMut(&str, &mut String) -> bool) -> ArrayRef {
    let n = a.len();
    let mut offsets: Vec<i32> = Vec::with_capacity(n + 1);
    offsets.push(0);
    let mut data: Vec<u8> = Vec::with_capacity(n * 8);
    let mut valid = BooleanBufferBuilder::new(n);
    let mut out = String::new();
    let mut memo = Memo::new();
    for t in texts(a) {
        let ok = match t {
            None => false,
            Some(t) => {
                // (start, length) of the value in `data`, or None for NULL
                let mut fresh = false;
                let at = memo.get_or(t, |t| {
                    fresh = true;
                    out.clear();
                    let ok = f(t, &mut out);
                    let start = data.len();
                    if ok {
                        data.extend_from_slice(out.as_bytes());
                    }
                    ok.then_some((start, out.len()))
                });
                if let (Some((start, len)), false) = (at, fresh) {
                    // a repeat: copy the first result
                    data.extend_from_within(start..start + len);
                }
                at.is_some()
            }
        };
        offsets.push(data.len() as i32);
        valid.append(ok);
    }
    let nulls = Some(arrow::buffer::NullBuffer::new(valid.finish())).filter(|b| b.null_count() > 0);
    let offsets = arrow::buffer::OffsetBuffer::new(arrow::buffer::ScalarBuffer::from(offsets));
    // SAFETY: the offsets grow monotonically over `data`, which holds whole `&str`s
    Arc::new(unsafe { StringArray::new_unchecked(offsets, arrow::buffer::Buffer::from_vec(data), nulls) })
}

pub fn like(args: &[ColumnarValue], m: usize) -> Result<ArrayRef> {
    let Some((re, _)) = setup(args, 2)? else { return Ok(new_null_array(&arrow::datatypes::DataType::Boolean, m)) };
    let a = subject(args, m)?;
    let mut b = BooleanBuilder::with_capacity(a.len());
    memo_map(&a, |s| re.is_match(s), |v| b.append_option(v));
    Ok(Arc::new(b.finish()))
}

pub fn count(args: &[ColumnarValue], m: usize) -> Result<ArrayRef> {
    let Some((re, _)) = setup(args, 2)? else { return Ok(new_null_array(&arrow::datatypes::DataType::Int64, m)) };
    let a = subject(args, m)?;
    let n_matches = |s: &str| re.find_iter(s).count() as i64;
    let mut b = Int64Builder::with_capacity(a.len());
    memo_map(&a, n_matches, |v| b.append_option(v));
    Ok(Arc::new(b.finish()))
}

pub fn extract(args: &[ColumnarValue], m: usize) -> Result<ArrayRef> {
    let flags_at = 3;
    let Some((re, o, pat)) = setup_pattern(args, flags_at)? else { return Ok(new_null_array(&arrow::datatypes::DataType::Utf8, m)) };
    let group = match args.get(2) {
        Some(ColumnarValue::Scalar(s)) => s.as_i64().unwrap_or(0) as usize,
        _ => 0,
    };
    let a = subject(args, m)?;
    // capture slots reused across rows (no allocation per row)
    let mut caps = Captures::new(re.clone(), &pat, &o);
    Ok(map_texts(&a, |text, out| {
        let hit = if group == 0 {
            re.find(text).map(|x| x.as_str())
        } else {
            caps.find(text).and_then(|(_, locs)| locs.get(group)).map(|(x, y)| &text[x..y])
        };
        match hit {
            Some(h) => out.push_str(h),
            None if o.null_on_miss => return false,
            None => {}
        }
        true
    }))
}

pub fn replace(args: &[ColumnarValue], m: usize) -> Result<ArrayRef> {
    let Some((re, o, pat)) = setup_pattern(args, 3)? else { return Ok(new_null_array(&arrow::datatypes::DataType::Utf8, m)) };
    let Some(rep) = const_str(args.get(2))? else { return Ok(new_null_array(&arrow::datatypes::DataType::Utf8, m)) };
    let a = subject(args, m)?;
    if !o.global && !o.raw_repl {
        // the first match: its capture slots reused across rows, the
        // replacement written straight into the output
        let pieces = pieces(&rep, &o);
        let mut caps = Captures::new(re.clone(), &pat, &o);
        return Ok(map_texts(&a, |text, out| {
            let Some(((start, end), locs)) = caps.find(text) else {
                out.push_str(text);
                return true;
            };
            out.push_str(&text[..start]);
            for p in &pieces {
                match p {
                    Piece::Text(t) => out.push_str(t),
                    // the whole match, tail included
                    Piece::Group(0) => out.push_str(&text[start..end]),
                    Piece::Group(g) => {
                        if let Some((x, y)) = locs.get(*g) {
                            out.push_str(&text[x..y]);
                        }
                    }
                }
            }
            out.push_str(&text[end..]);
            true
        }));
    }
    let rep = replacement(&rep, &o);
    Ok(map_texts(&a, |text, out| {
        let r = if o.global { re.replace_all(text, rep.as_str()) } else { re.replace(text, rep.as_str()) };
        out.push_str(&r);
        true
    }))
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

#[cfg(test)]
mod tests {
    use super::*;

    /// The split capture search finds what the whole pattern finds.
    #[test]
    fn a_trailing_dot_star_split_matches_the_whole_pattern() {
        let texts = [
            "https://www.a.com/x/y",
            "http://b.org/",
            "no match",
            "https://c.net/line\nbreak",
            "https://d.io/p\n",
            "x\nhttps://e.com/q",
            "https://f.com/a\nhttps://g.com/b",
            "",
        ];
        let cases = [
            (r"^https?://(?:www\.)?([^/]+)/.*$", ""),
            (r"https?://([^/]+)/.*", ""),
            (r"://([^/]+)/.*$", ""),
            (r"([a-z]+)\.(com|org).*$", "i"),
            (r"(/[a-z]*).*$", "s"),
            (r".*$", ""),
            (r"(e).*", "s"),
        ];
        for (pat, flags) in cases {
            let o = Opts::parse(flags).unwrap();
            let full = regex_for(pat, &o).unwrap();
            assert!(tail_for(pat, &o, &full).is_some(), "{pat} splits");
            let mut caps = Captures::new(full.clone(), pat, &o);
            let mut locs = full.capture_locations();
            for t in texts {
                let want = full.captures_read(&mut locs, t).map(|m| {
                    let groups: Vec<_> = (0..locs.len()).map(|g| locs.get(g)).skip(1).collect();
                    ((m.start(), m.end()), groups)
                });
                let got = caps.find(t).map(|(span, l)| (span, (0..l.len()).map(|g| l.get(g)).skip(1).collect::<Vec<_>>()));
                assert_eq!(got, want, "{pat:?} on {t:?}");
            }
        }
        // a lazy or bounded tail is not split
        for pat in [r"a.*?$", r"a.{0,3}$", r"a.*b", r"(/.*)$"] {
            let o = Opts::parse("").unwrap();
            assert!(tail_for(pat, &o, &regex_for(pat, &o).unwrap()).is_none(), "{pat}");
        }
    }
}
