//! SQL frontend: sqlparser AST -> logical plan.
//!
//! Supports SELECT / FROM (tables, views, CTEs, derived tables, table
//! functions `read_parquet` / `read_csv`, file paths) / explicit and implicit
//! joins (with connectivity-based join ordering) / WHERE / GROUP BY / HAVING
//! / ORDER BY (aliases, ordinals, hidden columns) / LIMIT / OFFSET /
//! DISTINCT / UNION [ALL] / EXCEPT / INTERSECT / VALUES, and subqueries:
//! uncorrelated scalar subqueries, `[NOT] IN (subquery)`, `[NOT] EXISTS`
//! (decorrelated into semi/anti joins) and correlated scalar aggregate
//! subqueries (decorrelated into aggregate + left join), window functions
//! (`OVER`, named windows, `QUALIFY`) and recursive CTEs.

pub mod command;
mod create;
pub mod ddl;
mod delta_stmt;
mod describe;
mod dml;
mod dialect;
mod distinct_on;
mod files;
mod grouping_sets;
mod join_order;
mod json;
mod lists;
mod maintenance;
pub mod params;
mod recursive;
mod sample;
mod structs;
mod timetravel;
mod wildcard;
mod window;
pub mod write;

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::ArrayRef;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use chrono::{NaiveDate, NaiveDateTime};
use sqlparser::ast as sql;
use sqlparser::parser::Parser;

use crate::catalog_names::TableRef;
use crate::error::{Result, WhError};
use crate::expr::*;
use crate::logical::{JoinType, LogicalPlan};
use crate::physical::expr::evaluate_constant;
use crate::scalar::Scalar;
use crate::schema::{Column, PlanSchema};
use crate::session::{MaterializedCte, SessionContext, TableEntry, plan_aggregate};
use crate::types::{common_supertype, parse_data_type};
pub use params::Params;

pub fn plan_sql(ctx: &SessionContext, query: &str, params: &Params) -> Result<LogicalPlan> {
    let dialect = dialect::IaraDialect;
    let bound = params.bind(query)?;
    let normalized = normalize_null_treatment(&bound);
    let stmts = Parser::parse_sql(&dialect, &normalized).map_err(|e| WhError::Sql(e.to_string()))?;
    if stmts.len() != 1 {
        return Err(WhError::Sql(format!("expected exactly one statement, got {}", stmts.len())));
    }
    // how often each word occurs: CTEs named more than twice (definition +
    // two references) are materialised once and shared
    let mut word_counts: HashMap<String, usize> = HashMap::new();
    if let Ok(tokens) = sqlparser::tokenizer::Tokenizer::new(&dialect, query).tokenize() {
        for t in tokens {
            if let sqlparser::tokenizer::Token::Word(w) = t {
                *word_counts.entry(w.value.to_ascii_lowercase()).or_default() += 1;
            }
        }
    }
    let mut planner = SqlPlanner { ctx, params, ctes: vec![], windows: vec![], next_id: 0, word_counts };
    match &stmts[0] {
        sql::Statement::Query(q) => planner.plan_query(q, None),
        sql::Statement::Explain { describe_alias: sql::DescribeAlias::Explain, analyze, statement, options: None, .. } => {
            let sql::Statement::Query(q) = statement.as_ref() else {
                return Err(WhError::NotSupported(format!("EXPLAIN of: {statement}")));
            };
            explain(ctx, planner.plan_query(q, None)?, *analyze)
        }
        other => Err(WhError::NotSupported(format!("statement type: {other}"))),
    }
}

/// `EXPLAIN [ANALYZE] query` as a one-row `plan` text column. `ANALYZE` runs
/// the query now (its result is discarded), like the statements that write.
fn explain(ctx: &SessionContext, plan: LogicalPlan, analyze: bool) -> Result<LogicalPlan> {
    let text = if analyze {
        crate::physical::analyze::explain_analyze(&plan)?
    } else {
        crate::session::LazyFrame::new(Arc::new(plan), ctx.clone()).explain(true)?
    };
    let schema = Arc::new(Schema::new(vec![Field::new("plan", DataType::Utf8, false)]));
    let column: ArrayRef = Arc::new(arrow::array::StringArray::from(vec![text]));
    Ok(LogicalPlan::values(schema.clone(), vec![RecordBatch::try_new(schema, vec![column])?]))
}

/// DuckDB writes `first_value(x IGNORE NULLS)`; the parser expects the null
/// treatment after the call: `first_value(x) IGNORE NULLS`.
fn normalize_null_treatment(query: &str) -> std::borrow::Cow<'_, str> {
    use sqlparser::tokenizer::{Location, Token, Tokenizer};
    let dialect = sqlparser::dialect::DuckDbDialect {};
    let Ok(tokens) = Tokenizer::new(&dialect, query).tokenize_with_location() else {
        return query.into();
    };
    let line_starts: Vec<usize> = std::iter::once(0).chain(query.match_indices('\n').map(|(i, _)| i + 1)).collect();
    let offset = |loc: &Location| -> Option<usize> {
        let start = *line_starts.get(loc.line.checked_sub(1)? as usize)?;
        query[start..].char_indices().nth(loc.column.checked_sub(1)? as usize).map(|(i, _)| start + i)
    };
    let word = |t: &Token, w: &str| matches!(t, Token::Word(x) if x.quote_style.is_none() && x.value.eq_ignore_ascii_case(w));
    let significant: Vec<_> = tokens.iter().filter(|t| !matches!(t.token, Token::Whitespace(_))).collect();
    let mut edits = vec![];
    for w in significant.windows(3) {
        let treatment = match () {
            _ if word(&w[0].token, "ignore") => "IGNORE",
            _ if word(&w[0].token, "respect") => "RESPECT",
            _ => continue,
        };
        if word(&w[1].token, "nulls") && w[2].token == Token::RParen {
            if let (Some(from), Some(paren)) = (offset(&w[0].span.start), offset(&w[2].span.start)) {
                edits.push((from, paren, treatment));
            }
        }
    }
    if edits.is_empty() {
        return query.into();
    }
    let mut out = String::with_capacity(query.len() + 8);
    let mut pos = 0;
    for (from, paren, treatment) in edits {
        out.push_str(&query[pos..from]);
        out.push_str(&format!(") {treatment} NULLS"));
        pos = paren + 1;
    }
    out.push_str(&query[pos..]);
    out.into()
}

#[derive(Clone, Copy)]
struct Scope<'s> {
    schema: &'s PlanSchema,
    outer: Option<&'s PlanSchema>,
    aliases: Option<&'s [(String, Expr)]>,
}

impl<'s> Scope<'s> {
    fn new(schema: &'s PlanSchema, outer: Option<&'s PlanSchema>) -> Self {
        Self { schema, outer, aliases: None }
    }
}

enum OrderKey {
    Output(usize),
    Hidden(usize),
}

struct SqlPlanner<'a> {
    ctx: &'a SessionContext,
    params: &'a Params,
    ctes: Vec<HashMap<String, Arc<LogicalPlan>>>,
    /// WINDOW clauses of the SELECTs being planned (innermost last)
    windows: Vec<Vec<sql::NamedWindowDefinition>>,
    next_id: usize,
    word_counts: HashMap<String, usize>,
}

fn ident(i: &sql::Ident) -> String {
    match i.quote_style {
        Some(_) => i.value.clone(),
        None => i.value.clone(),
    }
}

fn object_name_parts(n: &sql::ObjectName) -> Vec<String> {
    n.0.iter()
        .map(|p| match p {
            sql::ObjectNamePart::Identifier(i) => ident(i),
            other => other.to_string(),
        })
        .collect()
}

fn as_ordinal(e: &sql::Expr) -> Option<usize> {
    if let sql::Expr::Value(v) = e {
        if let sql::Value::Number(n, _) = &v.value {
            return n.parse::<usize>().ok();
        }
    }
    None
}

fn parse_number(s: &str) -> Result<Scalar> {
    if let Ok(v) = s.parse::<i64>() {
        return Ok(Scalar::int64(v));
    }
    if !s.contains(['e', 'E']) {
        if let Some((int_part, frac)) = s.split_once('.') {
            let digits: String = format!("{int_part}{frac}");
            let trimmed = digits.trim_start_matches('0');
            let precision = trimmed.len().max(frac.len()).max(1);
            if precision <= 38 {
                if let Ok(v) = digits.parse::<i128>() {
                    return Scalar::decimal128(v, precision as u8, frac.len() as i8);
                }
            }
        }
    }
    s.parse::<f64>()
        .map(Scalar::float64)
        .or_else(|_| s.parse::<u64>().map(Scalar::uint64))
        .map_err(|_| WhError::Sql(format!("invalid number '{s}'")))
}

fn parse_date(s: &str) -> Result<Scalar> {
    let d = NaiveDate::parse_from_str(s.trim(), "%Y-%m-%d")
        .map_err(|e| WhError::Sql(format!("invalid date '{s}': {e}")))?;
    Ok(Scalar::date32((d - NaiveDate::from_ymd_opt(1970, 1, 1).unwrap()).num_days() as i32))
}

fn parse_timestamp(s: &str) -> Result<Scalar> {
    let s = s.trim();
    for fmt in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M", "%Y-%m-%d"] {
        if let Ok(t) = NaiveDateTime::parse_from_str(s, fmt) {
            return Ok(Scalar::timestamp_us(t.and_utc().timestamp_micros(), None));
        }
        if let Ok(d) = NaiveDate::parse_from_str(s, fmt) {
            let t = d.and_hms_opt(0, 0, 0).unwrap();
            return Ok(Scalar::timestamp_us(t.and_utc().timestamp_micros(), None));
        }
    }
    Err(WhError::Sql(format!("invalid timestamp '{s}'")))
}

fn interval_from(n: f64, unit: &str) -> Result<Scalar> {
    let u = unit.trim().to_ascii_lowercase();
    let u = u.trim_end_matches('s');
    let ns = |x: f64| x as i64;
    Ok(match u {
        "year" | "yr" | "y" => Scalar::interval_mdn((n * 12.0) as i32, 0, 0),
        "quarter" => Scalar::interval_mdn((n * 3.0) as i32, 0, 0),
        "month" | "mon" => Scalar::interval_mdn(n as i32, 0, 0),
        "week" | "w" => Scalar::interval_mdn(0, (n * 7.0) as i32, 0),
        "day" | "d" => Scalar::interval_mdn(0, n as i32, 0),
        "hour" | "h" => Scalar::interval_mdn(0, 0, ns(n * 3.6e12)),
        "minute" | "min" | "m" => Scalar::interval_mdn(0, 0, ns(n * 6e10)),
        "second" | "sec" => Scalar::interval_mdn(0, 0, ns(n * 1e9)),
        "millisecond" | "ms" => Scalar::interval_mdn(0, 0, ns(n * 1e6)),
        other => return Err(WhError::Sql(format!("unsupported interval unit '{other}'"))),
    })
}

