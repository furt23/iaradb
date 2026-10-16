//! SQL for lists: `[..]` literals, `l[i]` / `l[a:b]`, `ORDER BY` inside
//! `array_agg`, `list_aggr(l, 'sum')`, and `unnest`.

use std::sync::Arc;

use sqlparser::ast as sql;

use super::{Scope, SqlPlanner, ident, sort_opts};
use crate::error::{Result, WhError};
use crate::expr::{Expr, ScalarFunc, SortExpr};
use crate::logical::LogicalPlan;
use crate::physical::functions::lists::names::agg_by_name;
use crate::scalar::Scalar;
use crate::schema::{Column, PlanSchema};

fn int(v: i64) -> Expr {
    Expr::Literal(Scalar::int64(v))
}

impl<'a> SqlPlanner<'a> {
    /// `[a, b]` and `ARRAY[a, b]`.
    pub(super) fn sql_array(&mut self, arr: &sql::Array, scope: Scope<'_>) -> Result<Expr> {
        let args = arr.elem.iter().map(|x| self.sql_expr(x, scope)).collect::<Result<Vec<_>>>()?;
        Ok(Expr::Function { func: ScalarFunc::ListValue, args })
    }

    /// `root[i]`, `root[a:b]`, `root[:b]`, chained.
    pub(super) fn sql_subscripts(&mut self, root: &sql::Expr, chain: &[sql::AccessExpr], scope: Scope<'_>) -> Result<Expr> {
        let (mut e, chain) = self.subscript_root(root, chain, scope)?;
        for access in chain {
            if let Some(field) = super::structs::access_field(access) {
                if matches!(access, sql::AccessExpr::Dot(_)) || Self::is_struct_expr(&e, scope) {
                    e = self.field_of(e, &field, scope)?;
                    continue;
                }
            }
            let sql::AccessExpr::Subscript(s) = access else {
                return Err(WhError::NotSupported(format!("field access {access}")));
            };
            e = match s {
                sql::Subscript::Index { index } => {
                    Expr::Function { func: ScalarFunc::ListExtract, args: vec![e, self.sql_expr(index, scope)?] }
                }
                sql::Subscript::Slice { lower_bound, upper_bound, stride } => {
                    if stride.is_some() {
                        return Err(WhError::NotSupported("list slices with a stride".into()));
                    }
                    let lo = match lower_bound {
                        Some(x) => self.sql_expr(x, scope)?,
                        None => int(1),
                    };
                    let hi = match upper_bound {
                        Some(x) => self.sql_expr(x, scope)?,
                        None => int(i64::MAX),
                    };
                    Expr::Function { func: ScalarFunc::ListSlice, args: vec![e, lo, hi] }
                }
            };
        }
        Ok(e)
    }

    /// The `ORDER BY` inside an aggregate call: `array_agg(x ORDER BY y DESC)`.
    pub(super) fn agg_order_by(&mut self, f: &sql::Function, scope: Scope<'_>) -> Result<Vec<SortExpr>> {
        let sql::FunctionArguments::List(l) = &f.args else { return Ok(vec![]) };
        let mut out = vec![];
        for clause in &l.clauses {
            if let sql::FunctionArgumentClause::OrderBy(keys) = clause {
                for k in keys {
                    let (desc, nulls_first) = sort_opts(k);
                    out.push(SortExpr::new(self.sql_expr(&k.expr, scope)?, desc, nulls_first));
                }
            }
        }
        Ok(out)
    }

    /// `list_aggr(l, 'sum')` and its aliases: the aggregate named by a constant.
    pub(super) fn list_aggr(name: &str, args: &[Expr]) -> Result<Option<Expr>> {
        if !matches!(name, "list_aggr" | "list_aggregate" | "array_aggr" | "array_aggregate") {
            return Ok(None);
        }
        let agg = match args {
            [_, Expr::Literal(s)] if s.as_str().is_some() => agg_by_name(s.as_str().unwrap_or_default())?,
            _ => return Err(WhError::Sql(format!("{name}(list, 'aggregate') expects the aggregate name as a constant"))),
        };
        Ok(Some(Expr::Function { func: ScalarFunc::ListAgg(agg), args: vec![args[0].clone()] }))
    }

