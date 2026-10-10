//! Plan-time handling of the JSON functions: text arguments, constant paths
//! (parsed once) and the type of `from_json`.

use arrow::datatypes::DataType;

use super::names::{self, decoded_type};
use super::path::{self, Step};
use crate::error::{Result, WhError};
use crate::expr::{Expr, ScalarFunc::{self, *}};
use crate::physical::expr::{PhysExpr, create_physical_expr, to_utf8};
use crate::schema::PlanSchema;

/// The path of a call: a constant string (`'$.a.b'`, `'key'`) or position (`1`).
pub fn steps_of(e: &PhysExpr) -> Result<Vec<Step>> {
    let PhysExpr::Literal(s) = e else {
        return Err(WhError::NotSupported("a JSON path must be a constant".into()));
    };
    match (s.as_str(), s.as_i64()) {
        (Some(p), _) => path::parse(p),
        (_, Some(n)) => Ok(vec![path::position(n)]),
        _ => Err(WhError::Plan("a JSON path must be a non-NULL string or number".into())),
    }
}

pub fn compile(func: ScalarFunc, args: &[Expr], schema: &PlanSchema) -> Result<PhysExpr> {
    let mut a = args.iter().map(|e| create_physical_expr(e, schema)).collect::<Result<Vec<_>>>()?;
    let (lo, hi) = match func {
        JsonExtract | JsonExtractString | FromJson => (2, 2),
        JsonArrayLength => (1, 2),
        _ => (1, 1),
    };
    if a.len() < lo || a.len() > hi {
        return Err(WhError::Plan(format!("{} expects {lo}..{hi} arguments, got {}", names::name(func), a.len())));
    }
    let dt = match func {
        ToJson => {
            // a bare NULL has no type to encode
            if a[0].data_type() == DataType::Null {
                a[0] = crate::physical::expr::cast_expr(a[0].clone(), &DataType::Utf8)?;
            }
            DataType::Utf8
        }
        FromJson => {
            a[0] = to_utf8(a[0].clone())?;
            let PhysExpr::Literal(t) = &a[1] else { return Err(WhError::NotSupported("from_json's type must be a constant string".into())) };
            decoded_type(t.as_str())?
        }
        _ => {
            a[0] = to_utf8(a[0].clone())?;
            if a.len() == 2 {
                steps_of(&a[1])?;
            }
            func.return_type(&[])?
        }
    };
    Ok(PhysExpr::Function { func, args: a, dt })
}