fn map_binop(op: &sql::BinaryOperator) -> Result<Operator> {
    use sql::BinaryOperator as B;
    Ok(match op {
        B::Plus => Operator::Plus,
        B::Minus => Operator::Minus,
        B::Multiply => Operator::Multiply,
        B::Divide => Operator::Divide,
        B::Modulo => Operator::Modulo,
        B::StringConcat => Operator::StringConcat,
        B::Gt => Operator::Gt,
        B::Lt => Operator::Lt,
        B::GtEq => Operator::GtEq,
        B::LtEq => Operator::LtEq,
        B::Eq => Operator::Eq,
        B::NotEq => Operator::NotEq,
        B::And => Operator::And,
        B::Or => Operator::Or,
        other => return Err(WhError::NotSupported(format!("operator {other}"))),
    })
}

/// `a IS NOT DISTINCT FROM b`, `a <=> b`: equality where NULL equals NULL.
fn null_safe_eq(l: Expr, r: Expr) -> Expr {
    Expr::Function { func: ScalarFunc::EqNullSafe, args: vec![l, r] }
}

/// Walk down Filter nodes and remove conjuncts that reference the outer query.
fn pull_up_correlated(plan: &LogicalPlan) -> Result<(LogicalPlan, Vec<Expr>)> {
    match plan {
        LogicalPlan::Filter(f) => {
            let (input, mut preds) = pull_up_correlated(&f.input)?;
            let (corr, rest): (Vec<Expr>, Vec<Expr>) =
                split_conjunction(&f.predicate).into_iter().partition(|p| p.contains_outer_ref());
            preds.extend(corr);
            let p = match conjunction(rest) {
                Some(r) => LogicalPlan::filter(Arc::new(input), r)?,
                None => input,
            };
            Ok((p, preds))
        }
        other => Ok((other.clone(), vec![])),
    }
}

fn plan_has_outer_ref(plan: &LogicalPlan) -> bool {
    let mut exprs: Vec<&Expr> = vec![];
    match plan {
        LogicalPlan::Filter(f) => exprs.push(&f.predicate),
        LogicalPlan::Projection(p) => exprs.extend(p.exprs.iter()),
        LogicalPlan::Aggregate(a) => {
            exprs.extend(a.group_by.iter());
            exprs.extend(a.aggs.iter());
        }
        LogicalPlan::Join(j) => {
            exprs.extend(j.on.iter().flat_map(|(l, r)| [l, r]));
            exprs.extend(j.filter.iter());
        }
        LogicalPlan::Sort(s) => exprs.extend(s.exprs.iter().map(|e| &e.expr)),
        LogicalPlan::Window(w) => exprs.extend(w.exprs.iter()),
        LogicalPlan::Unnest(u) => exprs.extend(u.exprs.iter()),
        _ => {}
    }
    exprs.iter().any(|e| e.contains_outer_ref()) || plan.inputs().iter().any(|i| plan_has_outer_ref(i))
}

fn outer_to_column(e: Expr) -> Result<Expr> {
    e.transform_up(&mut |x| match x {
        Expr::OuterRef(c, _) => Ok(Expr::Column(c)),
        o => Ok(o),
    })
}

impl<'a> SqlPlanner<'a> {
    fn fresh(&mut self) -> usize {
        self.next_id += 1;
        self.next_id
    }

    // -----------------------------------------------------------------------
    // queries
    // -----------------------------------------------------------------------

    fn plan_query(&mut self, q: &sql::Query, outer: Option<&PlanSchema>) -> Result<LogicalPlan> {
        let pushed = if let Some(with) = &q.with {
            self.ctes.push(HashMap::new());
            for cte in &with.cte_tables {
                let columns: Vec<String> = cte.alias.columns.iter().map(|c| ident(&c.name)).collect();
                let name = ident(&cte.alias.name).to_ascii_lowercase();
                let recursive = match with.recursive {
                    true => self.plan_recursive_cte(cte, &columns)?,
                    false => None,
                };
                let is_recursive = matches!(recursive, Some(LogicalPlan::RecursiveQuery(_)));
                let p = match recursive {
                    Some(p) => p,
                    None => {
                        let p = self.plan_query(&cte.query, None)?;
                        if columns.is_empty() { p } else { self.rename_columns(p, &columns)? }
                    }
                };
                // references outside the definition (a recursive CTE names itself in its body)
                let mut refs = self.word_counts.get(&name).copied().unwrap_or(0).saturating_sub(1);
                if is_recursive {
                    refs = refs.saturating_sub(count_words(&cte.query.to_string(), &name));
                }
                let p = if refs >= 2 {
                    let provider = Arc::new(MaterializedCte::new(&name, Arc::new(p)));
                    LogicalPlan::scan(&name, None, provider, None, vec![], None)?
                } else {
                    p
                };
                self.ctes.last_mut().unwrap().insert(name, Arc::new(p));
            }
            true
        } else {
            false
        };
        let order_by: Vec<sql::OrderByExpr> = match &q.order_by {
            Some(ob) => match &ob.kind {
                sql::OrderByKind::Expressions(v) => v.clone(),
                sql::OrderByKind::All(_) => return Err(WhError::NotSupported("ORDER BY ALL".into())),
            },
            None => vec![],
        };
        let mut plan = self.plan_set_expr(&q.body, &order_by, outer)?;
        let (limit, offset) = match &q.limit_clause {
            Some(sql::LimitClause::LimitOffset { limit, offset, .. }) => (limit.clone(), offset.as_ref().map(|o| o.value.clone())),
            Some(sql::LimitClause::OffsetCommaLimit { offset, limit }) => (Some(limit.clone()), Some(offset.clone())),
            None => (None, None),
        };
        let limit = match (&limit, &q.fetch) {
            (Some(l), _) => Some(l.clone()),
            (None, Some(f)) => f.quantity.clone(),
            _ => None,
        };
        if limit.is_some() || offset.is_some() {
            let fetch = match &limit {
                Some(e) => Some(self.const_usize(e)?),
                None => None,
            };
            let skip = match &offset {
                Some(e) => self.const_usize(e)?,
                None => 0,
            };
            plan = LogicalPlan::limit(Arc::new(plan), skip, fetch);
        }
        if pushed {
            self.ctes.pop();
        }
        Ok(plan)
    }

    fn const_usize(&mut self, e: &sql::Expr) -> Result<usize> {
        let empty = PlanSchema::empty();
        let x = self.sql_expr(e, Scope::new(&empty, None))?;
        evaluate_constant(&x)?
            .and_then(|s| s.as_i64())
            .filter(|v| *v >= 0)
            .map(|v| v as usize)
            .ok_or_else(|| WhError::Sql(format!("expected a non-negative integer constant, got {e}")))
    }

    fn rename_columns(&mut self, plan: LogicalPlan, names: &[String]) -> Result<LogicalPlan> {
        // rename a projection's expressions in place: its columns may share a
        // name (`SELECT id, id ..`), which a reference by name could not tell apart
        if let LogicalPlan::Projection(p) = &plan {
            let exprs = p
                .exprs
                .iter()
                .enumerate()
                .map(|(i, e)| match names.get(i) {
                    Some(n) => e.clone().alias(n.clone()),
                    None => e.clone(),
                })
                .collect();
            return LogicalPlan::project(p.input.clone(), exprs);
        }
        let schema = plan.schema().clone();
        let exprs = (0..schema.len())
            .map(|i| {
                let c = Expr::Column(schema.column(i));
                match names.get(i) {
                    Some(n) => c.alias(n.clone()),
                    None => c,
                }
            })
            .collect();
        LogicalPlan::project(Arc::new(plan), exprs)
    }

    fn plan_set_expr(&mut self, body: &sql::SetExpr, order_by: &[sql::OrderByExpr], outer: Option<&PlanSchema>) -> Result<LogicalPlan> {
        match body {
            sql::SetExpr::Select(s) => self.plan_select(s, order_by, outer),
            sql::SetExpr::Query(q) => {
                let p = self.plan_query(q, outer)?;
                self.order_output(p, order_by)
            }
            sql::SetExpr::SetOperation { left, op, set_quantifier, right } => {
                let l = self.plan_set_expr(left, &[], outer)?;
                let r = self.plan_set_expr(right, &[], outer)?;
                let all = matches!(set_quantifier, sql::SetQuantifier::All | sql::SetQuantifier::AllByName);
                let plan = match op {
                    sql::SetOperator::Union => {
                        let u = LogicalPlan::union(vec![Arc::new(l), Arc::new(r)])?;
                        if all { u } else { distinct(u)? }
                    }
                    sql::SetOperator::Except | sql::SetOperator::Intersect | sql::SetOperator::Minus => {
                        let jt = if matches!(op, sql::SetOperator::Intersect) { JoinType::Semi } else { JoinType::Anti };
                        let id = self.fresh();
                        let ra = LogicalPlan::subquery_alias(Arc::new(r), &format!("__set{id}"));
                        let ls = l.schema().clone();
                        let rs = ra.schema().clone();
                        if ls.len() != rs.len() {
                            return Err(WhError::Plan("set operation inputs have different column counts".into()));
                        }
                        let on = (0..ls.len()).map(|i| (Expr::Column(ls.column(i)), Expr::Column(rs.column(i)))).collect();
                        let j = LogicalPlan::join(Arc::new(l), Arc::new(ra), on, None, jt)?;
                        if all { j } else { distinct(j)? }
                    }
                };
                self.order_output(plan, order_by)
            }
            sql::SetExpr::Values(v) => {
                let p = self.plan_values(v)?;
                self.order_output(p, order_by)
            }
            other => Err(WhError::NotSupported(format!("query body: {other}"))),
        }
    }

    /// ORDER BY over the output columns of a plan (set operations, nested queries).
    fn order_output(&mut self, plan: LogicalPlan, order_by: &[sql::OrderByExpr]) -> Result<LogicalPlan> {
        if order_by.is_empty() {
            return Ok(plan);
        }
        let schema = plan.schema().clone();
        let mut sorts = vec![];
        for o in order_by {
            let e = match as_ordinal(&o.expr) {
                Some(k) if k >= 1 && k <= schema.len() => Expr::Column(schema.column(k - 1)),
                _ => self.sql_expr(&o.expr, Scope::new(&schema, None))?,
            };
            let (desc, nf) = sort_opts(o);
            sorts.push(SortExpr::new(e, desc, nf));
        }
        LogicalPlan::sort(Arc::new(plan), sorts, None)
    }