    // -----------------------------------------------------------------------
    // UNNEST
    // -----------------------------------------------------------------------

    /// `unnest(..)` calls in the select list become columns of an Unnest node
    /// below the projection; several of them are zipped (DuckDB).
    pub(super) fn unnest_select(&mut self, plan: LogicalPlan, select: Vec<Expr>) -> Result<(LogicalPlan, Vec<Expr>)> {
        let mut args: Vec<Expr> = vec![];
        let mut names: Vec<String> = vec![];
        let n_in = plan.schema().len();
        let rewritten = select
            .into_iter()
            .map(|e| {
                let name = e.output_name();
                let aliased = matches!(e, Expr::Alias(..));
                let r = e.transform_down(&mut |x| match x {
                    Expr::Function { func: ScalarFunc::Unnest, args: a } => {
                        if a.len() != 1 {
                            return Err(WhError::Sql("unnest() takes one argument".into()));
                        }
                        let col = format!("__unnest{}", args.len());
                        args.push(a[0].clone());
                        names.push(col.clone());
                        Ok((Expr::Column(Column::from_name(col)), false))
                    }
                    o => Ok((o, true)),
                })?;
                Ok(if !aliased && r.output_name() != name { r.alias(name) } else { r })
            })
            .collect::<Result<Vec<_>>>()?;
        if args.iter().any(|a| a.contains_agg()) {
            return Err(WhError::NotSupported("unnest of an aggregate; compute it in a subquery".into()));
        }
        let plan = LogicalPlan::unnest(Arc::new(plan), args, names.iter().map(|n| (None, n.clone())).collect(), false)?;
        debug_assert!(plan.schema().len() >= n_in);
        Ok((plan, rewritten))
    }

    /// `FROM t, unnest(t.l) AS u(x)` / `JOIN unnest(..)`: the table function
    /// reads the columns of the relation before it.
    pub(super) fn lateral_unnest(&mut self, prior: Option<LogicalPlan>, call: &UnnestCall, outer: Option<&PlanSchema>) -> Result<LogicalPlan> {
        let base = match prior {
            Some(p) => p,
            None => LogicalPlan::one_row()?,
        };
        let schema = base.schema().clone();
        let scope = Scope::new(&schema, outer);
        let args = call.args.iter().map(|x| self.sql_expr(x, scope)).collect::<Result<Vec<_>>>()?;
        let qualifier = call.alias.clone();
        let outputs: Vec<(Option<String>, String)> = (0..args.len())
            .map(|i| (qualifier.clone(), call.columns.get(i).cloned().unwrap_or_else(|| "unnest".to_string())))
            .collect();
        LogicalPlan::unnest(Arc::new(base), args, outputs, false)
    }
}

/// A table function call `unnest(a, b) AS alias(c1, c2)`.
pub(super) struct UnnestCall {
    pub args: Vec<sql::Expr>,
    pub alias: Option<String>,
    pub columns: Vec<String>,
}

/// The unnest behind a FROM item, if it is one.
pub(super) fn unnest_call(tf: &sql::TableFactor) -> Option<UnnestCall> {
    let parts = |alias: &Option<sql::TableAlias>| {
        (alias.as_ref().map(|a| ident(&a.name)), alias.as_ref().map(|a| a.columns.iter().map(|c| ident(&c.name)).collect()).unwrap_or_default())
    };
    match tf {
        sql::TableFactor::UNNEST { alias, array_exprs, .. } => {
            let (alias, columns) = parts(alias);
            Some(UnnestCall { args: array_exprs.clone(), alias, columns })
        }
        sql::TableFactor::Table { name, args: Some(call), alias, .. }
            if super::object_name_parts(name).last().is_some_and(|n| n.eq_ignore_ascii_case("unnest")) =>
        {
            let args = call
                .args
                .iter()
                .filter_map(|a| match a {
                    sql::FunctionArg::Unnamed(sql::FunctionArgExpr::Expr(x)) => Some(x.clone()),
                    _ => None,
                })
                .collect();
            let (alias, columns) = parts(alias);
            Some(UnnestCall { args, alias, columns })
        }
        _ => None,
    }
}
