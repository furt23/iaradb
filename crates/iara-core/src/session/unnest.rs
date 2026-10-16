//! `LazyFrame::unnest`: struct columns into one column per field (Polars).

use std::sync::Arc;

use super::LazyFrame;
use crate::error::{Result, WhError};
use crate::expr::{Expr, ScalarFunc};
use crate::logical::LogicalPlan;
use crate::nested::{struct_fields, type_name};
use crate::scalar::Scalar;

impl LazyFrame {
    /// The fields of the struct `e` is, or `None` when it is not a struct.
    pub fn struct_field_names(&self, e: &Expr) -> Result<Option<Vec<String>>> {
        let t = e.data_type(self.schema())?;
        Ok(struct_fields(&t).map(|f| f.iter().map(|f| f.name().clone()).collect()))
    }

    /// The struct `columns` replaced, in place, by one column per field. With a
    /// `separator`, fields are named `column{separator}field`.
    pub fn unnest(&self, columns: &[String], separator: Option<&str>) -> Result<LazyFrame> {
        let schema = self.schema();
        for c in columns {
            let f = schema.fields().iter().find(|f| f.name() == c).ok_or_else(|| WhError::Plan(format!("unnest: no column '{c}'")))?;
            if struct_fields(f.field.data_type()).is_none() {
                return Err(WhError::Plan(format!("unnest: column '{c}' is {}, not a struct", type_name(f.field.data_type()))));
            }
        }
        let mut out: Vec<Expr> = vec![];
        for f in schema.fields() {
            let (Some(fields), true) = (struct_fields(f.field.data_type()), columns.iter().any(|c| c == f.name())) else {
                out.push(Expr::Column(f.column()));
                continue;
            };
            for sub in fields {
                let read = Expr::Function {
                    func: ScalarFunc::StructExtract,
                    args: vec![Expr::Column(f.column()), Expr::Literal(Scalar::utf8(sub.name()))],
                };
                let name = match separator {
                    Some(sep) => format!("{}{sep}{}", f.name(), sub.name()),
                    None => sub.name().clone(),
                };
                out.push(read.alias(name));
            }
        }
        let mut seen = std::collections::HashSet::new();
        if let Some(dup) = out.iter().map(|e| e.output_name()).find(|n| !seen.insert(n.clone())) {
            return Err(WhError::Plan(format!("unnest: the column name '{dup}' would appear twice (use separator=..)")));
        }
        Ok(self.wrap(LogicalPlan::project(Arc::new(self.plan.as_ref().clone()), out)?))
    }
}
