//! `GROUP BY ROLLUP(..) / CUBE(..) / GROUPING SETS (..)` and `grouping(..)`.
//!
//! Planned as a UNION ALL of one ordinary aggregation per grouping set: the
//! keys missing from a set read as typed NULLs and `grouping(k..)` becomes
//! the constant bitmask of that set. The input is scanned once per set.

use std::sync::Arc;

use sqlparser::ast as sql;

use super::{Scope, SqlPlanner, no_windows};
use crate::error::{Result, WhError};
use crate::expr::{Expr, ScalarFunc};
use crate::logical::LogicalPlan;
use crate::scalar::Scalar;
use crate::schema::Column;
use crate::session::plan_aggregate;

/// The distinct keys and, per grouping set, the positions of its keys.
pub(super) struct Sets {
    pub keys: Vec<Expr>,
    pub sets: Vec<Vec<usize>>,
}

/// Does this GROUP BY list contain ROLLUP / CUBE / GROUPING SETS?
pub(super) fn has_grouping_sets(exprs: &[sql::Expr]) -> bool {
    exprs.iter().any(|e| matches!(e, sql::Expr::Rollup(_) | sql::Expr::Cube(_) | sql::Expr::GroupingSets(_)))
}

/// Sets of one GROUP BY element, each a list of resolved key expressions.
type Element = Vec<Vec<Expr>>;

fn rollup(parts: &[Vec<Expr>]) -> Element {
    (0..=parts.len()).rev().map(|n| parts[..n].concat()).collect()
}

fn cube(parts: &[Vec<Expr>]) -> Element {
    let n = parts.len();
    // the largest set first, like DuckDB
    (0..1usize << n).rev().map(|mask| (0..n).filter(|i| mask >> (n - 1 - i) & 1 == 1).flat_map(|i| parts[i].clone()).collect()).collect()
}

