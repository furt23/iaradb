//! Plan-time handling of the list functions: argument coercion (element
//! types are unified, NULL becomes a typed list) and constant checks.

use arrow::datatypes::DataType;

use super::names;
use crate::error::{Result, WhError};
use crate::expr::{Expr, ScalarFunc};
use crate::nested::{canonical_element, element_type, is_list, list_of};
use crate::physical::expr::{PhysExpr, cast_expr, create_physical_expr, to_utf8};
use crate::schema::PlanSchema;
use crate::types::{comparison_common, common_supertype};

pub fn compile(func: ScalarFunc, args: &[Expr], schema: &PlanSchema) -> Result<PhysExpr> {
    use ScalarFunc::*;
    let n = args.len();
    let nargs = |lo: usize, hi: usize| -> Result<()> {
        if n < lo || n > hi {
            Err(WhError::Plan(format!("{} expects {lo}..{hi} arguments, got {n}", func.name())))
        } else {
            Ok(())
        }
    };
    let mut a = args.iter().map(|e| create_physical_expr(e, schema)).collect::<Result<Vec<_>>>()?;
    match func {
        ListValue => {
            let types: Vec<DataType> = a.iter().map(|x| x.data_type()).collect();
            let t = if types.is_empty() {
                DataType::Null
            } else {
                common_supertype(types.iter())
                    .ok_or_else(|| WhError::Plan(format!("list_value: incompatible element types {types:?}")))?
            };
            let t = canonical_element(&t);
            for x in a.iter_mut() {
                *x = cast_expr(x.clone(), &t)?;
            }
        }
        ListExtract => {
            nargs(2, 2)?;
            as_list(&mut a, 0, &DataType::Null)?;
            a[1] = cast_expr(a[1].clone(), &DataType::Int64)?;
        }
        ListLength | ListReverse | ListUnique => {
            nargs(1, 1)?;
            as_list(&mut a, 0, &DataType::Null)?;
        }
        ListContains | ListPosition => {
            nargs(2, 2)?;
            search_args(&mut a)?;
        }
        ListSlice => {
            nargs(2, 3)?;
            as_list(&mut a, 0, &DataType::Null)?;
            for i in 1..n {
                a[i] = cast_expr(a[i].clone(), &DataType::Int64)?;
            }
        }
        ListConcat => {
            nargs(1, usize::MAX)?;
            concat_args(&mut a)?;
        }
        ConcatList => {
            nargs(1, usize::MAX)?;
            for x in a.iter_mut() {
                let t = x.data_type();
                if !is_list(&t) && t != DataType::Null {
                    // a plain value is a one-element list
                    let dt = list_of(canonical_element(&t));
                    *x = PhysExpr::Function { func: ListValue, args: vec![x.clone()], dt };
                }
            }
            return concat_propagating(a);
        }
        ListSort => {
            nargs(1, 3)?;
            as_list(&mut a, 0, &DataType::Null)?;
            for i in 1..n {
                constant_text(&mut a, i, "list_sort order")?;
            }
        }
        ListDistinct => {
            nargs(1, 2)?;
            as_list(&mut a, 0, &DataType::Null)?;
            if n == 2 {
                constant_text(&mut a, 1, "list_distinct option")?;
            }
        }
        ArrayToString => {
            nargs(2, 3)?;
            as_list(&mut a, 0, &DataType::Utf8)?;
            for i in 1..n {
                a[i] = to_utf8(a[i].clone())?;
            }
        }
        ListAgg(_) => {
            nargs(1, 1)?;
            as_list(&mut a, 0, &DataType::Int64)?;
        }
        StringSplit => {
            nargs(2, 2)?;
            for x in a.iter_mut() {
                *x = to_utf8(x.clone())?;
            }
        }
        RegexpSplit => {
            nargs(2, 3)?;
            for x in a.iter_mut() {
                *x = to_utf8(x.clone())?;
            }
            for i in 1..n {
                constant_text(&mut a, i, "regexp_split_to_array pattern and flags")?;
            }
            if let PhysExpr::Literal(p) = &a[1] {
                let flags = match a.get(2) {
                    Some(PhysExpr::Literal(f)) => f.as_str().unwrap_or(""),
                    _ => "",
                };
                if let Some(p) = p.as_str() {
                    crate::physical::functions::pattern::compile(p, flags)?;
                }
            }
        }
        Unnest => {
            return Err(WhError::Plan(
                "unnest(..) is only valid in a SELECT list or as a table function (FROM t, unnest(t.col))".into(),
            ));
        }
        other => return Err(WhError::Plan(format!("{}: not a list function", names::name(other)))),
    }
    let types: Vec<DataType> = a.iter().map(|x| x.data_type()).collect();
    let dt = func.return_type(&types)?;
    Ok(PhysExpr::Function { func, args: a, dt })
}

