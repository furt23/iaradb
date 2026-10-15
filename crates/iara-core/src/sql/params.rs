//! Bound parameters of a SQL statement: `$1`, `$2`, `?` (positional) or
//! `:name`, `$name` (named).
//!
//! [`Params::bind`] runs before parsing. It finds the placeholders with the
//! SQL tokenizer (so a string literal, a comment or a `::` cast never holds
//! one), checks that every one has a value, and rewrites the text so the
//! parser sees only `$N` and `$name`: `?` becomes `$1`, `$2`, .. in order of
//! appearance, `:name` becomes `$name`. The planner then replaces each
//! placeholder by its value as a typed literal.
//!
//! One statement uses one kind: positional (`?` or `$N`, not both) or named.
//! Values the statement does not use are ignored.

use std::borrow::Cow;
use std::collections::{BTreeSet, HashMap};

use sqlparser::keywords::Keyword;
use sqlparser::tokenizer::{Location, Token, TokenWithSpan, Tokenizer};

use super::dialect::IaraDialect;
use crate::error::{Result, WhError};
use crate::scalar::Scalar;

#[derive(Clone, Debug, Default)]
pub enum Params {
    #[default]
    None,
    /// `$1` is the first value; `?` takes them in order of appearance
    Positional(Vec<Scalar>),
    /// `:name` and `$name`; keys may be given with or without the prefix
    Named(HashMap<String, Scalar>),
}

impl Params {
    pub fn is_none(&self) -> bool {
        matches!(self, Params::None)
    }

    /// The value a placeholder (`$1`, `$name`) stands for.
    pub(super) fn lookup(&self, placeholder: &str) -> Result<Scalar> {
        let body = placeholder.trim_start_matches(['$', ':', '?']);
        let found = match self {
            Params::Positional(values) => body.parse::<usize>().ok().and_then(|n| n.checked_sub(1)).and_then(|i| values.get(i)),
            Params::Named(map) => named(map, body),
            Params::None => None,
        };
        found.cloned().ok_or_else(|| WhError::Sql(format!("unbound parameter {placeholder}")))
    }

    /// Check that the statement's placeholders all have values and rewrite
    /// them to `$N` / `$name`. A statement without placeholders is returned as is.
    pub(super) fn bind<'q>(&self, query: &'q str) -> Result<Cow<'q, str>> {
        let found = scan(query);
        if found.is_empty() {
            return Ok(query.into());
        }
        let (named_found, positional): (Vec<&Found>, Vec<&Found>) = found.iter().partition(|f| matches!(f.kind, Kind::Named(_)));
        if !positional.is_empty() && !named_found.is_empty() {
            return Err(WhError::Sql("a statement cannot mix positional (? or $1) and named (:name or $name) parameters".into()));
        }
        let anonymous = positional.iter().any(|f| matches!(f.kind, Kind::Anonymous));
        let numbered = positional.iter().any(|f| matches!(f.kind, Kind::Numbered(_)));
        if anonymous && numbered {
            return Err(WhError::Sql("a statement cannot mix ? and $1 parameters".into()));
        }
        let mut missing: Vec<String> = vec![];
        let mut edits: Vec<(usize, usize, String)> = vec![];
        if !positional.is_empty() {
            let given = match self {
                Params::Positional(v) => v.len(),
                Params::Named(_) => {
                    return Err(WhError::Sql("the statement has positional parameters but named parameters were given".into()));
                }
                Params::None => 0,
            };
            let mut next = 0;
            let mut seen = BTreeSet::new();
            for f in &positional {
                let n = match f.kind {
                    Kind::Anonymous => {
                        next += 1;
                        edits.push((f.start, f.end, format!("${next}")));
                        next
                    }
                    Kind::Numbered(0) => return Err(WhError::Sql("parameters are numbered from $1".into())),
                    Kind::Numbered(n) => {
                        if f.text.starts_with('?') {
                            edits.push((f.start, f.end, format!("${n}")));
                        }
                        n
                    }
                    Kind::Named(_) => continue,
                };
                if n > given {
                    seen.insert(n);
                }
            }
            missing.extend(seen.into_iter().map(|n| format!("${n}")));
        } else {
            let map = match self {
                Params::Named(m) => Some(m),
                Params::Positional(_) => {
                    return Err(WhError::Sql("the statement has named parameters but positional parameters were given".into()));
                }
                Params::None => None,
            };
            for f in &named_found {
                let Kind::Named(name) = &f.kind else { continue };
                if f.text.starts_with(':') {
                    edits.push((f.start, f.start + 1, "$".into()));
                }
                let bound = map.is_some_and(|m| named(m, name).is_some());
                if !bound && !missing.contains(&f.text) {
                    missing.push(f.text.clone());
                }
            }
        }
        if !missing.is_empty() {
            return Err(WhError::Sql(format!("unbound parameters: {}", missing.join(", "))));
        }
        let mut out = query.to_string();
        edits.sort_by_key(|e| std::cmp::Reverse(e.0));
        for (start, end, text) in edits {
            out.replace_range(start..end, &text);
        }
        Ok(out.into())
    }
}

