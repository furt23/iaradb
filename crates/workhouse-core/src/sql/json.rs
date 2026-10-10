//! SQL for JSON text: the `->` and `->>` operators.

use sqlparser::ast as sql;

use super::{Scope, SqlPlanner, ident};
use crate::error::{Result, WhError};
use crate::expr::{Expr, ScalarFunc};
use crate::schema::Column;

/// `left -> right` (JSON text) or `left ->> right` (a string).
pub(super) fn arrow(op: &sql::BinaryOperator, left: Expr, right: Expr) -> Expr {
    let func = if matches!(op, sql::BinaryOperator::Arrow) { ScalarFunc::JsonExtract } else { ScalarFunc::JsonExtractString };
    Expr::Function { func, args: vec![left, right] }
}

fn arrow_op(e: &sql::Expr) -> Option<(&sql::Expr, &sql::BinaryOperator, &sql::Expr)> {
    match e {
        sql::Expr::BinaryOp { left, op: op @ (sql::BinaryOperator::Arrow | sql::BinaryOperator::LongArrow), right } => Some((left, op, right)),
        _ => None,
    }
}

/// `x -> body` is a lambda to the parser: one plain parameter and the arrow syntax.
pub(super) fn is_arrow_lambda(l: &sql::LambdaFunction) -> bool {
    matches!(l.syntax, sql::LambdaSyntax::Arrow)
        && matches!(&l.params, sql::OneOrManyWithParens::One(p) if p.data_type.is_none())
}

impl<'a> SqlPlanner<'a> {
    /// `col -> a ->> b -> c` read as a lambda `col -> (a ->> b -> c)`: the
    /// operators apply from the left, starting with the lambda's own arrow.
    pub(super) fn json_arrows(&mut self, l: &sql::LambdaFunction, scope: Scope<'_>) -> Result<Expr> {
        let sql::OneOrManyWithParens::One(param) = &l.params else {
            return Err(WhError::NotSupported("lambda functions".into()));
        };
        let mut operands: Vec<(&sql::BinaryOperator, &sql::Expr)> = vec![];
        let mut body: &sql::Expr = &l.body;
        while let Some((left, op, right)) = arrow_op(body) {
            operands.push((op, right));
            body = left;
        }
        let first = self.sql_expr(body, scope)?;
        let column = self.resolve(None, ident(&param.name), scope).map_err(|_| {
            WhError::NotSupported(format!("lambda functions (read '{} -> ..' as a JSON path, but there is no column {})", param.name, Column::from_name(ident(&param.name))))
        })?;
        let mut acc = arrow(&sql::BinaryOperator::Arrow, column, first);
        for (op, right) in operands.into_iter().rev() {
            acc = arrow(op, acc, self.sql_expr(right, scope)?);
        }
        Ok(acc)
    }
}
