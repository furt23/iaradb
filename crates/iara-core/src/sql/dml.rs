//! `DELETE`, `UPDATE` and `MERGE` on Delta tables.
//!
//! ```sql
//! DELETE FROM t [AS a] [WHERE pred]
//! UPDATE t [AS a] SET c = expr, ... [WHERE pred]
//! MERGE INTO t [AS a] USING (query) | table [AS s] ON cond
//!   WHEN MATCHED [AND c] THEN UPDATE SET c = expr, ... | UPDATE SET * | DELETE
//!   WHEN NOT MATCHED [BY TARGET] [AND c] THEN INSERT [(cols)] VALUES (...) | INSERT *
//!   WHEN NOT MATCHED BY SOURCE [AND c] THEN DELETE | UPDATE SET c = expr, ...
//! ```
//!
//! The statement is cut into its parts here (clause keywords, parentheses and `CASE .. END` are
//! respected); each expression is parsed by sqlparser and planned like any query expression, with
//! the target's columns (qualified by its alias) and the source's (by its alias) in scope.
//! Placeholders are bound over the whole text first. The result is one row: `rows` /
//! `num_affected_rows`, `version`, `files_removed`, `files_added`.

use std::collections::HashMap;
use sqlparser::parser::Parser;
use sqlparser::tokenizer::Token;

use super::command::{Cursor, Tok, tokenize};
use super::dialect::IaraDialect;
use super::maintenance::{delta_table, refresh, report};
use super::{Params, Scope, SqlPlanner};
use crate::delta::ops::delete::delete;
use crate::delta::ops::merge::{MergeClause, merge};
use crate::delta::ops::rewrite::DmlSummary;
use crate::delta::ops::update::update;
use crate::error::{Result, WhError};
use crate::expr::Expr;
use crate::schema::PlanSchema;
use crate::session::{LazyFrame, SessionContext};

const WHAT: &str = "UPDATE/DELETE/MERGE need a Delta table";

#[derive(Debug)]
enum Action {
    Delete,
    UpdateAll,
    Update(Vec<(String, String)>),
    InsertAll,
    Insert { columns: Vec<String>, values: Vec<String> },
}

#[derive(Debug, PartialEq, Clone, Copy)]
enum Kind {
    Matched,
    NotMatched,
    BySource,
}

#[derive(Debug)]
struct ClauseText {
    kind: Kind,
    cond: Option<String>,
    action: Action,
}

#[derive(Debug)]
enum SourceText {
    Query(String),
    Table(String),
}

#[derive(Debug)]
enum Stmt {
    Delete { name: String, alias: Option<String>, predicate: Option<String> },
    Update { name: String, alias: Option<String>, set: Vec<(String, String)>, predicate: Option<String> },
    Merge { name: String, alias: Option<String>, source: SourceText, source_alias: Option<String>, on: String, clauses: Vec<ClauseText> },
}

fn cursor(text: &str) -> Result<Cursor<'_>> {
    Ok(Cursor { sql: text, toks: tokenize(text)?, at: 0 })
}

/// The text from the cursor to the first top-level word of `stops` (or comma, if `comma`), or the end.
fn until(c: &mut Cursor<'_>, stops: &[&str], comma: bool) -> Result<String> {
    let Some(&(start, _)) = c.toks.get(c.at) else { return Err(c.error("expected an expression")) };
    let mut depth = 0i32;
    let mut end = c.sql.len();
    while let Some((o, t)) = c.toks.get(c.at) {
        match t {
            Tok::Open => depth += 1,
            Tok::Close => depth -= 1,
            Tok::Comma if depth == 0 && comma => {
                end = *o;
                break;
            }
            Tok::Word(w) => {
                let w = w.to_ascii_lowercase();
                if depth == 0 && stops.contains(&w.as_str()) {
                    end = *o;
                    break;
                }
                if w == "case" {
                    depth += 1;
                } else if w == "end" {
                    depth -= 1;
                }
            }
            _ => {}
        }
        c.at += 1;
    }
    let text = c.sql[start..end].trim();
    if text.is_empty() {
        return Err(c.error("expected an expression"));
    }
    Ok(text.to_string())
}