    fn plan_values(&mut self, v: &sql::Values) -> Result<LogicalPlan> {
        let empty = PlanSchema::empty();
        let rows: Vec<Vec<Scalar>> = v
            .rows
            .iter()
            .map(|r| {
                r.iter()
                    .map(|e| {
                        let x = self.sql_expr(e, Scope::new(&empty, None))?;
                        evaluate_constant(&x)?.ok_or_else(|| WhError::Sql(format!("VALUES requires constants: {e}")))
                    })
                    .collect::<Result<Vec<_>>>()
            })
            .collect::<Result<_>>()?;
        let ncols = rows.first().map(|r| r.len()).unwrap_or(0);
        let mut fields = vec![];
        let mut cols: Vec<ArrayRef> = vec![];
        for c in 0..ncols {
            let types: Vec<DataType> = rows.iter().map(|r| r[c].data_type().clone()).collect();
            let mut t = common_supertype(types.iter()).unwrap_or(DataType::Utf8);
            if t == DataType::Null {
                t = DataType::Int64;
            }
            let arrays = rows.iter().map(|r| r[c].cast_to(&t).map(|s| s.array().clone())).collect::<Result<Vec<_>>>()?;
            let refs: Vec<&dyn arrow::array::Array> = arrays.iter().map(|a| a.as_ref()).collect();
            cols.push(arrow::compute::concat(&refs)?);
            fields.push(Field::new(format!("column{}", c + 1), t, true));
        }
        let schema = Arc::new(Schema::new(fields));
        let batch = RecordBatch::try_new(schema.clone(), cols)?;
        Ok(LogicalPlan::values(schema, vec![batch]))
    }

    // -----------------------------------------------------------------------
    // FROM
    // -----------------------------------------------------------------------

    /// A table, view or CTE named in FROM (or, failing that, a file path).
    /// `c.s.t` resolves only as that, `s.t` only in schema `s` of the current
    /// catalog; a CTE matches only a bare name. Scans are named by the bare
    /// table name.
    fn plan_named_table(&mut self, parts: &[String], alias_name: Option<String>) -> Result<LogicalPlan> {
        let full = parts.join(".");
        let tname = full.rsplit('.').next().unwrap_or_default().to_string();
        let q = alias_name.clone().unwrap_or(tname.clone());
        if let [only] = parts {
            if let Some(cte) = self.ctes.iter().rev().find_map(|m| m.get(&only.to_ascii_lowercase())).cloned() {
                return Ok(LogicalPlan::subquery_alias(cte, &alias_name.unwrap_or(only.clone())));
            }
        }
        let table_ref = TableRef::lenient(&full);
        match self.ctx.lookup_ref(&table_ref)? {
            Some(TableEntry::Table(t)) => LogicalPlan::scan(&tname, Some(q), t, None, vec![], None),
            Some(TableEntry::View(p)) => Ok(LogicalPlan::subquery_alias(p, &q)),
            None if [".parquet", ".csv", "*", "/", "\\"].iter().any(|s| full.contains(s)) => {
                self.ctx.check_files()?;
                let provider = files::path_provider(&full)?;
                let q = alias_name.unwrap_or_else(|| crate::io::location::stem(&full));
                LogicalPlan::scan(&full, Some(q), provider, None, vec![], None)
            }
            None => Err(self.table_not_found(&full, &table_ref)),
        }
    }

    fn table_not_found(&self, full: &str, r: &TableRef) -> WhError {
        let registered = self.ctx.table_names();
        match self.ctx.unknown_parent(r) {
            Some(m) => WhError::Plan(format!("table '{full}' not found: {} (registered: {registered:?})", m.reason())),
            None => WhError::Plan(format!("table '{full}' not found (registered: {registered:?})")),
        }
    }

    fn plan_table_factor(&mut self, tf: &sql::TableFactor, outer: Option<&PlanSchema>) -> Result<LogicalPlan> {
        if let Some(call) = lists::unnest_call(tf) {
            return self.lateral_unnest(None, &call, outer);
        }
        match tf {
            sql::TableFactor::Table { name, alias, args, version, sample, .. } => {
                let parts = object_name_parts(name);
                let alias_name = alias.as_ref().map(|a| ident(&a.name));
                let mut plan = if let Some(args) = args {
                    let fname = parts.last().cloned().unwrap_or_default().to_ascii_lowercase();
                    self.ctx.check_files()?;
                    let provider = files::table_function(&fname, &args.args)?;
                    let q = alias_name.clone().unwrap_or(fname);
                    LogicalPlan::scan(&q, Some(q.clone()), provider, None, vec![], None)?
                } else if let Some(v) = version {
                    self.plan_versioned_table(&parts, alias_name, v)?
                } else {
                    self.plan_named_table(&parts, alias_name)?
                };
                if let Some(kind) = sample {
                    plan = self.sample_table(plan, kind)?;
                }
                if let Some(a) = alias {
                    if !a.columns.is_empty() {
                        let names: Vec<String> = a.columns.iter().map(|c| ident(&c.name)).collect();
                        plan = self.rename_columns(plan, &names)?;
                        plan = LogicalPlan::subquery_alias(Arc::new(plan), &ident(&a.name));
                    }
                }
                Ok(plan)
            }
            sql::TableFactor::Derived { lateral, subquery, alias, sample } => {
                if *lateral {
                    return Err(WhError::NotSupported("LATERAL subqueries".into()));
                }
                let _ = outer;
                let mut p = self.plan_query(subquery, None)?;
                if let Some(kind) = sample {
                    p = self.sample_table(p, kind)?;
                }
                let name = match alias {
                    Some(a) => {
                        if !a.columns.is_empty() {
                            let names: Vec<String> = a.columns.iter().map(|c| ident(&c.name)).collect();
                            p = self.rename_columns(p, &names)?;
                        }
                        ident(&a.name)
                    }
                    None => format!("__subquery{}", self.fresh()),
                };
                Ok(LogicalPlan::subquery_alias(Arc::new(p), &name))
            }
            sql::TableFactor::NestedJoin { table_with_joins, alias } => {
                let p = self.plan_table_with_joins(table_with_joins, outer)?;
                Ok(match alias {
                    Some(a) => LogicalPlan::subquery_alias(Arc::new(p), &ident(&a.name)),
                    None => p,
                })
            }
            other => Err(WhError::NotSupported(format!("FROM item: {other}"))),
        }
    }

    fn plan_table_with_joins(&mut self, twj: &sql::TableWithJoins, outer: Option<&PlanSchema>) -> Result<LogicalPlan> {
        let mut plan = self.plan_table_factor(&twj.relation, outer)?;
        for j in &twj.joins {
            if let Some(call) = lists::unnest_call(&j.relation) {
                plan = self.lateral_unnest(Some(plan), &call, outer)?;
                continue;
            }
            let right = self.plan_table_factor(&j.relation, outer)?;
            use sql::JoinOperator as J;
            let (jt, constraint) = match &j.join_operator {
                J::Join(c) | J::Inner(c) => (JoinType::Inner, Some(c)),
                J::Left(c) | J::LeftOuter(c) => (JoinType::Left, Some(c)),
                J::Right(c) | J::RightOuter(c) => (JoinType::Right, Some(c)),
                J::FullOuter(c) => (JoinType::Full, Some(c)),
                J::CrossJoin(c) => (JoinType::Inner, Some(c)),
                J::Semi(c) | J::LeftSemi(c) => (JoinType::Semi, Some(c)),
                J::Anti(c) | J::LeftAnti(c) => (JoinType::Anti, Some(c)),
                other => return Err(WhError::NotSupported(format!("join type {other:?}"))),
            };
            let ls = plan.schema().clone();
            let rs = right.schema().clone();
            let joined = PlanSchema::join(&ls, &rs);
            let (on, filter, merged) = match constraint {
                Some(sql::JoinConstraint::On(e)) => (vec![], Some(self.sql_expr(e, Scope::new(&joined, outer))?), vec![]),
                Some(sql::JoinConstraint::Using(names)) => {
                    let mut on = vec![];
                    let mut merged = vec![];
                    for n in names {
                        let name = object_name_parts(n).last().cloned().unwrap_or_default();
                        let c = Column::from_name(name.clone());
                        let li = ls.index_of(&c)?;
                        let ri = rs.index_of(&c)?;
                        on.push((Expr::Column(ls.column(li)), Expr::Column(rs.column(ri))));
                        merged.push(name);
                    }
                    (on, None, merged)
                }
                Some(sql::JoinConstraint::Natural) => {
                    let mut on = vec![];
                    let mut merged = vec![];
                    for f in ls.fields() {
                        if let Ok(Some(ri)) = rs.maybe_index_of(&Column::from_name(f.name())) {
                            on.push((Expr::Column(f.column()), Expr::Column(rs.column(ri))));
                            merged.push(f.name().to_string());
                        }
                    }
                    (on, None, merged)
                }
                _ => (vec![], None, vec![]),
            };
            let using: Vec<(Expr, Expr)> = on.clone();
            plan = LogicalPlan::join(Arc::new(plan), Arc::new(right), on, filter, jt)?;
            if !merged.is_empty() && !matches!(jt, JoinType::Semi | JoinType::Anti) {
                plan = merge_using_columns(plan, &merged, &using, jt)?;
            }
        }
        Ok(plan)
    }

