//! `WITH RECURSIVE`: a CTE whose body is `base UNION [ALL] recursive`, where
//! the recursive term reads the CTE itself (the previous iteration's rows).

use std::collections::HashMap;
use std::sync::Arc;

use arrow::datatypes::{DataType, Field, Schema};
use sqlparser::ast as sql;

use super::{SqlPlanner, distinct};
use crate::error::{Result, WhError};
use crate::expr::Expr;
use crate::io::work_table::WorkTable;
use crate::logical::LogicalPlan;
use crate::types::common_supertype;

/// Does `plan` scan `table`?
fn scans(plan: &LogicalPlan, table: &Arc<WorkTable>) -> bool {
    if let LogicalPlan::Scan(s) = plan {
        if Arc::as_ptr(&s.source) as *const () == Arc::as_ptr(table) as *const () {
            return true;
        }
    }
    plan.inputs().iter().any(|i| scans(i, table))
}

/// `plan` with its columns cast to `types` (names kept).
fn cast_columns(plan: LogicalPlan, types: &[DataType]) -> Result<LogicalPlan> {
    let schema = plan.schema().clone();
    if (0..schema.len()).all(|i| schema.field(i).data_type() == &types[i]) {
        return Ok(plan);
    }
    let exprs = (0..schema.len())
        .map(|i| {
            let c = Expr::Column(schema.column(i));
            if schema.field(i).data_type() == &types[i] { c } else { c.cast(types[i].clone()).alias(schema.field(i).name().clone()) }
        })
        .collect();
    LogicalPlan::project(Arc::new(plan), exprs)
}

impl SqlPlanner<'_> {
    /// Plan a CTE of a `WITH RECURSIVE` clause: recursive when its body is
    /// a UNION whose right side refers to the CTE, a plain CTE otherwise.
    pub(super) fn plan_recursive_cte(&mut self, cte: &sql::Cte, columns: &[String]) -> Result<Option<LogicalPlan>> {
        let q = &cte.query;
        let sql::SetExpr::SetOperation { left, op: sql::SetOperator::Union, set_quantifier, right } = q.body.as_ref() else {
            return Ok(None);
        };
        if q.order_by.is_some() || q.limit_clause.is_some() || q.with.is_some() {
            return Ok(None);
        }
        let name = super::ident(&cte.alias.name);
        let mut base = self.plan_set_expr(left, &[], None)?;
        if !columns.is_empty() {
            base = self.rename_columns(base, columns)?;
        }
        let n = base.schema().len();
        let names: Vec<String> = (0..n).map(|i| base.schema().field(i).name().clone()).collect();
        // the work table takes the base term's types, widened until the
        // recursive term's results fit (e.g. a NULL column in the base term)
        let mut types: Vec<DataType> = (0..n).map(|i| base.schema().field(i).data_type().clone()).collect();
        let mut attempt = 0;
        let (work_table, step) = loop {
            let schema = Arc::new(Schema::new(
                names.iter().zip(&types).map(|(n, t)| Field::new(n, t.clone(), true)).collect::<Vec<_>>(),
            ));
            let rows = crate::physical::planner::estimate_rows(&base) as usize;
            let wt = Arc::new(WorkTable::new(&name, schema, rows));
            let scan = LogicalPlan::scan(&name, Some(name.clone()), wt.clone(), None, vec![], None)?;
            self.ctes.push(HashMap::from([(name.to_ascii_lowercase(), Arc::new(scan))]));
            let planned = self.plan_set_expr(right, &[], None);
            self.ctes.pop();
            let step = planned?;
            if step.schema().len() != n {
                return Err(WhError::Plan(format!(
                    "recursive CTE '{name}': the recursive term returns {} columns, the base term {n}",
                    step.schema().len()
                )));
            }
            if !scans(&step, &wt) {
                // not recursive after all: an ordinary UNION
                let u = LogicalPlan::union(vec![Arc::new(base), Arc::new(step)])?;
                let all = matches!(set_quantifier, sql::SetQuantifier::All | sql::SetQuantifier::AllByName);
                return Ok(Some(if all { u } else { distinct(u)? }));
            }
            let widened: Vec<DataType> = (0..n)
                .map(|i| {
                    let t = step.schema().field(i).data_type();
                    common_supertype([&types[i], t]).ok_or_else(|| {
                        WhError::Plan(format!("recursive CTE '{name}': column {} has types {} and {t}", names[i], types[i]))
                    })
                })
                .collect::<Result<_>>()?;
            attempt += 1;
            if widened == types || attempt >= 3 {
                break (wt, step);
            }
            types = widened;
        };
        let base = cast_columns(base, &types)?;
        let step = cast_columns(step, &types)?;
        let distinct = !matches!(set_quantifier, sql::SetQuantifier::All | sql::SetQuantifier::AllByName);
        Ok(Some(LogicalPlan::recursive_query(&name, Arc::new(base), Arc::new(step), work_table, distinct)?))
    }
}