fn split_commas(text: &str) -> Result<Vec<String>> {
    let mut c = cursor(text)?;
    let mut out = vec![];
    while c.peek().is_some() {
        out.push(until(&mut c, &[], true)?);
        if c.peek() == Some(&Tok::Comma) {
            c.at += 1;
            if c.peek().is_none() {
                return Err(WhError::Sql(format!("trailing comma in '{text}'")));
            }
        }
    }
    Ok(out)
}

/// `col = expr` as (column, text of expr); a qualifier on the column is dropped.
fn assignment(text: &str) -> Result<(String, String)> {
    let mut c = cursor(text)?;
    let name = c.name()?;
    match c.toks.get(c.at) {
        Some((o, Tok::Other)) if text[*o..].starts_with('=') => {
            let value = text[*o + 1..].trim();
            if value.is_empty() {
                return Err(WhError::Sql(format!("SET {name} = : the value is missing")));
            }
            Ok((name.rsplit('.').next().unwrap_or(&name).to_string(), value.to_string()))
        }
        _ => Err(WhError::Sql(format!("expected 'column = value' in SET, got '{text}'"))),
    }
}

fn assignments(text: &str) -> Result<Vec<(String, String)>> {
    split_commas(text)?.iter().map(|a| assignment(a)).collect()
}

/// `[AS] alias` unless the next word is one of `stops`.
fn alias(c: &mut Cursor<'_>, stops: &[&str]) -> Result<Option<String>> {
    if c.keyword("as") {
        return Ok(Some(c.name()?));
    }
    Ok(match c.peek().cloned() {
        Some(Tok::Word(w)) if !stops.contains(&w.to_ascii_lowercase().as_str()) => {
            c.at += 1;
            Some(w)
        }
        Some(Tok::Quoted(q)) => {
            c.at += 1;
            Some(q)
        }
        _ => None,
    })
}

fn parse(sql: &str) -> Result<Stmt> {
    let mut c = cursor(sql)?;
    if c.keyword("delete") {
        c.expect("from")?;
        let name = c.name()?;
        let alias = alias(&mut c, &["where"])?;
        let predicate = if c.keyword("where") { Some(until(&mut c, &[], false)?) } else { None };
        c.done()?;
        return Ok(Stmt::Delete { name, alias, predicate });
    }
    if c.keyword("update") {
        let name = c.name()?;
        let alias = alias(&mut c, &["set"])?;
        c.expect("set")?;
        let set = assignments(&until(&mut c, &["where"], false)?)?;
        let predicate = if c.keyword("where") { Some(until(&mut c, &[], false)?) } else { None };
        c.done()?;
        return Ok(Stmt::Update { name, alias, set, predicate });
    }
    c.expect("merge")?;
    c.keyword("into");
    let name = c.name()?;
    let alias = alias(&mut c, &["using"])?;
    c.expect("using")?;
    let source = if c.peek() == Some(&Tok::Open) { SourceText::Query(c.parenthesized()?) } else { SourceText::Table(c.name()?) };
    let source_alias = self::alias(&mut c, &["on"])?;
    c.expect("on")?;
    let on = until(&mut c, &["when"], false)?;
    let mut clauses = vec![];
    while c.keyword("when") {
        let kind = if c.keywords(&["not", "matched"]) {
            if c.keywords(&["by", "source"]) {
                Kind::BySource
            } else {
                c.keywords(&["by", "target"]);
                Kind::NotMatched
            }
        } else {
            c.expect("matched")?;
            Kind::Matched
        };
        let cond = if c.keyword("and") { Some(until(&mut c, &["then"], false)?) } else { None };
        c.expect("then")?;
        let action = if c.keyword("delete") {
            Action::Delete
        } else if c.keyword("update") {
            c.expect("set")?;
            if matches!(c.toks.get(c.at), Some((o, Tok::Other)) if sql[*o..].starts_with('*')) {
                c.at += 1;
                Action::UpdateAll
            } else {
                Action::Update(assignments(&until(&mut c, &["when"], false)?)?)
            }
        } else if c.keyword("insert") {
            if matches!(c.toks.get(c.at), Some((o, Tok::Other)) if sql[*o..].starts_with('*')) {
                c.at += 1;
                Action::InsertAll
            } else {
                let columns = if c.peek() == Some(&Tok::Open) { split_commas(&c.parenthesized()?)? } else { vec![] };
                c.expect("values")?;
                if c.peek() != Some(&Tok::Open) {
                    return Err(c.error("expected VALUES (...)"));
                }
                let values = split_commas(&c.parenthesized()?)?;
                Action::Insert { columns, values }
            }
        } else {
            return Err(c.error("expected UPDATE, DELETE or INSERT after THEN"));
        };
        clauses.push(ClauseText { kind, cond, action });
    }
    c.done()?;
    if clauses.is_empty() {
        return Err(WhError::Sql("MERGE needs at least one WHEN clause".into()));
    }
    Ok(Stmt::Merge { name, alias, source, source_alias, on, clauses })
}