fn named<'m>(map: &'m HashMap<String, Scalar>, name: &str) -> Option<&'m Scalar> {
    map.get(name).or_else(|| map.get(&format!(":{name}"))).or_else(|| map.get(&format!("${name}")))
}

enum Kind {
    /// `?`
    Anonymous,
    /// `$3`, `?3`
    Numbered(usize),
    /// `:name`, `$name`
    Named(String),
}

struct Found {
    kind: Kind,
    /// the placeholder as written
    text: String,
    /// byte range in the query
    start: usize,
    end: usize,
}

/// The placeholders of a statement, in order of appearance.
fn scan(query: &str) -> Vec<Found> {
    if !query.contains(['?', '$', ':']) {
        return vec![];
    }
    let Ok(tokens) = Tokenizer::new(&IaraDialect, query).tokenize_with_location() else {
        return vec![];
    };
    let line_starts: Vec<usize> = std::iter::once(0).chain(query.match_indices('\n').map(|(i, _)| i + 1)).collect();
    let offset = |loc: &Location| -> Option<usize> {
        let start = *line_starts.get((loc.line as usize).checked_sub(1)?)?;
        let col = (loc.column as usize).checked_sub(1)?;
        Some(query[start..].char_indices().nth(col).map(|(i, _)| start + i).unwrap_or(query.len()))
    };
    let significant: Vec<&TokenWithSpan> = tokens.iter().filter(|t| !matches!(t.token, Token::Whitespace(_))).collect();
    let mut out = vec![];
    for (i, t) in significant.iter().enumerate() {
        let (Some(start), Some(end)) = (offset(&t.span.start), offset(&t.span.end)) else { continue };
        match &t.token {
            Token::Placeholder(p) if p.len() > 1 || p == "?" => {
                let body = &p[1..];
                let kind = if p == "?" {
                    Kind::Anonymous
                } else if body.bytes().all(|b| b.is_ascii_digit()) {
                    match body.parse() {
                        Ok(n) => Kind::Numbered(n),
                        Err(_) => continue,
                    }
                } else if p.starts_with('$') && body.chars().next().is_some_and(|c| c.is_alphabetic() || c == '_') {
                    Kind::Named(body.to_string())
                } else {
                    continue;
                };
                out.push(Found { kind, text: p.clone(), start, end });
            }
            // `:name`, unless it is the colon of a slice (`x[a:b]`) or of a struct key (`{'k':v}`)
            Token::Colon => {
                let Some(next) = significant.get(i + 1) else { continue };
                let Token::Word(w) = &next.token else { continue };
                if next.span.start != t.span.end || w.quote_style.is_some() {
                    continue;
                }
                let operand_before = match i.checked_sub(1).map(|j| &significant[j].token) {
                    None => false,
                    Some(Token::Word(p)) => p.quote_style.is_some() || p.keyword == Keyword::NoKeyword,
                    Some(Token::RParen | Token::RBracket | Token::RBrace | Token::Number(..)) => true,
                    Some(prev) => is_literal(prev),
                };
                if operand_before {
                    continue;
                }
                let end = offset(&next.span.end).unwrap_or(end);
                out.push(Found { kind: Kind::Named(w.value.clone()), text: format!(":{}", w.value), start, end });
            }
            _ => {}
        }
    }
    out
}

fn is_literal(t: &Token) -> bool {
    matches!(
        t,
        Token::SingleQuotedString(_)
            | Token::DoubleQuotedString(_)
            | Token::DollarQuotedString(_)
            | Token::NationalStringLiteral(_)
            | Token::EscapedStringLiteral(_)
            | Token::HexStringLiteral(_)
    )
}
