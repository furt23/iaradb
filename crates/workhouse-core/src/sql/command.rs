//! Statements that write: recognized here, around the query they hold
//! (which the SQL planner plans as usual).
//!
//! ```sql
//! COPY (select ...) TO 's3://bucket/out' (FORMAT parquet, PARTITION_BY (year, month), COMPRESSION zstd)
//! CREATE [OR REPLACE] TABLE [IF NOT EXISTS] sales_2024 [PARTITIONED BY (region)] AS select ...
//! INSERT INTO sales_2024 [(col, ...)] select ...
//! DROP TABLE [IF EXISTS] sales_2024
//! CREATE SCHEMA [IF NOT EXISTS] tpch
//! DROP SCHEMA [IF EXISTS] tpch [CASCADE | RESTRICT]
//! USE tpch
//! ```
//!
//! Table names may be qualified: `tpch.lineitem`, `"tpch"."lineitem"`.

use crate::error::{Result, WhError};

#[derive(Debug, Clone, PartialEq)]
pub enum CopyValue {
    Word(String),
    Text(String),
    Number(f64),
    List(Vec<String>),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Command {
    /// anything else: a query
    Query,
    Copy { query: String, path: String, options: Vec<(String, CopyValue)> },
    CreateTableAs { name: String, replace: bool, if_not_exists: bool, partition_by: Vec<String>, query: String },
    Insert { name: String, columns: Vec<String>, query: String },
    DropTable { name: String, if_exists: bool },
    CreateSchema { name: String, if_not_exists: bool },
    DropSchema { name: String, if_exists: bool, cascade: bool },
    Use { schema: String },
}

#[derive(Debug, Clone, PartialEq)]
enum Tok {
    Word(String),
    Quoted(String),
    Text(String),
    Number(f64),
    Open,
    Close,
    Comma,
    Other,
}

/// Tokens with their byte offsets (comments and spaces skipped).
fn tokenize(sql: &str) -> Result<Vec<(usize, Tok)>> {
    let b = sql.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        let start = i;
        if c.is_ascii_whitespace() {
            i += 1;
        } else if sql[i..].starts_with("--") {
            i = sql[i..].find('\n').map_or(b.len(), |n| i + n);
        } else if sql[i..].starts_with("/*") {
            i = sql[i + 2..].find("*/").map_or(b.len(), |n| i + n + 4);
        } else if c == b'\'' || c == b'"' {
            let mut text = String::new();
            i += 1;
            loop {
                let Some(&ch) = b.get(i) else { return Err(WhError::Sql("unterminated quote".into())) };
                if ch == c {
                    if b.get(i + 1) == Some(&c) {
                        text.push(c as char);
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                let len = sql[i..].chars().next().map_or(1, char::len_utf8);
                text.push_str(&sql[i..i + len]);
                i += len;
            }
            out.push((start, if c == b'\'' { Tok::Text(text) } else { Tok::Quoted(text) }));
        } else if c.is_ascii_alphabetic() || c == b'_' {
            while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'.') {
                i += 1;
            }
            out.push((start, Tok::Word(sql[start..i].to_string())));
        } else if c.is_ascii_digit() {
            while i < b.len() && (b[i].is_ascii_digit() || b[i] == b'.') {
                i += 1;
            }
            out.push((start, Tok::Number(sql[start..i].parse().unwrap_or(0.0))));
        } else {
            out.push((
                start,
                match c {
                    b'(' => Tok::Open,
                    b')' => Tok::Close,
                    b',' => Tok::Comma,
                    _ => Tok::Other,
                },
            ));
            i += sql[i..].chars().next().map_or(1, char::len_utf8);
        }
    }
    Ok(out)
}

struct Cursor<'a> {
    sql: &'a str,
    toks: Vec<(usize, Tok)>,
    at: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<&Tok> {
        self.toks.get(self.at).map(|(_, t)| t)
    }

    fn keyword(&mut self, word: &str) -> bool {
        if matches!(self.peek(), Some(Tok::Word(w)) if w.eq_ignore_ascii_case(word)) {
            self.at += 1;
            return true;
        }
        false
    }

    fn keywords(&mut self, words: &[&str]) -> bool {
        let save = self.at;
        if words.iter().all(|w| self.keyword(w)) {
            return true;
        }
        self.at = save;
        false
    }

    fn expect(&mut self, word: &str) -> Result<()> {
        if self.keyword(word) { Ok(()) } else { Err(self.error(&format!("expected {}", word.to_ascii_uppercase()))) }
    }