fn planner<'a>(ctx: &'a SessionContext, params: &'a Params) -> SqlPlanner<'a> {
    SqlPlanner { ctx, params, ctes: vec![], windows: vec![], next_id: 0, word_counts: HashMap::new() }
}

/// An expression of the statement's text, planned over `schema`.
fn plan_expr(p: &mut SqlPlanner<'_>, text: &str, schema: &PlanSchema) -> Result<Expr> {
    let bad = |e: sqlparser::parser::ParserError| WhError::Sql(format!("{e} in '{text}'"));
    let mut parser = Parser::new(&IaraDialect).try_with_sql(text).map_err(bad)?;
    let e = parser.parse_expr().map_err(bad)?;
    if parser.peek_token().token != Token::EOF {
        return Err(WhError::Sql(format!("unexpected text after the expression in '{text}'")));
    }
    p.sql_expr(&e, Scope::new(schema, None))
}

/// An expression over unqualified columns (`OPTIMIZE ... WHERE`).
pub(super) fn plan_plain_expr(ctx: &SessionContext, params: &Params, text: &str, schema: &arrow::datatypes::Schema) -> Result<Expr> {
    let bound = params.bind(text)?;
    plan_expr(&mut planner(ctx, params), &bound, &PlanSchema::from_arrow(None, schema))
}

fn summary(ctx: &SessionContext, op: &str, shown: &str, root: &str, s: &DmlSummary) -> Result<LazyFrame> {
    let n = s.rows_affected as i64;
    report(
        ctx,
        op,
        shown,
        root,
        n,
        Some(s.version),
        &[("num_affected_rows", n), ("files_removed", s.files_removed as i64), ("files_added", s.files_added as i64)],
        None,
    )
}

