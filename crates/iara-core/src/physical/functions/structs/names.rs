//! Names and result types of the struct functions. `struct_pack(a := 1)` is
//! the logical call `StructPack('a', 1)`: field names are constant arguments
//! that come before their values, so the result type is computed from the
//! argument expressions ([`logical_type`]) and not from argument types alone.

use arrow::datatypes::DataType;

use crate::error::{Result, WhError};
use crate::expr::{Expr, ScalarFunc::{self, *}};
use crate::nested::{canonical_element, struct_fields, struct_of, type_name};
use crate::scalar::Scalar;
use crate::schema::PlanSchema;

pub fn is_struct_func(f: ScalarFunc) -> bool {
    matches!(f, StructPack | StructExtract | StructInsert | StructRename)
}

pub fn from_name(name: &str) -> Option<ScalarFunc> {
    Some(match name {
        "struct_pack" | "named_struct" | "row" | "struct" => StructPack,
        "struct_extract" | "struct_field" => StructExtract,
        "struct_insert" => StructInsert,
        "struct_rename" => StructRename,
        _ => return super::super::json::names::from_name(name),
    })
}

pub fn name(f: ScalarFunc) -> &'static str {
    match f {
        StructPack => "struct_pack",
        StructExtract => "struct_extract",
        StructInsert => "struct_insert",
        StructRename => "struct_rename",
        _ => super::super::json::names::name(f),
    }
}

/// A field name argument: a constant, non-NULL string.
pub fn field_name(arg: Option<&Scalar>, func: ScalarFunc) -> Result<String> {
    arg.and_then(|s| s.as_str())
        .map(str::to_string)
        .ok_or_else(|| WhError::Plan(format!("{}: field names must be constant strings", name(func))))
}

/// The type of a value stored in a struct field. A bare NULL keeps its type, so
/// `[{'x': 1}, {'x': NULL}]` unifies (as for list elements).
pub fn field_type(t: &DataType) -> DataType {
    canonical_element(t)
}

/// `StructPack(name1, v1, name2, v2, ..)`: the struct type of `names` and value `types`.
pub fn pack_type(func: ScalarFunc, names: Vec<String>, types: &[DataType]) -> Result<DataType> {
    for (i, n) in names.iter().enumerate() {
        if names[..i].iter().any(|m| m.eq_ignore_ascii_case(n)) {
            return Err(WhError::Plan(format!("{}: the field '{n}' appears twice", name(func))));
        }
    }
    Ok(struct_of(names.into_iter().zip(types.iter().map(field_type))))
}

/// Position of field `name` in `dt`: exact match first, then case-insensitive.
pub fn find_field(dt: &DataType, name: &str) -> Result<usize> {
    let fields = struct_fields(dt).ok_or_else(|| WhError::Plan(format!("expected a struct, got {}", type_name(dt))))?;
    let hit = fields.iter().position(|f| f.name() == name).or_else(|| {
        let mut ci = fields.iter().enumerate().filter(|(_, f)| f.name().eq_ignore_ascii_case(name));
        match (ci.next(), ci.next()) {
            (Some((i, _)), None) => Some(i),
            _ => None,
        }
    });
    hit.ok_or_else(|| {
        let known: Vec<&str> = fields.iter().map(|f| f.name().as_str()).collect();
        WhError::Plan(format!("struct has no field '{name}' (fields: {})", known.join(", ")))
    })
}

fn literal(e: &Expr) -> Option<&Scalar> {
    match e {
        Expr::Literal(s) => Some(s),
        Expr::Alias(inner, _) => literal(inner),
        _ => None,
    }
}

fn pairs_ok(func: ScalarFunc, args: &[Expr], from: usize) -> Result<()> {
    if args.len() < from || (args.len() - from) % 2 != 0 {
        return Err(WhError::Plan(format!("{} expects name, value pairs", name(func))));
    }
    Ok(())
}

/// The type of a struct function call, from the logical arguments.
pub fn logical_type(func: ScalarFunc, args: &[Expr], schema: &PlanSchema) -> Result<DataType> {
    let types = args.iter().map(|a| a.data_type(schema)).collect::<Result<Vec<_>>>()?;
    let names_at = |from: usize| -> Result<Vec<String>> {
        (from..args.len()).step_by(2).map(|i| field_name(args.get(i).and_then(literal), func)).collect()
    };
    match func {
        StructPack => {
            pairs_ok(func, args, 0)?;
            let values: Vec<DataType> = types.iter().skip(1).step_by(2).cloned().collect();
            pack_type(func, names_at(0)?, &values)
        }
        StructExtract => {
            let [s, n] = args else { return Err(WhError::Plan("struct_extract expects (struct, 'field')".into())) };
            let t = s.data_type(schema)?;
            let i = find_field(&t, &field_name(literal(n), func)?)?;
            Ok(struct_fields(&t).map(|f| f[i].data_type().clone()).unwrap_or(DataType::Null))
        }
        StructInsert => {
            pairs_ok(func, args, 1)?;
            insert_type(&types[0], names_at(1)?, types.iter().skip(2).step_by(2))
        }
        StructRename => {
            let new_names = (1..args.len()).map(|i| field_name(args.get(i).and_then(literal), func)).collect::<Result<Vec<_>>>()?;
            rename_type(&types[0], new_names)
        }
        other => Err(WhError::Plan(format!("{}: not a struct function", name(other)))),
    }
}

/// `struct_rename(s, names..)`: the fields of `base` under `names`.
pub fn rename_type(base: &DataType, names: Vec<String>) -> Result<DataType> {
    let fields = struct_fields(base)
        .ok_or_else(|| WhError::Plan(format!("struct_rename expects a struct, got {}", type_name(base))))?;
    if fields.len() != names.len() {
        return Err(WhError::Plan(format!("struct_rename: {} names for a struct of {} fields", names.len(), fields.len())));
    }
    pack_type(StructRename, names, &fields.iter().map(|f| f.data_type().clone()).collect::<Vec<_>>())
}

/// `struct_insert(s, name, value, ..)`: the fields of `s` followed by the new ones.
pub fn insert_type<'a>(base: &DataType, names: Vec<String>, values: impl Iterator<Item = &'a DataType>) -> Result<DataType> {
    let fields = struct_fields(base)
        .ok_or_else(|| WhError::Plan(format!("struct_insert expects a struct, got {}", type_name(base))))?;
    let mut all: Vec<(String, DataType)> = fields.iter().map(|f| (f.name().clone(), f.data_type().clone())).collect();
    for (n, t) in names.into_iter().zip(values) {
        if all.iter().any(|(m, _)| m.eq_ignore_ascii_case(&n)) {
            return Err(WhError::Plan(format!("struct_insert: the field '{n}' already exists")));
        }
        all.push((n, field_type(t)));
    }
    Ok(struct_of(all))
}