    fn error(&self, what: &str) -> WhError {
        let near = self.toks.get(self.at).map_or("the end".to_string(), |(o, _)| format!("'{}'", self.sql[*o..].chars().take(20).collect::<String>()));
        WhError::Sql(format!("{what} near {near}"))
    }

    /// A name: a word or a quoted identifier, or several joined by dots
    /// (`s.t`, `"s"."t"`, `s."t"`, `"s".t`), returned with the dots.
    fn name(&mut self) -> Result<String> {
        let mut out = String::new();
        loop {
            let (part, dot_follows) = match self.peek().cloned() {
                // the tokenizer keeps a dot that follows a word inside the word
                Some(Tok::Word(w)) => (w.clone(), w.ends_with('.')),
                Some(Tok::Quoted(q)) => (q, false),
                _ => return Err(self.error("expected a name")),
            };
            self.at += 1;
            out.push_str(&part);
            if !dot_follows && !self.dot() {
                return Ok(out);
            }
            if !dot_follows {
                out.push('.');
            }
        }
    }

    /// Skip a `.` that stands alone (after a quoted identifier).
    fn dot(&mut self) -> bool {
        match self.toks.get(self.at) {
            Some((o, Tok::Other)) if self.sql[*o..].starts_with('.') => {
                self.at += 1;
                true
            }
            _ => false,
        }
    }

    fn text(&mut self) -> Result<String> {
        match self.peek().cloned() {
            Some(Tok::Text(t)) => {
                self.at += 1;
                Ok(t)
            }
            _ => Err(self.error("expected a quoted path")),
        }
    }

    /// `(a, b, c)`
    fn name_list(&mut self) -> Result<Vec<String>> {
        if self.peek() != Some(&Tok::Open) {
            return Err(self.error("expected a parenthesized list"));
        }
        self.at += 1;
        let mut names = vec![self.name()?];
        while self.peek() == Some(&Tok::Comma) {
            self.at += 1;
            names.push(self.name()?);
        }
        if self.peek() != Some(&Tok::Close) {
            return Err(self.error("expected ')'"));
        }
        self.at += 1;
        Ok(names)
    }

    /// The text from the current token on.
    fn rest(&self) -> Result<String> {
        let (o, _) = self.toks.get(self.at).ok_or_else(|| self.error("expected a query"))?;
        Ok(self.sql[*o..].trim().trim_end_matches(';').trim().to_string())
    }

    /// A parenthesized query; leaves the cursor after its `)`.
    fn parenthesized(&mut self) -> Result<String> {
        let (open, _) = self.toks[self.at];
        let mut depth = 0;
        for k in self.at..self.toks.len() {
            match self.toks[k].1 {
                Tok::Open => depth += 1,
                Tok::Close => {
                    depth -= 1;
                    if depth == 0 {
                        let close = self.toks[k].0;
                        self.at = k + 1;
                        return Ok(self.sql[open + 1..close].trim().to_string());
                    }
                }
                _ => {}
            }
        }
        Err(self.error("unbalanced parentheses"))
    }

    fn done(&self) -> Result<()> {
        match self.peek() {
            None => Ok(()),
            Some(Tok::Other) if self.toks.len() == self.at + 1 && self.sql[self.toks[self.at].0..].trim() == ";" => Ok(()),
            Some(_) => Err(self.error("unexpected text")),
        }
    }
}

fn copy_options(c: &mut Cursor<'_>) -> Result<Vec<(String, CopyValue)>> {
    c.keyword("with");
    let mut out = vec![];
    if c.peek() != Some(&Tok::Open) {
        return Ok(out);
    }
    c.at += 1;
    loop {
        if c.peek() == Some(&Tok::Close) {
            c.at += 1;
            break;
        }
        let key = c.name()?.to_ascii_lowercase();
        // `PARTITION BY (...)` reads like `PARTITION_BY (...)`
        let key = if key == "partition" && c.keyword("by") { "partition_by".to_string() } else { key };
        let value = match c.peek().cloned() {
            Some(Tok::Open) => CopyValue::List(c.name_list()?),
            Some(Tok::Text(t)) => {
                c.at += 1;
                CopyValue::Text(t)
            }
            Some(Tok::Number(n)) => {
                c.at += 1;
                CopyValue::Number(n)
            }
            Some(Tok::Word(w)) => {
                c.at += 1;
                CopyValue::Word(w)
            }
            // a bare flag: `HEADER`
            _ => CopyValue::Word("true".into()),
        };
        out.push((key, value));
        match c.peek() {
            Some(Tok::Comma) => c.at += 1,
            Some(Tok::Close) => {}
            _ => return Err(c.error("expected ',' or ')' in the options")),
        }
    }
    Ok(out)
}

