//! Read options of CSV and JSON files: a `{name: value}` object whose names
//! the engine's `set_option` knows (`quote_char`, `null_values`, `skip_rows`,
//! `schema_overrides`, `format`, ...).

use std::collections::HashMap;

use napi::{JsValue, ValueType};
use napi::bindgen_prelude::{Array, Unknown};

use iara_core::io::csv::CsvOptions;
use iara_core::io::csv::args::OptValue;
use iara_core::io::json::JsonOptions;

use crate::error::{Result, ResExt, invalid};

pub type Dict<'a> = HashMap<String, Unknown<'a>>;

fn text(v: Unknown<'_>) -> Result<String> {
    v.coerce_to_string().and_then(|s| s.into_utf8()).and_then(|s| s.into_owned()).js()
}

fn opt_value(v: Unknown<'_>) -> Result<OptValue> {
    // SAFETY (all casts): the value's type was just checked
    Ok(match v.get_type().js()? {
        ValueType::Boolean => OptValue::Bool(unsafe { v.cast::<bool>() }.js()?),
        ValueType::String => OptValue::Text(unsafe { v.cast::<String>() }.js()?),
        ValueType::Number => OptValue::Number(unsafe { v.cast::<f64>() }.js()?),
        ValueType::Object if v.is_array().js()? => {
            let a = unsafe { v.cast::<Array>() }.js()?;
            let mut items = vec![];
            for i in 0..a.len() {
                items.push(text(a.get::<Unknown>(i).js()?.ok_or_else(|| invalid("unsupported option value"))?)?);
            }
            OptValue::List(items)
        }
        ValueType::Object => {
            let o = unsafe { v.cast::<HashMap<String, Unknown>>() }.js()?;
            OptValue::Map(o.into_iter().map(|(k, t)| Ok((k, text(t)?))).collect::<Result<_>>()?)
        }
        t => return Err(invalid(format!("unsupported option value of type {t}"))),
    })
}

/// Apply every non-null entry of `options` with `set`; unknown names are errors.
fn apply(options: Option<Dict<'_>>, kind: &str, mut set: impl FnMut(&str, &OptValue) -> iara_core::error::Result<bool>) -> Result<()> {
    for (key, v) in options.into_iter().flatten() {
        if matches!(v.get_type().js()?, ValueType::Null | ValueType::Undefined) {
            continue;
        }
        if !set(&key, &opt_value(v)?).js()? {
            return Err(invalid(format!("unknown {kind} option '{key}'")));
        }
    }
    Ok(())
}

pub fn csv_options(options: Option<Dict<'_>>, mut base: CsvOptions) -> Result<CsvOptions> {
    apply(options, "CSV", |k, v| base.set_option(k, v))?;
    Ok(base)
}

pub fn json_options(options: Option<Dict<'_>>) -> Result<JsonOptions> {
    let mut o = JsonOptions::default();
    apply(options, "JSON", |k, v| o.set_option(k, v))?;
    Ok(o)
}