pub(super) fn run(ctx: &SessionContext, sql: &str, params: &Params) -> Result<LazyFrame> {
    let bound = params.bind(sql)?;
    match parse(&bound)? {
        Stmt::Delete { name, alias, predicate } => {
            let t = delta_table(ctx, &name, WHAT)?;
            let d = t.delta();
            let alias = alias.unwrap_or_else(|| t.name.table.clone());
            let schema = t.scope(&alias)?;
            let mut p = planner(ctx, params);
            let predicate = predicate.map(|x| plan_expr(&mut p, &x, &schema)).transpose()?;
            let done = delete(ctx, d, Some(&alias), predicate)?;
            refresh(ctx, &t)?;
            summary(ctx, "delete", &t.shown, d.root(), &done)
        }
        Stmt::Update { name, alias, set, predicate } => {
            let t = delta_table(ctx, &name, WHAT)?;
            let d = t.delta();
            let alias = alias.unwrap_or_else(|| t.name.table.clone());
            let schema = t.scope(&alias)?;
            let mut p = planner(ctx, params);
            let set = set.into_iter().map(|(c, x)| Ok((c, plan_expr(&mut p, &x, &schema)?))).collect::<Result<Vec<_>>>()?;
            let predicate = predicate.map(|x| plan_expr(&mut p, &x, &schema)).transpose()?;
            let done = update(ctx, d, Some(&alias), set, predicate)?;
            refresh(ctx, &t)?;
            summary(ctx, "update", &t.shown, d.root(), &done)
        }
        Stmt::Merge { name, alias, source, source_alias, on, clauses } => {
            let t = delta_table(ctx, &name, WHAT)?;
            let d = t.delta();
            let alias = alias.unwrap_or_else(|| t.name.table.clone());
            let (lf, default_alias) = match &source {
                SourceText::Query(q) => (ctx.sql_with(q, params)?, "source".to_string()),
                SourceText::Table(n) => (ctx.query_table(n)?, n.rsplit('.').next().unwrap_or(n).to_string()),
            };
            let source_alias = source_alias.unwrap_or(default_alias);
            if source_alias.eq_ignore_ascii_case(&alias) {
                return Err(WhError::Plan(format!("MERGE: the target and the source are both called '{alias}': give one an alias")));
            }
            let schema = PlanSchema::join(&*t.scope(&alias)?, &lf.schema().with_qualifier(&source_alias));
            let mut p = planner(ctx, params);
            let mut expr = |x: &str| plan_expr(&mut p, x, &schema);
            let on = expr(&on)?;
            let table_columns: Vec<String> = t.provider.schema().fields().iter().map(|f| f.name().clone()).collect();
            let mut out = vec![];
            for cl in clauses {
                let cond = cl.cond.as_deref().map(&mut expr).transpose()?;
                let mut set = |list: Vec<(String, String)>| list.into_iter().map(|(c, x)| Ok((c, expr(&x)?))).collect::<Result<Vec<_>>>();
                out.push(match (cl.kind, cl.action) {
                    (Kind::Matched, Action::Delete) => MergeClause::MatchedDelete { cond },
                    (Kind::Matched, Action::UpdateAll) => MergeClause::MatchedUpdateAll { cond },
                    (Kind::Matched, Action::Update(list)) => MergeClause::MatchedUpdate { cond, set: set(list)? },
                    (Kind::BySource, Action::Delete) => MergeClause::NotMatchedBySourceDelete { cond },
                    (Kind::BySource, Action::Update(list)) => MergeClause::NotMatchedBySourceUpdate { cond, set: set(list)? },
                    (Kind::BySource, Action::UpdateAll) => {
                        return Err(WhError::Plan("WHEN NOT MATCHED BY SOURCE cannot UPDATE SET *: there is no source row".into()));
                    }
                    (Kind::NotMatched, Action::InsertAll) => MergeClause::NotMatchedInsertAll { cond },
                    (Kind::NotMatched, Action::Insert { columns, values }) => {
                        let columns = if columns.is_empty() { table_columns.clone() } else { columns };
                        if columns.len() != values.len() {
                            return Err(WhError::Plan(format!("MERGE INSERT: {} columns but {} values", columns.len(), values.len())));
                        }
                        let values = columns.into_iter().zip(values).collect();
                        MergeClause::NotMatchedInsert { cond, values: set(values)? }
                    }
                    (Kind::NotMatched, _) => return Err(WhError::Plan("WHEN NOT MATCHED can only INSERT".into())),
                    (_, Action::InsertAll | Action::Insert { .. }) => return Err(WhError::Plan("INSERT belongs to WHEN NOT MATCHED".into())),
                });
            }
            let done = merge(ctx, d, &lf, &source_alias, &alias, on, out)?;
            refresh(ctx, &t)?;
            summary(ctx, "merge", &t.shown, d.root(), &done)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn statements_are_cut_into_parts() {
        let Stmt::Update { name, alias, set, predicate } =
            parse("update s.t as x set a = case when b > 1 then 2 else 3 end, c = f(1, 2) where x.id in (1, 2)").unwrap()
        else {
            panic!()
        };
        assert_eq!((name.as_str(), alias.as_deref()), ("s.t", Some("x")));
        assert_eq!(set, vec![("a".to_string(), "case when b > 1 then 2 else 3 end".to_string()), ("c".to_string(), "f(1, 2)".to_string())]);
        assert_eq!(predicate.as_deref(), Some("x.id in (1, 2)"));
        let Stmt::Merge { clauses, on, source, .. } = parse(
            "merge into t using (select 1 as id) s on t.id = s.id \
             when matched and s.v > 0 then update set * \
             when not matched then insert (id, v) values (s.id, case when s.v then 1 end) \
             when not matched by source then delete",
        )
        .unwrap() else {
            panic!()
        };
        assert_eq!(on, "t.id = s.id");
        assert!(matches!(source, SourceText::Query(q) if q == "select 1 as id"));
        assert_eq!(clauses.len(), 3);
        assert_eq!(clauses[0].cond.as_deref(), Some("s.v > 0"));
        assert!(matches!(&clauses[1].action, Action::Insert { values, .. } if values.len() == 2));
        assert_eq!(clauses[2].kind, Kind::BySource);
    }
}