/// Argument `i` must be a list; an untyped NULL becomes a list of `hint`.
fn as_list(a: &mut [PhysExpr], i: usize, hint: &DataType) -> Result<()> {
    let t = a[i].data_type();
    if t == DataType::Null {
        a[i] = cast_expr(a[i].clone(), &list_of(hint.clone()))?;
    } else if !is_list(&t) {
        return Err(WhError::Plan(format!("expected a list, got {t}")));
    }
    Ok(())
}

fn constant_text(a: &mut [PhysExpr], i: usize, what: &str) -> Result<()> {
    a[i] = to_utf8(a[i].clone())?;
    if !matches!(a[i], PhysExpr::Literal(_)) {
        return Err(WhError::NotSupported(format!("{what} must be a constant")));
    }
    Ok(())
}

/// `(list, needle)`: both are cast to a common element type.
fn search_args(a: &mut [PhysExpr]) -> Result<()> {
    let needle = a[1].data_type();
    as_list(a, 0, &needle)?;
    let elem = element_type(&a[0].data_type()).cloned().unwrap_or(DataType::Null);
    let common = comparison_common(&elem, &needle)
        .ok_or_else(|| WhError::Plan(format!("cannot search for {needle} in a list of {elem}")))?;
    let common = canonical_element(&common);
    if common != elem {
        a[0] = cast_expr(a[0].clone(), &list_of(common.clone()))?;
    }
    a[1] = cast_expr(a[1].clone(), &common)?;
    Ok(())
}

/// `l || r`: NULL when either side is (unlike `list_concat`, which skips NULLs).
pub fn concat_operator(l: PhysExpr, r: PhysExpr) -> Result<PhysExpr> {
    concat_propagating(vec![l, r])
}

fn concat_propagating(mut a: Vec<PhysExpr>) -> Result<PhysExpr> {
    concat_args(&mut a)?;
    let types: Vec<DataType> = a.iter().map(|x| x.data_type()).collect();
    let dt = ScalarFunc::ListConcat.return_type(&types)?;
    let is_null = |x: &PhysExpr| PhysExpr::IsNull(Box::new(x.clone()));
    let any_null = a[1..].iter().fold(is_null(&a[0]), |acc, x| PhysExpr::Binary {
        left: Box::new(acc),
        op: crate::expr::Operator::Or,
        right: Box::new(is_null(x)),
        dt: DataType::Boolean,
    });
    let joined = PhysExpr::Function { func: ScalarFunc::ListConcat, args: a, dt: dt.clone() };
    Ok(PhysExpr::Case {
        when_then: vec![(any_null, PhysExpr::Literal(crate::scalar::Scalar::null_of(&dt)))],
        otherwise: Some(Box::new(joined)),
        dt,
    })
}

/// All arguments are lists of one element type.
fn concat_args(a: &mut [PhysExpr]) -> Result<()> {
    let elems: Vec<DataType> =
        a.iter().filter_map(|x| element_type(&x.data_type()).cloned()).collect();
    let common = match elems.is_empty() {
        true => DataType::Null,
        false => canonical_element(
            &common_supertype(elems.iter())
                .ok_or_else(|| WhError::Plan(format!("list_concat: incompatible element types {elems:?}")))?,
        ),
    };
    for x in a.iter_mut() {
        if x.data_type() != DataType::Null && !is_list(&x.data_type()) {
            return Err(WhError::Plan(format!("list_concat expects lists, got {}", x.data_type())));
        }
        *x = cast_expr(x.clone(), &list_of(common.clone()))?;
    }
    Ok(())
}