impl SqlPlanner<'_> {
    /// Resolve the GROUP BY list into keys and grouping sets (the cross
    /// product of its elements).
    pub(super) fn grouping_sets(
        &mut self,
        exprs: &[sql::Expr],
        mut resolve: impl FnMut(&mut Self, &sql::Expr) -> Result<Expr>,
    ) -> Result<Sets> {
        let mut keys: Vec<Expr> = vec![];
        let mut product: Vec<Vec<usize>> = vec![vec![]];
        for e in exprs {
            let mut resolve_all = |this: &mut Self, list: &[sql::Expr]| -> Result<Vec<Expr>> {
                list.iter().map(|x| resolve(this, x)).collect()
            };
            let element: Element = match e {
                sql::Expr::Rollup(parts) | sql::Expr::Cube(parts) => {
                    let parts = parts.iter().map(|p| resolve_all(self, p)).collect::<Result<Vec<_>>>()?;
                    if matches!(e, sql::Expr::Rollup(_)) { rollup(&parts) } else { cube(&parts) }
                }
                sql::Expr::GroupingSets(sets) => sets.iter().map(|s| resolve_all(self, s)).collect::<Result<_>>()?,
                plain => vec![vec![resolve(self, plain)?]],
            };
            let element: Vec<Vec<usize>> = element
                .into_iter()
                .map(|set| set.into_iter().map(|k| key_position(&mut keys, k)).collect())
                .collect();
            product = product
                .iter()
                .flat_map(|acc| element.iter().map(move |set| merged(acc, set)))
                .collect();
        }
        Ok(Sets { keys, sets: product })
    }

    /// Aggregate `input` once per grouping set and union the results.
    /// Returns the plan and the rewritten select and hidden sort expressions.
    pub(super) fn plan_grouping_sets(
        &mut self,
        input: LogicalPlan,
        sets: &Sets,
        select: Vec<Expr>,
        having: Option<Expr>,
        hidden: Vec<Expr>,
        scope: Scope<'_>,
    ) -> Result<(LogicalPlan, Vec<Expr>, Vec<Expr>)> {
        if select.iter().chain(&hidden).any(|e| e.contains_window()) {
            return Err(WhError::NotSupported("window functions with ROLLUP/CUBE/GROUPING SETS".into()));
        }
        let key_types = sets
            .keys
            .iter()
            .map(|k| k.data_type(scope.schema))
            .collect::<Result<Vec<_>>>()?;
        let input = Arc::new(input);
        let (n_sel, n_hidden) = (select.len(), hidden.len());
        let names: Vec<String> = select.iter().map(|e| e.output_name()).collect();
        let mut branches = vec![];
        for set in &sets.sets {
            let sub = |e: Expr| substitute(e, sets, set, &key_types);
            let mut all: Vec<Expr> = select.iter().zip(&names).map(|(e, n)| sub(e.clone().unalias()).map(|x| x.alias(n.clone()))).collect::<Result<_>>()?;
            if let Some(h) = &having {
                all.push(sub(h.clone())?.alias("__having"));
            }
            for (i, h) in hidden.iter().enumerate() {
                all.push(sub(h.clone())?.alias(format!("__sort_{i}")));
            }
            let group: Vec<Expr> = set.iter().map(|&k| sets.keys[k].clone()).collect();
            let r = plan_aggregate(input.clone(), group, all)?;
            let mut plan = r.plan;
            let mut exprs = r.exprs;
            let rest = exprs.split_off(n_sel);
            let mut rest = rest.into_iter();
            if having.is_some() {
                plan = LogicalPlan::filter(Arc::new(plan), rest.next().expect("having").unalias())?;
            }
            let columns = exprs
                .into_iter()
                .enumerate()
                .map(|(i, e)| e.unalias().alias(format!("__gs{i}")))
                .chain(rest.enumerate().map(|(i, e)| e.unalias().alias(format!("__gh{i}"))))
                .collect();
            branches.push(Arc::new(LogicalPlan::project(Arc::new(plan), columns)?));
        }
        let plan = if branches.len() == 1 { Arc::try_unwrap(branches.remove(0)).unwrap_or_else(|a| (*a).clone()) } else { LogicalPlan::union(branches)? };
        let col = |name: String| Expr::Column(Column::from_name(name));
        let select = (0..n_sel).map(|i| col(format!("__gs{i}")).alias(names[i].clone())).collect();
        let hidden = (0..n_hidden).map(|i| col(format!("__gh{i}"))).collect();
        Ok((plan, select, hidden))
    }

    /// Resolve one GROUP BY key (an ordinal, an output alias or an expression).
    pub(super) fn group_key(&mut self, g: &sql::Expr, select: &[Expr], scope: Scope<'_>) -> Result<Expr> {
        let e = match super::as_ordinal(g) {
            Some(k) if k >= 1 && k <= select.len() => select[k - 1].clone().unalias(),
            _ => self.sql_expr(g, scope)?,
        };
        no_windows(e, "GROUP BY")
    }
}

fn key_position(keys: &mut Vec<Expr>, k: Expr) -> usize {
    match keys.iter().position(|x| *x == k) {
        Some(i) => i,
        None => {
            keys.push(k);
            keys.len() - 1
        }
    }
}

fn merged(a: &[usize], b: &[usize]) -> Vec<usize> {
    let mut out = a.to_vec();
    for &k in b {
        if !out.contains(&k) {
            out.push(k);
        }
    }
    out.sort_unstable();
    out
}

/// In the aggregation of `set`: missing keys become typed NULLs and
/// `grouping(..)` the bitmask of the keys missing from the set. Aggregate
/// arguments are left alone.
fn substitute(e: Expr, sets: &Sets, set: &[usize], key_types: &[arrow::datatypes::DataType]) -> Result<Expr> {
    let missing = |k: &Expr| sets.keys.iter().position(|x| x == k).filter(|i| !set.contains(i));
    e.transform_down(&mut |x| {
        if matches!(x, Expr::Agg { .. }) {
            return Ok((x, false));
        }
        if let Expr::Function { func: ScalarFunc::Grouping, args } = &x {
            let mut mask = 0i64;
            for a in args {
                let k = sets
                    .keys
                    .iter()
                    .position(|k| k == a)
                    .ok_or_else(|| WhError::Plan(format!("grouping({a}): not a GROUP BY expression")))?;
                mask = mask << 1 | i64::from(!set.contains(&k));
            }
            return Ok((Expr::Literal(Scalar::int64(mask)), false));
        }
        if let Some(i) = missing(&x) {
            return Ok((Expr::Literal(Scalar::null()).cast(key_types[i].clone()), false));
        }
        Ok((x, true))
    })
}
