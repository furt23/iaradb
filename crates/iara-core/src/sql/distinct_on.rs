//! `SELECT DISTINCT ON (keys) ..`: the first row of each key, by ORDER BY.
//!
//! The keys are resolved like ORDER BY keys, so they can be output columns,
//! ordinals or expressions (kept as hidden columns until the end). The
//! selection is `row_number() OVER (PARTITION BY keys ORDER BY ..) = 1`.

use std::sync::Arc;

use sqlparser::ast as sql;

use super::{OrderKey, Scope, SqlPlanner, as_ordinal, ident};
use crate::error::Result;
use crate::expr::*;
use crate::logical::LogicalPlan;
use crate::scalar::Scalar;
use crate::schema::PlanSchema;

const RN: &str = "__distinct_on_rn";

impl OrderKey {
    /// The column that holds this key in the projected plan.
    pub(super) fn column(&self, schema: &PlanSchema) -> Expr {
        match self {
            OrderKey::Output(i) => Expr::Column(schema.column(*i)),
            OrderKey::Hidden(i) => col(format!("__sort_{i}")),
        }
    }
}

impl SqlPlanner<'_> {
    /// An ORDER BY / DISTINCT ON key: an output column by ordinal or name,
    /// else an expression (an output column when it equals one, else hidden).
    pub(super) fn order_key(
        &mut self,
        key: &sql::Expr,
        select_exprs: &[Expr],
        out_names: &[String],
        hidden: &mut Vec<Expr>,
        scope: Scope<'_>,
    ) -> Result<OrderKey> {
        if let Some(k) = as_ordinal(key) {
            if k >= 1 && k <= select_exprs.len() {
                return Ok(OrderKey::Output(k - 1));
            }
        }
        if let sql::Expr::Identifier(id) = key {
            let name = ident(id);
            let matches: Vec<usize> =
                out_names.iter().enumerate().filter(|(_, n)| n.eq_ignore_ascii_case(&name)).map(|(i, _)| i).collect();
            if matches.len() == 1 {
                return Ok(OrderKey::Output(matches[0]));
            }
        }
        let e = self.sql_expr(key, scope)?;
        Ok(match select_exprs.iter().position(|s| s.unalias_ref() == &e) {
            Some(i) => OrderKey::Output(i),
            None => {
                hidden.push(e);
                OrderKey::Hidden(hidden.len() - 1)
            }
        })
    }
}

/// Keep the first row of each distinct `on` key in `order`. `plan` is the
/// projection of the select list and the hidden columns.
pub(super) fn distinct_on(plan: LogicalPlan, on: &[OrderKey], order: &[(OrderKey, bool, bool)]) -> Result<LogicalPlan> {
    let schema = plan.schema().clone();
    let keys = on.iter().map(|k| k.column(&schema)).collect();
    let sorts = order.iter().map(|(k, desc, nf)| SortExpr::new(k.column(&schema), *desc, *nf)).collect();
    let rn = WindowExpr::new(WindowFunc::RowNumber, vec![], keys, sorts);
    rn.validate()?;
    let (windowed, rewritten) = crate::window::plan_windows(Arc::new(plan), vec![Expr::Window(Box::new(rn)).alias(RN)])?;
    let first = rewritten[0].clone().unalias().eq(lit(Scalar::int64(1)));
    let filtered = LogicalPlan::filter(Arc::new(windowed), first)?;
    let keep = (0..schema.len()).map(|i| Expr::Column(filtered.schema().column(i))).collect();
    LogicalPlan::project(Arc::new(filtered), keep)
}