/// What a SQL text does: a write (with its parts) or a query.
pub fn parse_command(sql: &str) -> Result<Command> {
    let toks = tokenize(sql)?;
    let mut c = Cursor { sql, toks, at: 0 };
    if c.keyword("copy") {
        if c.peek() != Some(&Tok::Open) {
            return Err(c.error("COPY needs a query in parentheses: COPY (select ...) TO 'path'"));
        }
        let query = c.parenthesized()?;
        c.expect("to")?;
        let path = c.text()?;
        let options = copy_options(&mut c)?;
        c.done()?;
        return Ok(Command::Copy { query, path, options });
    }
    if c.keyword("create") {
        if c.keyword("schema") {
            let if_not_exists = c.keywords(&["if", "not", "exists"]);
            let name = c.name()?;
            c.done()?;
            return Ok(Command::CreateSchema { name, if_not_exists });
        }
        let replace = c.keywords(&["or", "replace"]);
        c.expect("table")?;
        let if_not_exists = c.keywords(&["if", "not", "exists"]);
        let name = c.name()?;
        let partition_by = if c.keywords(&["partitioned", "by"]) || c.keywords(&["partition", "by"]) { c.name_list()? } else { vec![] };
        c.expect("as")?;
        let query = if c.peek() == Some(&Tok::Open) && c.toks.last().map(|t| &t.1) == Some(&Tok::Close) { c.parenthesized()? } else { c.rest()? };
        return Ok(Command::CreateTableAs { name, replace, if_not_exists, partition_by, query });
    }
    if c.keyword("insert") {
        c.expect("into")?;
        let name = c.name()?;
        // a column list, not a parenthesized query
        let columns = match (c.peek(), c.toks.get(c.at + 1).map(|t| &t.1)) {
            (Some(Tok::Open), Some(Tok::Word(w))) if !["select", "with", "values", "from"].contains(&w.to_ascii_lowercase().as_str()) => c.name_list()?,
            _ => vec![],
        };
        return Ok(Command::Insert { name, columns, query: c.rest()? });
    }
    if c.keyword("drop") {
        if c.keyword("schema") {
            let if_exists = c.keywords(&["if", "exists"]);
            let name = c.name()?;
            let cascade = c.keyword("cascade");
            if !cascade {
                c.keyword("restrict");
            }
            c.done()?;
            return Ok(Command::DropSchema { name, if_exists, cascade });
        }
        c.expect("table")?;
        let if_exists = c.keywords(&["if", "exists"]);
        let name = c.name()?;
        c.done()?;
        return Ok(Command::DropTable { name, if_exists });
    }
    if c.keyword("use") {
        let schema = c.name()?;
        c.done()?;
        return Ok(Command::Use { schema });
    }
    Ok(Command::Query)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_with_options() {
        let c = parse_command("-- export\nCOPY (select a, (b) from t where s = 'x)') TO 's3://b/out' (FORMAT parquet, PARTITION_BY (year, month), COMPRESSION 'snappy', ROW_GROUP_SIZE 1000);").unwrap();
        assert_eq!(
            c,
            Command::Copy {
                query: "select a, (b) from t where s = 'x)'".into(),
                path: "s3://b/out".into(),
                options: vec![
                    ("format".into(), CopyValue::Word("parquet".into())),
                    ("partition_by".into(), CopyValue::List(vec!["year".into(), "month".into()])),
                    ("compression".into(), CopyValue::Text("snappy".into())),
                    ("row_group_size".into(), CopyValue::Number(1000.0)),
                ],
            }
        );
        let flags = parse_command("copy (select 1) to 'x.csv' with (format csv, header, partition by (a))").unwrap();
        let Command::Copy { options, .. } = flags else { panic!() };
        assert_eq!(options[1], ("header".into(), CopyValue::Word("true".into())));
        assert_eq!(options[2], ("partition_by".into(), CopyValue::List(vec!["a".into()])));
    }

    #[test]
    fn create_insert_and_drop() {
        assert_eq!(
            parse_command("create or replace table if not exists \"Sales 2024\" partitioned by (region) as select * from s").unwrap(),
            Command::CreateTableAs {
                name: "Sales 2024".into(),
                replace: true,
                if_not_exists: true,
                partition_by: vec!["region".into()],
                query: "select * from s".into(),
            }
        );
        assert_eq!(
            parse_command("CREATE TABLE t AS (select 1 as x)").unwrap(),
            Command::CreateTableAs { name: "t".into(), replace: false, if_not_exists: false, partition_by: vec![], query: "select 1 as x".into() }
        );
        assert_eq!(
            parse_command("insert into t (a, b) select 1, 2").unwrap(),
            Command::Insert { name: "t".into(), columns: vec!["a".into(), "b".into()], query: "select 1, 2".into() }
        );
        assert_eq!(
            parse_command("insert into t (select 1)").unwrap(),
            Command::Insert { name: "t".into(), columns: vec![], query: "(select 1)".into() }
        );
        assert_eq!(parse_command("drop table if exists t;").unwrap(), Command::DropTable { name: "t".into(), if_exists: true });
    }

    #[test]
    fn queries_pass_through_and_mistakes_are_explained() {
        assert_eq!(parse_command("with x as (select 1) select * from x").unwrap(), Command::Query);
        assert_eq!(parse_command("select 'copy'").unwrap(), Command::Query);
        assert!(parse_command("copy t to 'x'").unwrap_err().to_string().contains("COPY needs a query"));
        assert!(parse_command("create table t select 1").unwrap_err().to_string().contains("expected AS"));
    }

    #[test]
    fn names_may_be_qualified() {
        let name = |sql: &str| match parse_command(sql).unwrap() {
            Command::DropTable { name, .. } => name,
            other => panic!("{other:?}"),
        };
        assert_eq!(name("drop table tpch.lineitem"), "tpch.lineitem");
        assert_eq!(name("drop table \"tpch\".\"lineitem\""), "tpch.lineitem");
        assert_eq!(name("drop table tpch.\"lineitem\";"), "tpch.lineitem");
        assert_eq!(name("drop table \"tpch\".lineitem"), "tpch.lineitem");
        assert_eq!(name("drop table \"tpch.lineitem\""), "tpch.lineitem");
        assert_eq!(name("drop table \"Sales 2024\""), "Sales 2024");
        assert!(parse_command("drop table tpch.").unwrap_err().to_string().contains("expected a name"));
        assert!(parse_command("drop table \"a\" \"b\"").unwrap_err().to_string().contains("unexpected text"));
        assert_eq!(
            parse_command("create table s.t as select 1").unwrap(),
            Command::CreateTableAs { name: "s.t".into(), replace: false, if_not_exists: false, partition_by: vec![], query: "select 1".into() }
        );
        assert_eq!(
            parse_command("insert into \"s\".\"t\" (a) select 1").unwrap(),
            Command::Insert { name: "s.t".into(), columns: vec!["a".into()], query: "select 1".into() }
        );
    }

    #[test]
    fn schema_statements() {
        assert_eq!(parse_command("create schema tpch").unwrap(), Command::CreateSchema { name: "tpch".into(), if_not_exists: false });
        assert_eq!(
            parse_command("CREATE SCHEMA IF NOT EXISTS \"Tpch\";").unwrap(),
            Command::CreateSchema { name: "Tpch".into(), if_not_exists: true }
        );
        assert_eq!(
            parse_command("drop schema tpch").unwrap(),
            Command::DropSchema { name: "tpch".into(), if_exists: false, cascade: false }
        );
        assert_eq!(
            parse_command("drop schema if exists tpch cascade;").unwrap(),
            Command::DropSchema { name: "tpch".into(), if_exists: true, cascade: true }
        );
        assert_eq!(
            parse_command("drop schema tpch restrict").unwrap(),
            Command::DropSchema { name: "tpch".into(), if_exists: false, cascade: false }
        );
        assert_eq!(parse_command("use tpch").unwrap(), Command::Use { schema: "tpch".into() });
        assert_eq!(parse_command("USE \"main\";").unwrap(), Command::Use { schema: "main".into() });
        assert!(parse_command("create schema").unwrap_err().to_string().contains("expected a name"));
        assert!(parse_command("create schema a b").unwrap_err().to_string().contains("unexpected text"));
        assert!(parse_command("drop schema a cascade restrict").unwrap_err().to_string().contains("unexpected text"));
        assert!(parse_command("use").unwrap_err().to_string().contains("expected a name"));
        // still a query
        assert_eq!(parse_command("select 1 as use").unwrap(), Command::Query);
    }
}