    /// Join ordering for comma-separated FROM items: Greedy Operator Ordering.
    /// Starting from one node per relation (estimated with its local
    /// filters), repeatedly join the pair of nodes connected by an equi-join
    /// predicate with the smallest estimated result. This builds bushy trees
    /// (e.g. `(lineitem ⋈ supplier ⋈ nation) ⋈ (orders ⋈ customer ⋈ nation)`)
    /// and, thanks to NDV estimates from file statistics, avoids
    /// many-to-many joins on low-cardinality keys.
    /// Returns the join tree and the conjuncts to filter it with: `conjuncts`,
    /// with the equalities between relations replaced by those the tree's
    /// joins need (see [`join_order`]).
    fn order_joins(&mut self, rels: Vec<LogicalPlan>, conjuncts: Vec<Expr>) -> Result<(LogicalPlan, Vec<Expr>)> {
        use crate::physical::planner::{estimate_rows, join_cardinality};
        if rels.is_empty() {
            return Ok((LogicalPlan::one_row()?, conjuncts));
        }
        if rels.len() == 1 {
            return Ok((rels.into_iter().next().unwrap(), conjuncts));
        }
        let plain: Vec<&Expr> = conjuncts.iter().filter(|c| !c.contains_subquery()).collect();
        let rel_of = |e: &Expr| -> Vec<usize> {
            let mut s: Vec<usize> = vec![];
            for col in e.column_refs() {
                for (i, r) in rels.iter().enumerate() {
                    if r.schema().has_column(&col) && !s.contains(&i) {
                        s.push(i);
                    }
                }
            }
            s
        };
        // equi-join edges between single relations
        let mut edges: Vec<(Expr, Expr, usize, usize)> = vec![];
        for c in &plain {
            if let Expr::Binary { left, op: Operator::Eq, right } = c {
                let (lr, rr) = (rel_of(left), rel_of(right));
                if lr.len() == 1 && rr.len() == 1 && lr[0] != rr[0] {
                    edges.push((left.as_ref().clone(), right.as_ref().clone(), lr[0], rr[0]));
                }
            }
        }
        struct Node {
            plan: LogicalPlan,
            rels: Vec<usize>,
            rows: f64,
        }
        let mut nodes: Vec<Node> = Vec::with_capacity(rels.len());
        for (i, r) in rels.into_iter().enumerate() {
            let mut local = vec![];
            for c in &plain {
                let refs = c.column_refs();
                if refs.is_empty() {
                    continue;
                }
                if refs.iter().all(|col| r.schema().has_column(col)) {
                    local.push((*c).clone());
                } else if let Some(d) = crate::optimizer::derive_side_predicate(c, r.schema()) {
                    local.push(d);
                }
            }
            let rows = match conjunction(local) {
                Some(f) => LogicalPlan::filter(Arc::new(r.clone()), f).map(|p| estimate_rows(&p)).unwrap_or(1e6),
                None => estimate_rows(&r),
            };
            nodes.push(Node { plan: r, rels: vec![i], rows });
        }
        if nodes.len() <= join_order::MAX_RELATIONS {
            let rels = nodes.iter().map(|n| join_order::Relation { plan: n.plan.clone(), rows: n.rows }).collect();
            if let Some(o) = join_order::order(rels, &plain)? {
                let mut conjuncts: Vec<Expr> = conjuncts.iter().filter(|c| !o.replaced.contains(c)).cloned().collect();
                conjuncts.extend(o.equalities);
                return Ok((o.plan, conjuncts));
            }
        }
        while nodes.len() > 1 {
            let mut best: Option<(usize, usize, f64)> = None;
            for i in 0..nodes.len() {
                for j in (i + 1)..nodes.len() {
                    let on: Vec<(Expr, Expr)> = edges
                        .iter()
                        .filter_map(|(l, r, lr, rr)| {
                            if nodes[i].rels.contains(lr) && nodes[j].rels.contains(rr) {
                                Some((l.clone(), r.clone()))
                            } else if nodes[i].rels.contains(rr) && nodes[j].rels.contains(lr) {
                                Some((r.clone(), l.clone()))
                            } else {
                                None
                            }
                        })
                        .collect();
                    if on.is_empty() {
                        continue;
                    }
                    let est = join_cardinality(&nodes[i].plan, &nodes[j].plan, &on, nodes[i].rows, nodes[j].rows);
                    if best.is_none_or(|(_, _, b)| est < b) {
                        best = Some((i, j, est));
                    }
                }
            }
            let (i, j, est) = match best {
                Some(b) => b,
                None => {
                    // no connecting predicate: cross join the two smallest nodes
                    let mut idx: Vec<usize> = (0..nodes.len()).collect();
                    idx.sort_by(|a, b| nodes[*a].rows.total_cmp(&nodes[*b].rows));
                    let (a, b) = (idx[0].min(idx[1]), idx[0].max(idx[1]));
                    (a, b, nodes[a].rows * nodes[b].rows)
                }
            };
            let right = nodes.remove(j);
            let left = nodes.remove(i);
            let mut rels_union = left.rels.clone();
            rels_union.extend(right.rels.iter().copied());
            // larger input on the left (the probe side by convention)
            let (a, b) = if left.rows >= right.rows { (left, right) } else { (right, left) };
            let plan = LogicalPlan::join(Arc::new(a.plan), Arc::new(b.plan), vec![], None, JoinType::Inner)?;
            nodes.insert(i, Node { plan, rels: rels_union, rows: est.max(1.0) });
        }
        Ok((nodes.pop().unwrap().plan, conjuncts))
    }

    // -----------------------------------------------------------------------
    // SELECT
    // -----------------------------------------------------------------------

    fn plan_select(&mut self, s: &sql::Select, order_by: &[sql::OrderByExpr], outer: Option<&PlanSchema>) -> Result<LogicalPlan> {
        self.windows.push(s.named_window.clone());
        let plan = self.plan_select_inner(s, order_by, outer);
        self.windows.pop();
        plan
    }

    fn plan_select_inner(&mut self, s: &sql::Select, order_by: &[sql::OrderByExpr], outer: Option<&PlanSchema>) -> Result<LogicalPlan> {
        // FROM
        let mut rels: Vec<LogicalPlan> = vec![];
        for t in &s.from {
            match lists::unnest_call(&t.relation) {
                // `FROM t, unnest(t.l)`: reads the item before it
                Some(call) if t.joins.is_empty() => {
                    let prior = rels.pop();
                    rels.push(self.lateral_unnest(prior, &call, outer)?);
                }
                _ => rels.push(self.plan_table_with_joins(t, outer)?),
            }
        }
        let combined = rels
            .iter()
            .fold(PlanSchema::empty(), |acc, r| PlanSchema::join(&acc, r.schema()));
        // WHERE
        let conjuncts = match &s.selection {
            Some(w) => split_conjunction(&no_windows(self.sql_expr(w, Scope::new(&combined, outer))?, "WHERE")?),
            None => vec![],
        };
        let (mut plan, conjuncts) = self.order_joins(rels, conjuncts)?;
        // plain predicates first: subquery decorrelation then sees (and can
        // exploit) the already filtered outer relation
        let (plain, with_subquery): (Vec<Expr>, Vec<Expr>) = conjuncts.into_iter().partition(|c| !c.contains_subquery());
        if let Some(f) = conjunction(plain) {
            plan = LogicalPlan::filter(Arc::new(plan), f)?;
        }
        let mut filters = vec![];
        for c in with_subquery {
            let c = match c {
                Expr::Not(inner) => match *inner {
                    Expr::Exists { subquery, negated } => Expr::Exists { subquery, negated: !negated },
                    Expr::InSubquery { expr, subquery, negated } => Expr::InSubquery { expr, subquery, negated: !negated },
                    other => Expr::Not(Box::new(other)),
                },
                c => c,
            };
            match c {
                Expr::Exists { subquery, negated } => plan = self.plan_exists(plan, &subquery.0, negated)?,
                Expr::InSubquery { expr, subquery, negated } => {
                    plan = self.plan_in_subquery(plan, *expr, &subquery.0, negated)?
                }
                c if c.contains_subquery() => {
                    let (p, c2) = self.decorrelate_scalars(plan, c)?;
                    plan = p;
                    filters.push(c2);
                }
                c => filters.push(c),
            }
        }
        if let Some(f) = conjunction(filters) {
            plan = LogicalPlan::filter(Arc::new(plan), f)?;
        }

        // SELECT list
        let from_schema = plan.schema().clone();
        let scope = Scope::new(&from_schema, outer);
        let mut select_exprs: Vec<Expr> = vec![];
        for item in &s.projection {
            match item {
                sql::SelectItem::UnnamedExpr(e) => {
                    let x = self.sql_expr(e, scope)?;
                    select_exprs.extend(Self::expand_struct_unnest(x, false, scope)?);
                }
                sql::SelectItem::ExprWithAlias { expr, alias } => {
                    let x = self.sql_expr(expr, scope)?;
                    select_exprs.extend(Self::expand_struct_unnest(x, true, scope)?.into_iter().map(|e| e.alias(ident(alias))));
                }
                sql::SelectItem::Wildcard(opts) => {
                    let opts = wildcard::WildcardOpts::new(opts)?;
                    let columns = from_schema
                        .fields()
                        .iter()
                        .filter(|f| !(f.qualifier.as_deref().is_some_and(|q| q.starts_with("__")) && f.name().starts_with("__")))
                        .map(|f| (f.name().to_string(), Expr::Column(f.column())))
                        .collect();
                    select_exprs.extend(opts.apply(self, columns, scope)?);
                }
                sql::SelectItem::QualifiedWildcard(kind, opts) => {
                    let q = match kind {
                        sql::SelectItemQualifiedWildcardKind::ObjectName(n) => object_name_parts(n).last().cloned().unwrap_or_default(),
                        sql::SelectItemQualifiedWildcardKind::Expr(e) => e.to_string(),
                    };
                    let opts = wildcard::WildcardOpts::new(opts)?;
                    let mut columns: Vec<(String, Expr)> = from_schema
                        .fields()
                        .iter()
                        .filter(|f| f.qualifier.as_deref().is_some_and(|fq| fq.eq_ignore_ascii_case(&q)))
                        .map(|f| (f.name().to_string(), Expr::Column(f.column())))
                        .collect();
                    if columns.is_empty() {
                        let target = match kind {
                            sql::SelectItemQualifiedWildcardKind::ObjectName(n) => self.resolve_parts(&object_name_parts(n), scope)?,
                            sql::SelectItemQualifiedWildcardKind::Expr(e) => Some(self.sql_expr(e, scope)?),
                        };
                        match target.map(|t| self.expand_struct_star(t, &[], scope)).transpose()?.flatten() {
                            Some(fields) => columns = fields.into_iter().map(|e| (e.output_name(), e)).collect(),
                            None => return Err(WhError::Plan(format!("no columns for '{q}.*'"))),
                        }
                    }
                    select_exprs.extend(opts.apply(self, columns, scope)?);
                }
                other => return Err(WhError::NotSupported(format!("select item {other}"))),
            }
        }
        let has_unnest = |e: &Expr| {
            let mut found = false;
            e.visit(&mut |x| {
                found |= matches!(x, Expr::Function { func: ScalarFunc::Unnest, .. });
                !found
            });
            found
        };
        let from_schema = if select_exprs.iter().any(has_unnest) {
            if s.group_by != sql::GroupByExpr::Expressions(vec![], vec![]) || select_exprs.iter().any(|e| e.contains_agg()) {
                return Err(WhError::NotSupported("unnest(..) together with GROUP BY or aggregates; unnest in a subquery".into()));
            }
            let (p, sel) = self.unnest_select(plan, select_exprs)?;
            plan = p;
            select_exprs = sel;
            plan.schema().clone()
        } else {
            from_schema
        };
        let aliases: Vec<(String, Expr)> = select_exprs
            .iter()
            .filter_map(|e| match e {
                Expr::Alias(inner, n) => Some((n.clone(), inner.as_ref().clone())),
                _ => None,
            })
            .collect();
        let alias_scope = Scope { schema: &from_schema, outer, aliases: Some(&aliases) };

        // GROUP BY
        let mut gsets: Option<grouping_sets::Sets> = None;
        let group_exprs: Vec<Expr> = match &s.group_by {
            sql::GroupByExpr::Expressions(exprs, mods) => {
                if !mods.is_empty() {
                    return Err(WhError::NotSupported("GROUP BY ... WITH ROLLUP (use ROLLUP(..))".into()));
                }
                if grouping_sets::has_grouping_sets(exprs) {
                    let sets = self.grouping_sets(exprs, |this, g| this.group_key(g, &select_exprs, alias_scope))?;
                    let keys = sets.keys.clone();
                    gsets = Some(sets);
                    keys
                } else {
                exprs
                    .iter()
                    .map(|g| match as_ordinal(g) {
                        Some(k) if k >= 1 && k <= select_exprs.len() => Ok(select_exprs[k - 1].clone().unalias()),
                        _ => self.sql_expr(g, alias_scope),
                    })
                    .map(|g| no_windows(g?, "GROUP BY"))
                    .collect::<Result<_>>()?
                }
            }
            sql::GroupByExpr::All(_) => select_exprs
                .iter()
                .filter(|e| !e.contains_agg() && !e.contains_window())
                .map(|e| e.clone().unalias())
                .collect(),
        };
        let having = match &s.having {
            Some(h) => Some(no_windows(self.sql_expr(h, alias_scope)?, "HAVING")?),
            None => None,
        };
        let mut qualify = match &s.qualify {
            Some(q) => Some(self.sql_expr(q, alias_scope)?),
            None => None,
        };

        // ORDER BY (resolved against output names first)
        let out_names: Vec<String> = select_exprs.iter().map(|e| e.output_name()).collect();
        let mut order_keys: Vec<(OrderKey, bool, bool)> = vec![];
        let mut hidden: Vec<Expr> = vec![];
        for o in order_by {
            let (desc, nf) = sort_opts(o);
            let key = self.order_key(&o.expr, &select_exprs, &out_names, &mut hidden, alias_scope)?;
            order_keys.push((key, desc, nf));
        }
        let mut distinct_on_keys: Vec<OrderKey> = vec![];
        if let Some(sql::Distinct::On(keys)) = &s.distinct {
            for k in keys {
                distinct_on_keys.push(self.order_key(k, &select_exprs, &out_names, &mut hidden, alias_scope)?);
            }
        }

        let is_agg = !group_exprs.is_empty()
            || select_exprs.iter().any(|e| e.contains_agg())
            || having.as_ref().is_some_and(|h| h.contains_agg())
            || qualify.as_ref().is_some_and(|q| q.contains_agg());
        let n_sel = select_exprs.len();
        if let (true, Some(sets)) = (is_agg, &gsets) {
            if qualify.is_some() {
                return Err(WhError::NotSupported("QUALIFY with ROLLUP/CUBE/GROUPING SETS".into()));
            }
            let (p, sel, hid) = self.plan_grouping_sets(plan, sets, select_exprs, having, hidden, Scope::new(&from_schema, outer))?;
            plan = p;
            select_exprs = sel;
            hidden = hid;
        } else if is_agg {
            let mut all = select_exprs.clone();
            if let Some(h) = &having {
                all.push(h.clone().alias("__having"));
            }
            if let Some(q) = &qualify {
                all.push(q.clone().alias("__qualify"));
            }
            for (i, h) in hidden.iter().enumerate() {
                all.push(h.clone().alias(format!("__sort_{i}")));
            }
            let r = plan_aggregate(Arc::new(plan), group_exprs, all)?;
            plan = r.plan;
            let mut rewritten = r.exprs;
            let rest = rewritten.split_off(n_sel);
            select_exprs = rewritten;
            let mut rest = rest.into_iter();
            if having.is_some() {
                let h = rest.next().unwrap().unalias();
                plan = LogicalPlan::filter(Arc::new(plan), h)?;
            }
            if qualify.is_some() {
                qualify = Some(rest.next().unwrap().unalias());
            }
            hidden = rest.map(|e| e.unalias()).collect();
        } else if having.is_some() {
            return Err(WhError::Plan("HAVING requires GROUP BY or aggregates".into()));
        }

        // window functions run after grouping, before DISTINCT / ORDER BY
        let windowed = select_exprs.iter().chain(&hidden).chain(&qualify).any(|e| e.contains_window());
        if windowed {
            let mut all = select_exprs;
            all.extend(hidden.iter().enumerate().map(|(i, h)| h.clone().alias(format!("__sort_{i}"))));
            all.extend(qualify.iter().map(|q| q.clone().alias("__qualify")));
            let (p, mut rewritten) = crate::window::plan_windows(Arc::new(plan), all)?;
            plan = p;
            if qualify.is_some() {
                qualify = rewritten.pop().map(|q| q.unalias());
            }
            hidden = rewritten.split_off(n_sel).into_iter().map(|e| e.unalias()).collect();
            select_exprs = rewritten;
        }
        if let Some(q) = qualify {
            if !windowed {
                return Err(WhError::Plan("QUALIFY requires a window function".into()));
            }
            plan = LogicalPlan::filter(Arc::new(plan), q)?;
        }

        let mut proj = select_exprs;
        for (i, h) in hidden.iter().enumerate() {
            proj.push(h.clone().alias(format!("__sort_{i}")));
        }
        plan = LogicalPlan::project(Arc::new(plan), proj)?;
        match &s.distinct {
            Some(sql::Distinct::Distinct) => plan = distinct(plan)?,
            Some(sql::Distinct::On(_)) => plan = distinct_on::distinct_on(plan, &distinct_on_keys, &order_keys)?,
            _ => {}
        }
        if !order_keys.is_empty() {
            let schema = plan.schema().clone();
            let sorts = order_keys.into_iter().map(|(k, desc, nf)| SortExpr::new(k.column(&schema), desc, nf)).collect();
            plan = LogicalPlan::sort(Arc::new(plan), sorts, None)?;
        }
        if !hidden.is_empty() {
            let schema = plan.schema().clone();
            let keep = (0..n_sel).map(|i| Expr::Column(schema.column(i))).collect();
            plan = LogicalPlan::project(Arc::new(plan), keep)?;
        }
        Ok(plan)
    }

