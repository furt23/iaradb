//! `FROM t TABLESAMPLE ..`: `BERNOULLI | SYSTEM (p PERCENT)`, `(p)` and
//! `(n ROWS)`, each with an optional `REPEATABLE (seed)`.
//!
//! A percentage keeps the rows whose random number is below it; `n ROWS`
//! orders by the random number and keeps the first `n`. With a seed the number
//! is `random(seed, row_number())`, so the same data gives the same sample.

use std::sync::Arc;

use sqlparser::ast as sql;

use super::{Scope, SqlPlanner};
use crate::error::{Result, WhError};
use crate::expr::*;
use crate::logical::LogicalPlan;
use crate::physical::expr::evaluate_constant;
use crate::scalar::Scalar;
use crate::schema::PlanSchema;

const KEY: &str = "__sample";

enum Size {
    Percent(f64),
    Rows(usize),
}

struct Sample {
    size: Size,
    seed: Option<i64>,
}

impl SqlPlanner<'_> {
    pub(super) fn sample_table(&mut self, plan: LogicalPlan, kind: &sql::TableSampleKind) -> Result<LogicalPlan> {
        let (sql::TableSampleKind::BeforeTableAlias(s) | sql::TableSampleKind::AfterTableAlias(s)) = kind;
        let sample = self.sample_spec(s)?;
        sample.apply(plan)
    }

    fn sample_spec(&mut self, s: &sql::TableSample) -> Result<Sample> {
        if s.bucket.is_some() || s.offset.is_some() {
            return Err(WhError::NotSupported(format!("table sample: {s}")));
        }
        if !matches!(s.name, None | Some(sql::TableSampleMethod::Bernoulli | sql::TableSampleMethod::System)) {
            return Err(WhError::NotSupported(format!("table sample: {s}")));
        }
        let q = s.quantity.as_ref().ok_or_else(|| WhError::Plan(format!("table sample without a size: {s}")))?;
        let empty = PlanSchema::empty();
        let x = self.sql_expr(&q.value, Scope::new(&empty, None))?;
        let n = evaluate_constant(&x)?
            .and_then(|v| v.as_f64())
            .ok_or_else(|| WhError::Plan(format!("the table sample size must be a number: {}", q.value)))?;
        let size = match q.unit {
            Some(sql::TableSampleUnit::Rows) => {
                if s.name.is_some() || n < 0.0 || n.fract() != 0.0 {
                    return Err(WhError::NotSupported(format!("table sample: {s}")));
                }
                Size::Rows(n as usize)
            }
            _ if (0.0..=100.0).contains(&n) => Size::Percent(n),
            _ => return Err(WhError::Plan(format!("a sample percentage is between 0 and 100, got {n}"))),
        };
        let seed = match &s.seed {
            None => None,
            Some(seed) => match &seed.value.value {
                sql::Value::Number(v, _) => Some(v.parse::<i64>().map_err(|_| WhError::Plan(format!("sample seed: {v}")))?),
                other => return Err(WhError::NotSupported(format!("sample seed {other}"))),
            },
        };
        Ok(Sample { size, seed })
    }
}

impl Sample {
    fn random(&self) -> Expr {
        let args = match self.seed {
            None => vec![],
            Some(seed) => {
                let row = WindowExpr::new(WindowFunc::RowNumber, vec![], vec![], vec![]);
                vec![lit(Scalar::int64(seed)), Expr::Window(Box::new(row))]
            }
        };
        Expr::Function { func: ScalarFunc::Random, args }
    }

    fn apply(self, plan: LogicalPlan) -> Result<LogicalPlan> {
        if let (Size::Percent(p), None) = (&self.size, self.seed) {
            let below = self.random().lt(lit(Scalar::float64(p / 100.0)));
            return LogicalPlan::filter(Arc::new(plan), below);
        }
        let schema = plan.schema().clone();
        let mut exprs: Vec<Expr> = (0..schema.len()).map(|i| Expr::Column(schema.column(i))).collect();
        exprs.push(self.random().alias(KEY));
        let (plan, exprs) = crate::window::plan_windows(Arc::new(plan), exprs)?;
        let keyed = Arc::new(LogicalPlan::project(Arc::new(plan), exprs)?);
        let sampled = match self.size {
            Size::Percent(p) => LogicalPlan::filter(keyed, col(KEY).lt(lit(Scalar::float64(p / 100.0))))?,
            Size::Rows(n) => LogicalPlan::sort(keyed, vec![SortExpr::new(col(KEY), false, false)], Some(n))?,
        };
        let keep = (0..schema.len()).map(|i| Expr::Column(sampled.schema().column(i))).collect();
        LogicalPlan::project(Arc::new(sampled), keep)
    }
}
