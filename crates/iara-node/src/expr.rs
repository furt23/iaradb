//! Expressions of the DataFrame API.

use napi::bindgen_prelude::{ClassInstance, Unknown};
use napi_derive::napi;

use iara_core::Scalar;
use iara_core::expr::{AggFunc, Expr, Operator, ScalarFunc, binary, col, count_star};
use iara_core::types::parse_data_type;

use crate::error::{Result, ResExt, invalid};
use crate::scalar::scalar;
use crate::window::{self, FrameSpec};

#[napi]
#[derive(Clone)]
pub struct JsExpr {
    pub(crate) inner: Expr,
}

pub fn exprs_of(v: &[ClassInstance<'_, JsExpr>]) -> Vec<Expr> {
    v.iter().map(|e| e.inner.clone()).collect()
}

pub fn opt_exprs(v: Option<Vec<ClassInstance<'_, JsExpr>>>) -> Vec<Expr> {
    v.map(|v| exprs_of(&v)).unwrap_or_default()
}

fn wrap(e: Expr) -> JsExpr {
    JsExpr { inner: e }
}

#[napi]
impl JsExpr {
    /// An aggregate over this expression and extra arguments (quantile, max_by, corr ...).
    #[napi(catch_unwind)]
    pub fn agg_with(&self, name: String, extra: Vec<ClassInstance<'_, JsExpr>>, distinct: Option<bool>) -> Result<JsExpr> {
        let func = AggFunc::from_name(&name).ok_or_else(|| invalid(format!("unknown aggregate '{name}'")))?;
        let mut args = vec![self.inner.clone()];
        args.extend(exprs_of(&extra));
        Ok(wrap(Expr::Agg { func, args, distinct: distinct.unwrap_or(false), filter: None, order_by: vec![] }))
    }

    #[napi]
    pub fn col(name: String) -> JsExpr {
        wrap(col(&name))
    }

    #[napi]
    pub fn lit(value: Unknown<'_>) -> Result<JsExpr> {
        Ok(wrap(Expr::Literal(scalar(value)?)))
    }

    #[napi]
    pub fn wildcard(qualifier: Option<String>) -> JsExpr {
        wrap(Expr::Wildcard { qualifier })
    }

    #[napi]
    pub fn count_star() -> JsExpr {
        wrap(count_star())
    }

    #[napi]
    pub fn binary(&self, op: String, other: &JsExpr) -> Result<JsExpr> {
        let op = match op.as_str() {
            "+" => Operator::Plus,
            "-" => Operator::Minus,
            "*" => Operator::Multiply,
            "/" => Operator::Divide,
            "%" => Operator::Modulo,
            "==" => Operator::Eq,
            "!=" => Operator::NotEq,
            "<" => Operator::Lt,
            "<=" => Operator::LtEq,
            ">" => Operator::Gt,
            ">=" => Operator::GtEq,
            "and" => Operator::And,
            "or" => Operator::Or,
            "||" => Operator::StringConcat,
            o => return Err(invalid(format!("unknown operator '{o}'"))),
        };
        Ok(wrap(binary(self.inner.clone(), op, other.inner.clone())))
    }

    #[napi(js_name = "not")]
    pub fn not_(&self) -> JsExpr {
        wrap(self.inner.clone().not())
    }

    #[napi]
    pub fn neg(&self) -> JsExpr {
        wrap(Expr::Negative(Box::new(self.inner.clone())))
    }

    #[napi]
    pub fn is_null(&self) -> JsExpr {
        wrap(self.inner.clone().is_null())
    }

    #[napi]
    pub fn is_not_null(&self) -> JsExpr {
        wrap(self.inner.clone().is_not_null())
    }

    #[napi]
    pub fn alias(&self, name: String) -> JsExpr {
        wrap(self.inner.clone().alias(&name))
    }

    /// `strict` false turns a failed conversion into null instead of an error.
    #[napi(catch_unwind)]
    pub fn cast(&self, dtype: String, strict: Option<bool>) -> Result<JsExpr> {
        let to = parse_data_type(&dtype).js()?;
        Ok(wrap(Expr::Cast { expr: Box::new(self.inner.clone()), to, try_cast: !strict.unwrap_or(true) }))
    }

    #[napi]
    pub fn agg(&self, name: String, distinct: Option<bool>) -> Result<JsExpr> {
        let (func, distinct) = match name.as_str() {
            "n_unique" | "count_distinct" => (AggFunc::Count, true),
            n => (AggFunc::from_name(n).ok_or_else(|| invalid(format!("unknown aggregate '{n}'")))?, distinct.unwrap_or(false)),
        };
        Ok(wrap(Expr::Agg { func, args: vec![self.inner.clone()], distinct, filter: None, order_by: vec![] }))
    }

    /// Restrict an aggregate to the rows where `predicate` holds.
    #[napi]
    pub fn agg_filter(&self, predicate: &JsExpr) -> Result<JsExpr> {
        match self.inner.clone().unalias() {
            Expr::Agg { func, args, distinct, order_by, .. } => {
                Ok(wrap(Expr::Agg { func, args, distinct, filter: Some(Box::new(predicate.inner.clone())), order_by }))
            }
            _ => Err(invalid("filter() on a non-aggregate expression")),
        }
    }

    #[napi]
    pub fn func(name: String, args: Vec<ClassInstance<'_, JsExpr>>) -> Result<JsExpr> {
        let f = ScalarFunc::from_name(&name).ok_or_else(|| invalid(format!("unknown function '{name}'")))?;
        Ok(wrap(Expr::Function { func: f, args: exprs_of(&args) }))
    }

    #[napi]
    pub fn is_in(&self, values: Vec<ClassInstance<'_, JsExpr>>, negated: Option<bool>) -> JsExpr {
        wrap(Expr::InList { expr: Box::new(self.inner.clone()), list: exprs_of(&values), negated: negated.unwrap_or(false) })
    }

    #[napi]
    pub fn like(&self, pattern: String, negated: Option<bool>, case_insensitive: Option<bool>) -> JsExpr {
        wrap(Expr::Like {
            expr: Box::new(self.inner.clone()),
            pattern: Box::new(Expr::Literal(Scalar::utf8(&pattern))),
            negated: negated.unwrap_or(false),
            case_insensitive: case_insensitive.unwrap_or(false),
        })
    }

    /// `CASE WHEN whens[i] THEN thens[i] ... ELSE otherwise END` (two parallel arrays).
    #[napi(js_name = "case")]
    pub fn case_when(whens: Vec<ClassInstance<'_, JsExpr>>, thens: Vec<ClassInstance<'_, JsExpr>>, otherwise: Option<&JsExpr>) -> Result<JsExpr> {
        if whens.len() != thens.len() {
            return Err(invalid("case: whens and thens must have the same length"));
        }
        Ok(wrap(Expr::Case {
            when_then: exprs_of(&whens).into_iter().zip(exprs_of(&thens)).collect(),
            otherwise: otherwise.map(|o| Box::new(o.inner.clone())),
        }))
    }

    #[napi]
    pub fn output_name(&self) -> String {
        self.inner.output_name()
    }

    #[napi]
    pub fn root_name(&self) -> Option<String> {
        self.inner.root_name()
    }

    #[napi]
    pub fn is_column(&self) -> bool {
        matches!(self.inner, Expr::Column(_))
    }

    #[napi]
    pub fn is_alias(&self) -> bool {
        matches!(self.inner, Expr::Alias(..))
    }

    #[napi]
    pub fn is_literal(&self) -> bool {
        matches!(self.inner, Expr::Literal(_))
    }

    #[napi]
    pub fn contains_agg(&self) -> bool {
        self.inner.contains_agg()
    }

    #[napi]
    pub fn contains_window(&self) -> bool {
        self.inner.contains_window()
    }

    /// A window function (`rank`, `lag`, `row_number`, ... or an aggregate)
    /// whose partitioning comes from a later `over()`.
    #[napi(catch_unwind)]
    pub fn window(
        name: String,
        args: Vec<ClassInstance<'_, JsExpr>>,
        order_by: Option<Vec<ClassInstance<'_, JsExpr>>>,
        descending: Option<Vec<bool>>,
        frame: Option<FrameSpec>,
    ) -> Result<JsExpr> {
        let (order_by, descending) = (opt_exprs(order_by), descending.unwrap_or_default());
        window::function(&name, exprs_of(&args), order_by, &descending, frame).js().map(wrap)
    }

    /// Turn the aggregates / window functions in this expression into window
    /// expressions over `partitionBy` (ordered by `orderBy`).
    #[napi(catch_unwind)]
    pub fn over(
        &self,
        partition_by: Vec<ClassInstance<'_, JsExpr>>,
        order_by: Option<Vec<ClassInstance<'_, JsExpr>>>,
        descending: Option<Vec<bool>>,
        nulls_last: Option<Vec<bool>>,
        frame: Option<FrameSpec>,
    ) -> Result<JsExpr> {
        let (order_by, descending, nulls_last) = (opt_exprs(order_by), descending.unwrap_or_default(), nulls_last.unwrap_or_default());
        window::over(self.inner.clone(), exprs_of(&partition_by), order_by, &descending, &nulls_last, frame).js().map(wrap)
    }

    #[napi(js_name = "toString")]
    pub fn display(&self) -> String {
        self.inner.to_string()
    }
}