    // -----------------------------------------------------------------------
    // subqueries
    // -----------------------------------------------------------------------

    /// Rename all columns of `plan` to unique names; returns the projected
    /// plan and a rewriter for expressions over the original schema.
    fn isolate(&mut self, plan: LogicalPlan) -> Result<(LogicalPlan, impl Fn(Expr) -> Result<Expr> + use<>)> {
        let id = self.fresh();
        let schema = plan.schema().clone();
        let names: Vec<String> = (0..schema.len()).map(|i| format!("__sq{id}_{i}")).collect();
        let exprs = (0..schema.len()).map(|i| Expr::Column(schema.column(i)).alias(names[i].clone())).collect();
        let p = LogicalPlan::project(Arc::new(plan), exprs)?;
        let rewrite = move |e: Expr| -> Result<Expr> {
            e.transform_up(&mut |x| match x {
                Expr::Column(c) => {
                    let i = schema.index_of(&c)?;
                    Ok(Expr::Column(Column::from_name(names[i].clone())))
                }
                Expr::OuterRef(c, _) => Ok(Expr::Column(c)),
                o => Ok(o),
            })
        };
        Ok((p, rewrite))
    }

    fn strip_projection(plan: &LogicalPlan) -> &LogicalPlan {
        match plan {
            LogicalPlan::Projection(p) if !p.exprs.iter().any(|e| e.contains_outer_ref()) => Self::strip_projection(&p.input),
            LogicalPlan::SubqueryAlias(s) => Self::strip_projection(&s.input),
            other => other,
        }
    }

    fn plan_exists(&mut self, plan: LogicalPlan, sub: &LogicalPlan, negated: bool) -> Result<LogicalPlan> {
        let inner = Self::strip_projection(sub);
        let (inner, corr) = pull_up_correlated(inner)?;
        if plan_has_outer_ref(&inner) {
            return Err(WhError::NotSupported("correlated EXISTS subquery of this shape".into()));
        }
        let (inner, rewrite) = self.isolate(inner)?;
        let filter = corr.into_iter().map(&rewrite).collect::<Result<Vec<_>>>()?;
        let jt = if negated { JoinType::Anti } else { JoinType::Semi };
        LogicalPlan::join(Arc::new(plan), Arc::new(inner), vec![], conjunction(filter), jt)
    }

    fn plan_in_subquery(&mut self, plan: LogicalPlan, expr: Expr, sub: &LogicalPlan, negated: bool) -> Result<LogicalPlan> {
        let (value, input): (Expr, &LogicalPlan) = match sub {
            LogicalPlan::Projection(p) if p.exprs.len() == 1 && !p.exprs[0].contains_outer_ref() => {
                (p.exprs[0].clone().unalias(), p.input.as_ref())
            }
            other => {
                if other.schema().len() != 1 {
                    return Err(WhError::Plan("IN subquery must return exactly one column".into()));
                }
                (Expr::Column(other.schema().column(0)), other)
            }
        };
        let (inner, corr) = pull_up_correlated(input)?;
        if plan_has_outer_ref(&inner) {
            return Err(WhError::NotSupported("correlated IN subquery of this shape".into()));
        }
        let (inner, rewrite) = self.isolate(inner)?;
        let mut filter = vec![outer_to_column(expr)?.eq(rewrite(value)?)];
        for c in corr {
            filter.push(rewrite(c)?);
        }
        let jt = if negated { JoinType::Anti } else { JoinType::Semi };
        LogicalPlan::join(Arc::new(plan), Arc::new(inner), vec![], conjunction(filter), jt)
    }

    fn decorrelate_scalars(&mut self, plan: LogicalPlan, conj: Expr) -> Result<(LogicalPlan, Expr)> {
        let mut plan = plan;
        let mut err = None;
        let out = conj.transform_up(&mut |e| match e {
            Expr::ScalarSubquery(sq) if plan_has_outer_ref(&sq.0) => {
                match self.decorrelate_scalar(plan.clone(), &sq.0) {
                    Ok((p, v)) => {
                        plan = p;
                        Ok(v)
                    }
                    Err(e) => {
                        err = Some(e);
                        Ok(Expr::ScalarSubquery(sq))
                    }
                }
            }
            o => Ok(o),
        })?;
        if let Some(e) = err {
            return Err(e);
        }
        Ok((plan, out))
    }

