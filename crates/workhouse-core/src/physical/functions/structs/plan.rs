//! Plan-time handling of the struct functions: constant field names, values
//! cast to their canonical field types, and the result type.

use arrow::datatypes::DataType;

use super::names::{self, field_name, field_type, find_field, insert_type, pack_type};
use crate::error::{Result, WhError};
use crate::expr::{Expr, ScalarFunc::{self, *}};
use crate::nested::{struct_fields, type_name};
use crate::physical::expr::{PhysExpr, cast_expr, create_physical_expr};
use crate::scalar::Scalar;
use crate::schema::PlanSchema;

fn name_at(a: &[PhysExpr], i: usize, func: ScalarFunc) -> Result<String> {
    let lit: Option<&Scalar> = match a.get(i) {
        Some(PhysExpr::Literal(s)) => Some(s),
        _ => None,
    };
    field_name(lit, func)
}

/// Cast the values (every second argument from `first`) to their field types.
fn canonical_values(a: &mut [PhysExpr], first: usize) -> Result<()> {
    for i in (first..a.len()).step_by(2) {
        let t = field_type(&a[i].data_type());
        a[i] = cast_expr(a[i].clone(), &t)?;
    }
    Ok(())
}

pub fn compile(func: ScalarFunc, args: &[Expr], schema: &PlanSchema) -> Result<PhysExpr> {
    let mut a = args.iter().map(|e| create_physical_expr(e, schema)).collect::<Result<Vec<_>>>()?;
    let dt = match func {
        StructPack => {
            if a.is_empty() || a.len() % 2 != 0 {
                return Err(WhError::Plan("struct_pack expects at least one name, value pair".into()));
            }
            canonical_values(&mut a, 1)?;
            let names = (0..a.len()).step_by(2).map(|i| name_at(&a, i, func)).collect::<Result<Vec<_>>>()?;
            let types: Vec<DataType> = a.iter().skip(1).step_by(2).map(|x| x.data_type()).collect();
            pack_type(func, names, &types)?
        }
        StructExtract => {
            if a.len() != 2 {
                return Err(WhError::Plan("struct_extract expects (struct, 'field')".into()));
            }
            let t = a[0].data_type();
            let i = find_field(&t, &name_at(&a, 1, func)?)?;
            struct_fields(&t).map(|f| f[i].data_type().clone()).unwrap_or(DataType::Null)
        }
        StructInsert => {
            if a.len() < 3 || a.len() % 2 != 1 {
                return Err(WhError::Plan("struct_insert expects (struct, name, value, ..)".into()));
            }
            let t = a[0].data_type();
            if struct_fields(&t).is_none() {
                return Err(WhError::Plan(format!("struct_insert expects a struct, got {}", type_name(&t))));
            }
            canonical_values(&mut a, 2)?;
            let new_names = (1..a.len()).step_by(2).map(|i| name_at(&a, i, func)).collect::<Result<Vec<_>>>()?;
            let types: Vec<DataType> = a.iter().skip(2).step_by(2).map(|x| x.data_type()).collect();
            insert_type(&t, new_names, types.iter())?
        }
        StructRename => {
            if a.len() < 2 {
                return Err(WhError::Plan("struct_rename expects (struct, 'name', ..)".into()));
            }
            let new_names = (1..a.len()).map(|i| name_at(&a, i, func)).collect::<Result<Vec<_>>>()?;
            names::rename_type(&a[0].data_type(), new_names)?
        }
        other => return Err(WhError::Plan(format!("{}: not a struct function", names::name(other)))),
    };
    Ok(PhysExpr::Function { func, args: a, dt })
}
