//! Names and result types of the JSON functions. `from_json(text, 'type')`
//! has the type its constant second argument names, so its result type is
//! computed from the argument expressions ([`logical_type`]).

use arrow::datatypes::DataType;

use crate::error::{Result, WhError};
use crate::expr::{Expr, ScalarFunc::{self, *}};
use crate::types::parse_data_type;

pub fn is_json_func(f: ScalarFunc) -> bool {
    matches!(f, JsonExtract | JsonExtractString | JsonArrayLength | ToJson | FromJson)
}

pub fn from_name(name: &str) -> Option<ScalarFunc> {
    Some(match name {
        "json_extract" => JsonExtract,
        "json_extract_string" | "json_value" => JsonExtractString,
        "json_array_length" => JsonArrayLength,
        "to_json" | "json_encode" => ToJson,
        "from_json" | "json_decode" | "json_transform" => FromJson,
        _ => return None,
    })
}

pub fn name(f: ScalarFunc) -> &'static str {
    match f {
        JsonExtract => "json_extract",
        JsonExtractString => "json_extract_string",
        JsonArrayLength => "json_array_length",
        ToJson => "to_json",
        FromJson => "from_json",
        _ => "?",
    }
}

pub fn return_type(f: ScalarFunc, _args: &[DataType]) -> Result<DataType> {
    match f {
        JsonExtract | JsonExtractString | ToJson => Ok(DataType::Utf8),
        JsonArrayLength => Ok(DataType::Int64),
        other => Err(WhError::Plan(format!("{}: the result type depends on a constant argument", name(other)))),
    }
}

/// The type a `from_json(text, 'type')` call returns.
pub fn decoded_type(type_name: Option<&str>) -> Result<DataType> {
    let t = type_name.ok_or_else(|| WhError::Plan("from_json expects the type as a constant string, e.g. 'STRUCT(a INT)'".into()))?;
    parse_data_type(t)
}

/// Types that come from constant arguments, so they need the argument expressions.
pub fn logical_type(f: ScalarFunc, args: &[Expr]) -> Result<DataType> {
    match (f, args) {
        (FromJson, [_, Expr::Literal(t)]) => decoded_type(t.as_str()),
        (FromJson, _) => decoded_type(None),
        _ => Err(WhError::Plan(format!("{}: not a typed JSON function", name(f)))),
    }
}