    fn decorrelate_scalar(&mut self, outer_plan: LogicalPlan, sub: &LogicalPlan) -> Result<(LogicalPlan, Expr)> {
        let unsupported = || WhError::NotSupported("correlated scalar subquery must be an aggregate with equality correlation".into());
        let LogicalPlan::Projection(p) = sub else { return Err(unsupported()) };
        if p.exprs.len() != 1 {
            return Err(unsupported());
        }
        let LogicalPlan::Aggregate(a) = p.input.as_ref() else { return Err(unsupported()) };
        if !a.group_by.is_empty() {
            return Err(unsupported());
        }
        let (agg_input, corr) = pull_up_correlated(&a.input)?;
        if plan_has_outer_ref(&agg_input) {
            return Err(unsupported());
        }
        let mut inner_keys = vec![];
        let mut outer_keys = vec![];
        for c in corr {
            match c {
                Expr::Binary { left, op: Operator::Eq, right } => {
                    let l_outer = left.contains_outer_ref() && left.column_refs().is_empty();
                    let r_outer = right.contains_outer_ref() && right.column_refs().is_empty();
                    if l_outer && !right.contains_outer_ref() {
                        outer_keys.push(outer_to_column(*left)?);
                        inner_keys.push(*right);
                    } else if r_outer && !left.contains_outer_ref() {
                        outer_keys.push(outer_to_column(*right)?);
                        inner_keys.push(*left);
                    } else {
                        return Err(unsupported());
                    }
                }
                _ => return Err(unsupported()),
            }
        }
        let id = self.fresh();
        if let Some(res) = try_window_decorrelate(&outer_plan, &agg_input, &outer_keys, &inner_keys, &a.aggs, &a.schema, &p.exprs[0], id) {
            return Ok(res);
        }
        // magic set (DuckDB's "delim join"): aggregate only the groups the
        // outer query can ask for, i.e. semi-join the subquery input with the
        // distinct correlation keys of the outer relation -- or of the smallest
        // part of it that provides them (a superset of those keys, without
        // recomputing the whole outer join)
        let key_cols: Vec<Column> = outer_keys.iter().flat_map(|k| k.column_refs()).collect();
        let mut sources = vec![];
        key_sources(&crate::optimizer::pushed_down(&outer_plan), &key_cols, &mut sources);
        // the smallest source, or a much cheaper one to compute (fewer rows
        // scanned) that is selective itself and not much larger: a whole
        // join just to narrow the keys can cost more than the subquery it saves
        let sources: Vec<(LogicalPlan, f64, f64)> = sources
            .into_iter()
            .map(|p| {
                let e = crate::physical::planner::estimate_rows(&p);
                let cost = scanned_rows(&p);
                (p, e, cost)
            })
            .collect();
        let smallest = sources.iter().map(|s| (s.1, s.2)).reduce(|a, b| if b.0 <= a.0 { b } else { a }).expect("the outer plan itself");
        let cheap = sources
            .iter()
            .filter(|s| s.1 <= smallest.0 * 10.0 && s.1 <= s.2 * 0.1 && s.2 * 2.0 <= smallest.1)
            .map(|s| s.2)
            .fold(f64::INFINITY, f64::min);
        let (source, source_est, _) = sources
            .into_iter()
            .find(|s| if cheap.is_finite() { s.2 == cheap && s.1 <= smallest.0 * 10.0 && s.1 <= s.2 * 0.1 } else { s.1 == smallest.0 })
            .expect("a chosen source");
        let inner_est = crate::optimizer::estimate_after_pushdown(&agg_input);
        let agg_input = if source_est * 4.0 < inner_est {
            let keys_proj = LogicalPlan::project(
                Arc::new(source),
                outer_keys.iter().enumerate().map(|(i, k)| k.clone().alias(format!("__sq{id}_dk{i}"))).collect(),
            )?;
            let delim = distinct(keys_proj)?;
            let on = inner_keys
                .iter()
                .enumerate()
                .map(|(i, k)| (k.clone(), Expr::Column(Column::from_name(format!("__sq{id}_dk{i}")))))
                .collect();
            LogicalPlan::join(Arc::new(agg_input), Arc::new(delim), on, None, JoinType::Semi)?
        } else {
            agg_input
        };
        let group_by: Vec<Expr> = inner_keys.iter().enumerate().map(|(i, k)| k.clone().alias(format!("__sq{id}_k{i}"))).collect();
        let new_agg = LogicalPlan::aggregate(Arc::new(agg_input), group_by, a.aggs.clone())?;
        let mut exprs: Vec<Expr> = (0..inner_keys.len()).map(|i| Expr::Column(Column::from_name(format!("__sq{id}_k{i}")))).collect();
        let value_name = format!("__sq{id}_v");
        exprs.push(p.exprs[0].clone().unalias().alias(value_name.clone()));
        let proj = LogicalPlan::project(Arc::new(new_agg), exprs)?;
        let on = outer_keys
            .into_iter()
            .enumerate()
            .map(|(i, o)| (o, Expr::Column(Column::from_name(format!("__sq{id}_k{i}")))))
            .collect();
        let joined = LogicalPlan::join(Arc::new(outer_plan), Arc::new(proj), on, None, JoinType::Left)?;
        Ok((joined, Expr::Column(Column::from_name(value_name))))
    }

    // -----------------------------------------------------------------------
    // expressions
    // -----------------------------------------------------------------------

    fn resolve(&mut self, relation: Option<String>, name: String, scope: Scope<'_>) -> Result<Expr> {
        match self.try_resolve(relation.clone(), name.clone(), scope)? {
            Some(e) => Ok(e),
            // produce the regular error message
            None => scope.schema.index_of(&Column::new(relation, name)).map(|_| unreachable!()),
        }
    }

    /// The column, select alias or outer column a name refers to, if any.
    fn try_resolve(&mut self, relation: Option<String>, name: String, scope: Scope<'_>) -> Result<Option<Expr>> {
        let c = Column::new(relation.clone(), name.clone());
        if let Some(i) = scope.schema.maybe_index_of(&c)? {
            return Ok(Some(Expr::Column(scope.schema.column(i))));
        }
        if relation.is_none() {
            if let Some(aliases) = scope.aliases {
                if let Some((_, e)) = aliases.iter().find(|(n, _)| n.eq_ignore_ascii_case(&name)) {
                    return Ok(Some(e.clone()));
                }
            }
        }
        if let Some(outer) = scope.outer {
            if let Some(i) = outer.maybe_index_of(&c)? {
                return Ok(Some(Expr::OuterRef(outer.column(i), outer.field(i).data_type().clone())));
            }
        }
        Ok(None)
    }

    fn subquery(&mut self, q: &sql::Query, scope: Scope<'_>) -> Result<Subquery> {
        Ok(Subquery(Arc::new(self.plan_query(q, Some(scope.schema))?)))
    }

