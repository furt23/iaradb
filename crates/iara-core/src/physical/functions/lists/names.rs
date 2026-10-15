//! Names and result types of the list functions.

use arrow::datatypes::DataType;

use crate::error::{Result, WhError};
use crate::expr::{AggFunc, ScalarFunc::{self, *}};
use crate::nested::{canonical_element, element_type, is_list, list_of};
use crate::types::common_supertype;

pub fn is_list_func(f: ScalarFunc) -> bool {
    matches!(
        f,
        ListValue
            | ListExtract
            | ListLength
            | ListContains
            | ListPosition
            | ListSlice
            | ListConcat
            | ConcatList
            | ListSort
            | ListReverse
            | ListDistinct
            | ListUnique
            | ArrayToString
            | ListAgg(_)
            | StringSplit
            | RegexpSplit
            | Unnest
    )
}

pub fn from_name(name: &str) -> Option<ScalarFunc> {
    Some(match name {
        "list_value" | "list_pack" | "array_value" => ListValue,
        "list_extract" | "array_extract" | "list_element" | "array_element" => ListExtract,
        "array_length" | "list_length" | "cardinality" => ListLength,
        "list_contains" | "array_contains" | "list_has" | "array_has" => ListContains,
        "list_position" | "array_position" | "list_indexof" | "array_indexof" => ListPosition,
        "list_slice" | "array_slice" => ListSlice,
        "list_concat" | "list_cat" | "array_concat" | "array_cat" => ListConcat,
        "concat_list" => ConcatList,
        "list_sort" | "array_sort" => ListSort,
        "list_reverse" | "array_reverse" => ListReverse,
        "list_distinct" | "array_distinct" => ListDistinct,
        "list_unique" | "array_unique" => ListUnique,
        "array_to_string" | "list_to_string" | "array_join" | "list_join" => ArrayToString,
        "string_split" | "str_split" | "split" | "string_to_array" => StringSplit,
        "regexp_split_to_array" => RegexpSplit,
        "unnest" | "explode" => Unnest,
        _ => return list_agg(name).or_else(|| super::super::structs::names::from_name(name)),
    })
}

/// `list_sum`, `array_max`, ...: `list_` / `array_` followed by an aggregate.
fn list_agg(name: &str) -> Option<ScalarFunc> {
    let rest = name.strip_prefix("list_").or_else(|| name.strip_prefix("array_"))?;
    let agg = AggFunc::from_name(rest)?;
    (agg.arity() == 1 && !is_collecting(agg)).then_some(ListAgg(agg))
}

fn is_collecting(a: AggFunc) -> bool {
    matches!(a, AggFunc::ArrayAgg | AggFunc::CollectList | AggFunc::CollectSet)
}

/// The aggregate behind `list_aggr(l, 'name')`.
pub fn agg_by_name(name: &str) -> Result<AggFunc> {
    AggFunc::from_name(name)
        .filter(|a| a.arity() == 1 && !is_collecting(*a))
        .ok_or_else(|| WhError::Plan(format!("list_aggr: unknown aggregate '{name}'")))
}

pub fn name(f: ScalarFunc) -> &'static str {
    match f {
        ListValue => "list_value",
        ListExtract => "list_extract",
        ListLength => "array_length",
        ListContains => "list_contains",
        ListPosition => "list_position",
        ListSlice => "list_slice",
        ListConcat => "list_concat",
        ConcatList => "concat_list",
        ListSort => "list_sort",
        ListReverse => "list_reverse",
        ListDistinct => "list_distinct",
        ListUnique => "list_unique",
        ArrayToString => "array_to_string",
        ListAgg(a) => agg_display(a),
        StringSplit => "string_split",
        RegexpSplit => "regexp_split_to_array",
        Unnest => "unnest",
        _ => super::super::structs::names::name(f),
    }
}

fn agg_display(a: AggFunc) -> &'static str {
    use AggFunc::*;
    match a {
        Sum => "list_sum",
        Mean => "list_avg",
        Min => "list_min",
        Max => "list_max",
        Count => "list_count",
        Median => "list_median",
        Std => "list_stddev",
        Var => "list_variance",
        First => "list_first",
        Last => "list_last",
        Product => "list_product",
        BoolAnd => "list_bool_and",
        BoolOr => "list_bool_or",
        _ => "list_aggr",
    }
}

/// The list function a string function means when its first argument is a list.
pub fn list_variant(f: ScalarFunc, first: &DataType) -> Option<ScalarFunc> {
    if !is_list(first) {
        return None;
    }
    Some(match f {
        Length => ListLength,
        Reverse => ListReverse,
        Contains => ListContains,
        Concat => ListConcat,
        _ => return None,
    })
}

fn list_arg<'a>(f: ScalarFunc, args: &'a [DataType], i: usize) -> Result<&'a DataType> {
    let t = args.get(i).ok_or_else(|| WhError::Plan(format!("{}: missing argument {}", name(f), i + 1)))?;
    if is_list(t) || *t == DataType::Null {
        Ok(t)
    } else {
        Err(WhError::Plan(format!("{} expects a list as argument {}, got {t}", name(f), i + 1)))
    }
}

pub fn return_type(f: ScalarFunc, args: &[DataType]) -> Result<DataType> {
    let first = || list_arg(f, args, 0);
    Ok(match f {
        ListValue => list_of(canonical_element(&common_supertype(args.iter()).unwrap_or(DataType::Null))),
        ListExtract => element_type(first()?).cloned().unwrap_or(DataType::Null),
        ListLength | ListPosition | ListUnique => DataType::Int64,
        ListContains => DataType::Boolean,
        ListSlice | ListSort | ListReverse | ListDistinct => first()?.clone(),
        ListConcat | ConcatList => {
            let elems: Vec<DataType> =
                args.iter().filter(|t| **t != DataType::Null).map(|t| element_type(t).unwrap_or(t).clone()).collect();
            list_of(canonical_element(&common_supertype(elems.iter()).unwrap_or(DataType::Null)))
        }
        ArrayToString => DataType::Utf8,
        ListAgg(a) => a.return_type(&[element_type(first()?).cloned().unwrap_or(DataType::Null)])?,
        StringSplit | RegexpSplit => list_of(DataType::Utf8),
        Unnest => element_type(first()?).cloned().unwrap_or(DataType::Null),
        other => return super::super::json::names::return_type(other, args),
    })
}