    fn sql_expr(&mut self, e: &sql::Expr, scope: Scope<'_>) -> Result<Expr> {
        use sql::Expr as E;
        let b = |x: Expr| Box::new(x);
        Ok(match e {
            E::Identifier(id) => self.resolve(None, ident(id), scope)?,
            E::CompoundIdentifier(ids) => {
                if ids.len() < 2 {
                    return Err(WhError::Sql(format!("invalid identifier {e}")));
                }
                self.resolve_compound(ids, scope)?
            }
            E::Value(v) => Expr::Literal(self.literal(&v.value)?),
            E::TypedString(ts) => {
                let s = ts.value.value.clone().into_string().unwrap_or_default();
                let t = ts.data_type.to_string().to_ascii_lowercase();
                if t.starts_with("date") {
                    Expr::Literal(parse_date(&s)?)
                } else if t.starts_with("timestamp") || t.starts_with("datetime") {
                    Expr::Literal(parse_timestamp(&s)?)
                } else {
                    Expr::Literal(Scalar::utf8(&s).cast_to(&parse_data_type(&t)?)?)
                }
            }
            E::Interval(iv) => {
                let raw = match iv.value.as_ref() {
                    E::Value(v) => match &v.value {
                        sql::Value::Number(n, _) => n.clone(),
                        sql::Value::Placeholder(p) => self.params.lookup(p)?.to_string(),
                        other => other.clone().into_string().unwrap_or_default(),
                    },
                    other => return Err(WhError::NotSupported(format!("interval value {other}"))),
                };
                let raw = raw.trim().to_string();
                match &iv.leading_field {
                    Some(f) => {
                        let n: f64 = raw.parse().map_err(|_| WhError::Sql(format!("invalid interval '{raw}'")))?;
                        Expr::Literal(interval_from(n, &f.to_string())?)
                    }
                    None => {
                        let mut parts = raw.split_whitespace();
                        let n: f64 = parts
                            .next()
                            .and_then(|x| x.parse().ok())
                            .ok_or_else(|| WhError::Sql(format!("invalid interval '{raw}'")))?;
                        let unit = parts.next().unwrap_or("day");
                        Expr::Literal(interval_from(n, unit)?)
                    }
                }
            }
            E::BinaryOp { left, op: sql::BinaryOperator::Spaceship, right } => {
                null_safe_eq(self.sql_expr(left, scope)?, self.sql_expr(right, scope)?)
            }
            E::IsNotDistinctFrom(l, r) => null_safe_eq(self.sql_expr(l, scope)?, self.sql_expr(r, scope)?),
            E::IsDistinctFrom(l, r) => null_safe_eq(self.sql_expr(l, scope)?, self.sql_expr(r, scope)?).not(),
            E::RLike { negated, expr, pattern, .. } => {
                let m = Expr::Function {
                    func: ScalarFunc::RegexpLike,
                    args: vec![self.sql_expr(expr, scope)?, self.sql_expr(pattern, scope)?],
                };
                if *negated { m.not() } else { m }
            }
            E::BinaryOp { left, op: op @ (sql::BinaryOperator::Arrow | sql::BinaryOperator::LongArrow), right } => {
                let (l, r) = (self.sql_expr(left, scope)?, self.sql_expr(right, scope)?);
                json::arrow(op, l, r)
            }
            // `col -> 'path'`: with a column on the left the parser reads a lambda
            E::Lambda(l) if json::is_arrow_lambda(l) => self.json_arrows(l, scope)?,
            E::BinaryOp { left, op, right } => {
                let op = map_binop(op)?;
                let l = self.sql_expr(left, scope)?;
                let r = self.sql_expr(right, scope)?;
                binary(l, op, r)
            }
            E::UnaryOp { op, expr } => {
                let x = self.sql_expr(expr, scope)?;
                match op {
                    sql::UnaryOperator::Not => x.not(),
                    sql::UnaryOperator::Minus => match x {
                        Expr::Literal(s) => match evaluate_constant(&Expr::Negative(Box::new(Expr::Literal(s.clone()))))? {
                            Some(v) => Expr::Literal(v),
                            None => Expr::Negative(b(Expr::Literal(s))),
                        },
                        x => Expr::Negative(b(x)),
                    },
                    sql::UnaryOperator::Plus => x,
                    other => return Err(WhError::NotSupported(format!("unary operator {other}"))),
                }
            }
            E::Nested(x) => self.sql_expr(x, scope)?,
            E::IsNull(x) => self.sql_expr(x, scope)?.is_null(),
            E::IsNotNull(x) => self.sql_expr(x, scope)?.is_not_null(),
            E::IsTrue(x) => self.sql_expr(x, scope)?.eq(Expr::Literal(Scalar::boolean(true))),
            E::IsFalse(x) => self.sql_expr(x, scope)?.eq(Expr::Literal(Scalar::boolean(false))),
            E::IsNotTrue(x) => self.sql_expr(x, scope)?.eq(Expr::Literal(Scalar::boolean(true))).not(),
            E::IsNotFalse(x) => self.sql_expr(x, scope)?.eq(Expr::Literal(Scalar::boolean(false))).not(),
            E::InList { expr, list, negated } => Expr::InList {
                expr: b(self.sql_expr(expr, scope)?),
                list: list.iter().map(|x| self.sql_expr(x, scope)).collect::<Result<_>>()?,
                negated: *negated,
            },
            E::InSubquery { expr, subquery, negated } => Expr::InSubquery {
                expr: b(self.sql_expr(expr, scope)?),
                subquery: self.subquery(subquery, scope)?,
                negated: *negated,
            },
            E::Exists { subquery, negated } => Expr::Exists { subquery: self.subquery(subquery, scope)?, negated: *negated },
            E::Subquery(q) => Expr::ScalarSubquery(self.subquery(q, scope)?),
            E::Between { expr, negated, low, high } => {
                let x = self.sql_expr(expr, scope)?;
                let lo = self.sql_expr(low, scope)?;
                let hi = self.sql_expr(high, scope)?;
                if *negated {
                    x.clone().lt(lo).or(x.gt(hi))
                } else {
                    x.between(lo, hi)
                }
            }
            E::Like { negated, expr, pattern, any, .. } | E::ILike { negated, expr, pattern, any, .. } => {
                if *any {
                    return Err(WhError::NotSupported("LIKE ANY".into()));
                }
                Expr::Like {
                    expr: b(self.sql_expr(expr, scope)?),
                    pattern: b(self.sql_expr(pattern, scope)?),
                    negated: *negated,
                    case_insensitive: matches!(e, E::ILike { .. }),
                }
            }
            E::Cast { kind, expr, data_type, .. } => {
                let to = parse_data_type(&data_type.to_string())?;
                let x = self.sql_expr(expr, scope)?;
                Expr::Cast { expr: b(x), to, try_cast: matches!(kind, sql::CastKind::TryCast | sql::CastKind::SafeCast) }
            }
            E::Extract { field, expr, .. } => {
                let fname = field.to_string().to_ascii_lowercase();
                let func = ScalarFunc::from_name(&fname)
                    .or_else(|| ScalarFunc::from_name(fname.trim_end_matches('s')))
                    .ok_or_else(|| WhError::NotSupported(format!("EXTRACT({fname})")))?;
                Expr::Function { func, args: vec![self.sql_expr(expr, scope)?] }
            }
            E::Substring { expr, substring_from, substring_for, .. } => {
                let mut args = vec![self.sql_expr(expr, scope)?];
                args.push(match substring_from {
                    Some(f) => self.sql_expr(f, scope)?,
                    None => Expr::Literal(Scalar::int64(1)),
                });
                if let Some(f) = substring_for {
                    args.push(self.sql_expr(f, scope)?);
                }
                Expr::Function { func: ScalarFunc::Substring, args }
            }
            E::Trim { expr, trim_where, .. } => {
                let func = match trim_where {
                    Some(sql::TrimWhereField::Leading) => ScalarFunc::LTrim,
                    Some(sql::TrimWhereField::Trailing) => ScalarFunc::RTrim,
                    _ => ScalarFunc::Trim,
                };
                Expr::Function { func, args: vec![self.sql_expr(expr, scope)?] }
            }
            E::Position { expr, r#in } => Expr::Function {
                func: ScalarFunc::StrPos,
                args: vec![self.sql_expr(r#in, scope)?, self.sql_expr(expr, scope)?],
            },
            E::Ceil { expr, .. } => Expr::Function { func: ScalarFunc::Ceil, args: vec![self.sql_expr(expr, scope)?] },
            E::Floor { expr, .. } => Expr::Function { func: ScalarFunc::Floor, args: vec![self.sql_expr(expr, scope)?] },
            E::Case { operand, conditions, else_result, .. } => {
                let op = match operand {
                    Some(o) => Some(self.sql_expr(o, scope)?),
                    None => None,
                };
                let mut when_then = vec![];
                for cw in conditions {
                    let c = self.sql_expr(&cw.condition, scope)?;
                    let c = match &op {
                        Some(o) => o.clone().eq(c),
                        None => c,
                    };
                    when_then.push((c, self.sql_expr(&cw.result, scope)?));
                }
                let otherwise = match else_result {
                    Some(x) => Some(b(self.sql_expr(x, scope)?)),
                    None => None,
                };
                Expr::Case { when_then, otherwise }
            }
            E::Function(f) => self.sql_function(f, scope)?,
            E::Array(arr) => self.sql_array(arr, scope)?,
            E::Dictionary(fields) => self.sql_dictionary(fields, scope)?,
            E::CompoundFieldAccess { root, access_chain } => self.sql_subscripts(root, access_chain, scope)?,
            other => return Err(WhError::NotSupported(format!("SQL expression: {other}"))),
        })
    }

    fn literal(&self, v: &sql::Value) -> Result<Scalar> {
        Ok(match v {
            sql::Value::Number(n, _) => parse_number(n)?,
            sql::Value::Boolean(x) => Scalar::boolean(*x),
            sql::Value::Null => Scalar::null(),
            sql::Value::Placeholder(p) => self.params.lookup(p)?,
            other => match other.clone().into_string() {
                Some(s) => Scalar::utf8(&s),
                None => return Err(WhError::NotSupported(format!("literal {other}"))),
            },
        })
    }

    /// `percentile_cont(p) WITHIN GROUP (ORDER BY x [DESC])` becomes the
    /// two-argument aggregate `quantile_cont(x, p)`.
    fn ordered_set_agg(
        &mut self,
        f: &sql::Function,
        func: AggFunc,
        name: &str,
        args: Vec<Expr>,
        filter: Option<Box<Expr>>,
        scope: Scope<'_>,
    ) -> Result<Expr> {
        if !matches!(func, AggFunc::QuantileCont | AggFunc::QuantileDisc) || f.within_group.len() != 1 || args.len() != 1 {
            return Err(WhError::NotSupported(format!("{name}(..) WITHIN GROUP")));
        }
        let order = &f.within_group[0];
        let x = self.sql_expr(&order.expr, scope)?;
        let desc = matches!(order.options.sort, Some(sql::OrderBySort::Desc));
        let p = match (desc, func, &args[0]) {
            (false, _, p) => p.clone(),
            // the descending quantile of a continuous distribution is 1 - p
            (true, AggFunc::QuantileCont, p) => Expr::Binary {
                left: Box::new(Expr::Literal(Scalar::float64(1.0))),
                op: Operator::Minus,
                right: Box::new(p.clone()),
            },
            (true, _, _) => return Err(WhError::NotSupported(format!("{name}(..) WITHIN GROUP (ORDER BY .. DESC)"))),
        };
        Ok(Expr::Agg { func, args: vec![x, p], distinct: false, filter, order_by: vec![] })
    }

    fn sql_function(&mut self, f: &sql::Function, scope: Scope<'_>) -> Result<Expr> {
        let name = object_name_parts(&f.name).last().cloned().unwrap_or_default().to_ascii_lowercase();
        let (raw_args, distinct) = match &f.args {
            sql::FunctionArguments::None => (vec![], false),
            sql::FunctionArguments::List(l) => (
                l.args.clone(),
                matches!(l.duplicate_treatment, Some(sql::DuplicateTreatment::Distinct)),
            ),
            sql::FunctionArguments::Subquery(_) => return Err(WhError::NotSupported("subquery as function argument".into())),
        };
        let star = raw_args.len() == 1
            && matches!(&raw_args[0], sql::FunctionArg::Unnamed(sql::FunctionArgExpr::Wildcard));
        let mut args = vec![];
        let mut arg_names = vec![];
        if !star {
            for a in &raw_args {
                let (arg_name, x) = structs::split_argument(a)
                    .ok_or_else(|| WhError::NotSupported(format!("function argument {a}")))?;
                args.push(self.sql_expr(&x, scope)?);
                arg_names.push(arg_name);
            }
        }
        if f.over.is_none() {
            if let Some(e) = Self::struct_call(&name, args.clone(), arg_names)? {
                return Ok(e);
            }
        }
        let filter = match &f.filter {
            Some(x) => Some(Box::new(self.sql_expr(x, scope)?)),
            None => None,
        };
        if let Some(over) = &f.over {
            return self.window_function(f, over, &name, args, distinct, filter.map(|f| *f), scope);
        }
        if name == "count" && (star || args.is_empty()) {
            return Ok(Expr::Agg { func: AggFunc::Count, args: vec![], distinct: false, filter, order_by: vec![] });
        }
        if matches!(name.as_str(), "count_distinct" | "approx_count_distinct" | "n_unique") {
            return Ok(Expr::Agg { func: AggFunc::Count, args, distinct: true, filter, order_by: vec![] });
        }
        if let Some(func) = AggFunc::from_name(&name) {
            if !f.within_group.is_empty() {
                return self.ordered_set_agg(f, func, &name, args, filter, scope);
            }
            if args.len() != func.arity() {
                return Err(WhError::Sql(format!("{name}() expects {} argument(s)", func.arity())));
            }
            let order_by = self.agg_order_by(f, scope)?;
            if !order_by.is_empty() && !matches!(func, AggFunc::ArrayAgg | AggFunc::CollectList | AggFunc::CollectSet) {
                return Err(WhError::NotSupported(format!("ORDER BY inside {name}(..); only array_agg / list / collect_list")));
            }
            return Ok(Expr::Agg { func, args, distinct, filter, order_by });
        }
        if let Some(e) = Self::list_aggr(&name, &args)? {
            return Ok(e);
        }
        match name.as_str() {
            "date_part" | "datepart" | "extract" => {
                let part = match args.first() {
                    Some(Expr::Literal(s)) => s.as_str().map(|x| x.to_ascii_lowercase()),
                    _ => None,
                }
                .ok_or_else(|| WhError::Sql("date_part expects a constant part name".into()))?;
                let func = ScalarFunc::from_name(&part)
                    .ok_or_else(|| WhError::NotSupported(format!("date_part('{part}')")))?;
                return Ok(Expr::Function { func, args: args[1..].to_vec() });
            }
            "if" | "iff" | "iif" => {
                if args.len() != 3 {
                    return Err(WhError::Sql("if() expects 3 arguments".into()));
                }
                let mut it = args.into_iter();
                let (c, t, o) = (it.next().unwrap(), it.next().unwrap(), it.next().unwrap());
                return Ok(Expr::Case { when_then: vec![(c, t)], otherwise: Some(Box::new(o)) });
            }
            "date" | "to_date" if args.len() <= 1 => return Ok(args.into_iter().next().unwrap_or(Expr::Literal(Scalar::null())).cast(DataType::Date32)),
            _ => {}
        }
        match ScalarFunc::from_name(&name) {
            Some(func) => Ok(Expr::Function { func, args }),
            None => Err(WhError::NotSupported(format!("function '{name}'"))),
        }
    }
}

/// Window functions are computed after WHERE, GROUP BY and HAVING.
fn no_windows(e: Expr, clause: &str) -> Result<Expr> {
    if e.contains_window() {
        let hint = if clause == "GROUP BY" { "" } else { " (filter on window results with QUALIFY)" };
        return Err(WhError::Plan(format!("window functions are not allowed in {clause}{hint}")));
    }
    Ok(e)
}

/// Occurrences of the identifier `word` (case-insensitive) in SQL text.
fn count_words(text: &str, word: &str) -> usize {
    let dialect = sqlparser::dialect::DuckDbDialect {};
    sqlparser::tokenizer::Tokenizer::new(&dialect, text)
        .tokenize()
        .map(|tokens| {
            tokens
                .iter()
                .filter(|t| matches!(t, sqlparser::tokenizer::Token::Word(w) if w.value.eq_ignore_ascii_case(word)))
                .count()
        })
        .unwrap_or(0)
}

fn sort_opts(o: &sql::OrderByExpr) -> (bool, bool) {
    let desc = matches!(o.options.sort, Some(sql::OrderBySort::Desc));
    let nulls_first = o.options.nulls_first.unwrap_or(false);
    (desc, nulls_first)
}

fn distinct(plan: LogicalPlan) -> Result<LogicalPlan> {
    let cols: Vec<Expr> = (0..plan.schema().len()).map(|i| Expr::Column(plan.schema().column(i))).collect();
    LogicalPlan::aggregate(Arc::new(plan), cols, vec![])
}

/// `plan` and its sub-plans that provide all of `cols` with a superset of
/// the plan's distinct values for them (through filters and joins).
/// Rows the scans of a plan read (before their filters).
fn scanned_rows(plan: &LogicalPlan) -> f64 {
    match plan {
        LogicalPlan::Scan(s) => s.source.num_rows().unwrap_or(1_000_000) as f64,
        p => p.inputs().iter().map(|i| scanned_rows(i)).sum(),
    }
}

fn key_sources(plan: &LogicalPlan, cols: &[Column], out: &mut Vec<LogicalPlan>) {
    out.push(plan.clone());
    match plan {
        LogicalPlan::Filter(f) => key_sources(&f.input, cols, out),
        LogicalPlan::Join(j) => {
            let sides: &[&Arc<LogicalPlan>] = match j.join_type {
                JoinType::Semi | JoinType::Anti => &[&j.left],
                _ => &[&j.left, &j.right],
            };
            for side in sides {
                if cols.iter().all(|c| side.schema().has_column(c)) {
                    key_sources(side, cols, out);
                }
            }
        }
        _ => {}
    }
}

struct LeafScan {
    table_name: String,
    qualifier: Option<String>,
    schema: PlanSchema,
    preds: Vec<Expr>,
}

fn unqualify_expr(e: &Expr) -> Expr {
    e.clone()
        .transform_up(&mut |x| match x {
            Expr::Column(c) => Ok(Expr::Column(Column::from_name(c.name))),
            other => Ok(other),
        })
        .unwrap_or_else(|_| e.clone())
}

fn decompose_equi_tree(plan: &LogicalPlan, leaves: &mut Vec<LeafScan>, joins: &mut Vec<(Column, Column)>) -> bool {
    match plan {
        LogicalPlan::Scan(s) if s.fetch.is_none() => {
            leaves.push(LeafScan {
                table_name: s.table_name.clone(),
                qualifier: s.qualifier.clone(),
                schema: s.schema.as_ref().clone(),
                preds: vec![],
            });
            true
        }
        LogicalPlan::Filter(f) => {
            let LogicalPlan::Scan(s) = f.input.as_ref() else { return false };
            if s.fetch.is_none() {
                let preds = split_conjunction(&f.predicate).into_iter().map(|c| unqualify_expr(&c)).collect();
                leaves.push(LeafScan {
                    table_name: s.table_name.clone(),
                    qualifier: s.qualifier.clone(),
                    schema: s.schema.as_ref().clone(),
                    preds,
                });
                true
            } else {
                false
            }
        }
        LogicalPlan::Join(j) if j.join_type == JoinType::Inner && j.filter.is_none() => {
            for (l, r) in &j.on {
                let (Some(lc), Some(rc)) = (l.as_column(), r.as_column()) else { return false };
                joins.push((lc.clone(), rc.clone()));
            }
            decompose_equi_tree(&j.left, leaves, joins) && decompose_equi_tree(&j.right, leaves, joins)
        }
        _ => false,
    }
}

/// When the outer query is the subquery's input inner-joined with an extra
/// relation solely on the correlation keys, and every aggregate is invariant
/// to uniform partition multiplicity (`MIN`, `MAX`, `AVG`, `BOOL_AND`,
/// `BOOL_OR`), evaluate the aggregates as a window over `outer_plan` instead
/// of scanning and joining the subquery tables a second time.
#[allow(clippy::too_many_arguments)]
fn try_window_decorrelate(
    outer_plan: &LogicalPlan,
    agg_input: &LogicalPlan,
    outer_keys: &[Expr],
    inner_keys: &[Expr],
    aggs: &[Expr],
    agg_schema: &PlanSchema,
    proj_expr: &Expr,
    id: usize,
) -> Option<(LogicalPlan, Expr)> {
    let outer_cols: Vec<Column> = outer_keys.iter().map(|e| e.as_column().cloned()).collect::<Option<_>>()?;
    let inner_cols: Vec<Column> = inner_keys.iter().map(|e| e.as_column().cloned()).collect::<Option<_>>()?;
    if outer_cols.is_empty() || outer_cols.len() != inner_cols.len() {
        return None;
    }
    for ae in aggs {
        let Expr::Agg { func, distinct, filter: None, order_by, .. } = ae.unalias_ref() else {
            return None;
        };
        if !order_by.is_empty() {
            return None;
        }
        match func {
            AggFunc::Min | AggFunc::Max | AggFunc::BoolAnd | AggFunc::BoolOr => {}
            AggFunc::Mean if !distinct => {}
            _ => return None,
        }
    }
    let outer_pushed = crate::optimizer::pushed_down(outer_plan);
    let inner_pushed = crate::optimizer::pushed_down(agg_input);
    let (mut outer_leaves, mut outer_joins) = (vec![], vec![]);
    let (mut inner_leaves, mut inner_joins) = (vec![], vec![]);
    if !decompose_equi_tree(&outer_pushed, &mut outer_leaves, &mut outer_joins)
        || !decompose_equi_tree(&inner_pushed, &mut inner_leaves, &mut inner_joins)
    {
        return None;
    }
    if outer_leaves.len() <= inner_leaves.len() {
        return None;
    }
    if (0..outer_leaves.len()).any(|i| outer_leaves[..i].iter().any(|l| l.table_name == outer_leaves[i].table_name))
        || (0..inner_leaves.len()).any(|i| inner_leaves[..i].iter().any(|l| l.table_name == inner_leaves[i].table_name))
    {
        return None;
    }
    for il in &inner_leaves {
        let ol = outer_leaves.iter().find(|o| o.table_name == il.table_name)?;
        if il.preds.len() != ol.preds.len()
            || !il.preds.iter().all(|p| ol.preds.contains(p))
            || !ol.preds.iter().all(|p| il.preds.contains(p))
        {
            return None;
        }
    }
    let resolve_leaf = |leaves: &[LeafScan], col: &Column| -> Option<(String, String)> {
        let mut matches = leaves.iter().filter(|l| l.schema.has_column(col));
        let first = matches.next()?;
        if matches.next().is_some() {
            return None;
        }
        Some((first.table_name.clone(), col.name.clone()))
    };
    let in_shared = |t: &str| inner_leaves.iter().any(|il| il.table_name == t);
    let mut corr_pairs = Vec::with_capacity(outer_cols.len());
    for (oc, ic) in outer_cols.iter().zip(&inner_cols) {
        let o_ref = resolve_leaf(&outer_leaves, oc)?;
        let i_ref = resolve_leaf(&inner_leaves, ic)?;
        if in_shared(&o_ref.0) || !in_shared(&i_ref.0) {
            return None;
        }
        let pair = if o_ref <= i_ref { (o_ref, i_ref) } else { (i_ref, o_ref) };
        corr_pairs.push(pair);
    }
    let canon_joins = |leaves: &[LeafScan], joins: &[(Column, Column)]| -> Option<Vec<((String, String), (String, String))>> {
        let mut out = Vec::with_capacity(joins.len());
        for (l, r) in joins {
            let a = resolve_leaf(leaves, l)?;
            let b = resolve_leaf(leaves, r)?;
            out.push(if a <= b { (a, b) } else { (b, a) });
        }
        Some(out)
    };
    let inner_pairs = canon_joins(&inner_leaves, &inner_joins)?;
    let outer_pairs = canon_joins(&outer_leaves, &outer_joins)?;
    if !inner_pairs.iter().all(|p| outer_pairs.contains(p)) || !corr_pairs.iter().all(|p| outer_pairs.contains(p)) {
        return None;
    }
    for (a, b) in &outer_pairs {
        match (in_shared(&a.0), in_shared(&b.0)) {
            (true, true) if !inner_pairs.contains(&(a.clone(), b.clone())) => return None,
            (true, false) | (false, true) if !corr_pairs.contains(&(a.clone(), b.clone())) => return None,
            _ => {}
        }
    }
    let map_col = |e: &Expr| -> Option<Expr> {
        let mut ok = true;
        let mapped = e
            .clone()
            .transform_up(&mut |x| match x {
                Expr::Column(c) => {
                    let Some((tname, cname)) = resolve_leaf(&inner_leaves, &c) else {
                        ok = false;
                        return Ok(Expr::Column(c));
                    };
                    let Some(ol) = outer_leaves.iter().find(|o| o.table_name == tname) else {
                        ok = false;
                        return Ok(Expr::Column(c));
                    };
                    Ok(Expr::Column(Column::new(ol.qualifier.clone(), cname)))
                }
                other => Ok(other),
            })
            .ok()?;
        ok.then_some(mapped)
    };
    let mut win_exprs = Vec::with_capacity(aggs.len());
    for (i, ae) in aggs.iter().enumerate() {
        let Expr::Agg { func, args, distinct, .. } = ae.unalias_ref() else { return None };
        let mapped_args: Vec<Expr> = args.iter().map(map_col).collect::<Option<_>>()?;
        let mut we = crate::window::WindowExpr::new(
            crate::window::WindowFunc::Agg(*func),
            mapped_args,
            outer_keys.to_vec(),
            vec![],
        );
        we.distinct = *distinct;
        win_exprs.push(Expr::Window(Box::new(we)).alias(format!("__sq{id}_w{i}")));
    }
    let win_plan = LogicalPlan::window(Arc::new(outer_plan.clone()), win_exprs).ok()?;
    let mut ok = true;
    let val_expr = proj_expr
        .clone()
        .unalias()
        .transform_up(&mut |x| match x {
            Expr::Column(c) => match agg_schema.maybe_index_of(&c) {
                Ok(Some(i)) => Ok(Expr::Column(Column::from_name(format!("__sq{id}_w{i}")))),
                _ => {
                    ok = false;
                    Ok(Expr::Column(c))
                }
            },
            other => Ok(other),
        })
        .ok()?;
    ok.then_some((win_plan, val_expr))
}

/// `JOIN ... USING (k)` / `NATURAL JOIN`: the key appears once, unqualified
/// and first (the left value, the right one for right joins, either for full
/// joins), followed by the other columns of both sides.
fn merge_using_columns(plan: LogicalPlan, names: &[String], keys: &[(Expr, Expr)], jt: JoinType) -> Result<LogicalPlan> {
    let mut exprs = vec![];
    let mut key_cols = vec![];
    for (name, (l, r)) in names.iter().zip(keys) {
        let value = match jt {
            JoinType::Right => r.clone(),
            JoinType::Full => Expr::Function { func: crate::expr::ScalarFunc::Coalesce, args: vec![l.clone(), r.clone()] },
            _ => l.clone(),
        };
        exprs.push(value.alias(name.clone()));
        for side in [l, r] {
            if let Expr::Column(c) = side {
                key_cols.push(c.clone());
            }
        }
    }
    for f in plan.schema().fields() {
        let c = f.column();
        if !key_cols.contains(&c) {
            exprs.push(Expr::Column(c));
        }
    }
    LogicalPlan::project(Arc::new(plan), exprs)
}
