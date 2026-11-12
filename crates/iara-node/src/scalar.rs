//! JS values -> scalars, and SQL parameters.

use std::collections::HashMap;
use std::sync::Arc;

use napi::{JsValue, ValueType};
use napi::bindgen_prelude::{Array, BigInt, Date, Uint8Array, Unknown};

use iara_core::{Params, Scalar};

use crate::error::{Result, ResExt, invalid};

/// 2^53: the integers a JS number holds exactly.
const MAX_SAFE: f64 = 9_007_199_254_740_992.0;

pub fn scalar(v: Unknown<'_>) -> Result<Scalar> {
    // SAFETY (all casts): the value's type was just checked
    match v.get_type().js()? {
        ValueType::Null | ValueType::Undefined => Ok(Scalar::null()),
        ValueType::Boolean => Ok(Scalar::boolean(unsafe { v.cast::<bool>() }.js()?)),
        ValueType::Number => {
            let n = unsafe { v.cast::<f64>() }.js()?;
            Ok(if n.fract() == 0.0 && n.abs() <= MAX_SAFE { Scalar::int64(n as i64) } else { Scalar::float64(n) })
        }
        ValueType::BigInt => {
            let b = unsafe { v.cast::<BigInt>() }.js()?;
            if let (i, true) = b.get_i64() {
                return Ok(Scalar::int64(i));
            }
            match b.get_u64() {
                (false, u, true) => Ok(Scalar::uint64(u)),
                _ => Err(invalid("BigInt out of the range of int64 and uint64")),
            }
        }
        ValueType::String => Ok(Scalar::utf8(&unsafe { v.cast::<String>() }.js()?)),
        ValueType::Object if v.is_date().js()? => {
            let ms = unsafe { v.cast::<Date>() }.js()?.value_of().js()?;
            if ms.is_nan() {
                return Err(invalid("invalid Date"));
            }
            Ok(Scalar::timestamp_us(ms as i64 * 1000, Some("UTC".into())))
        }
        ValueType::Object if v.is_typedarray().js()? => {
            let bytes = unsafe { v.cast::<Uint8Array>() }.js()?;
            Ok(Scalar::new(Arc::new(arrow::array::BinaryArray::from_vec(vec![&bytes[..]]))))
        }
        t => Err(invalid(format!("cannot convert a JS value of type {t} to a literal"))),
    }
}

/// SQL parameters: an array (positional), a plain object (named) or nothing.
pub fn sql_params(obj: Option<Unknown<'_>>) -> Result<Params> {
    let Some(v) = obj else { return Ok(Params::None) };
    // SAFETY (all casts): the value's type was just checked
    match v.get_type().js()? {
        ValueType::Null | ValueType::Undefined => Ok(Params::None),
        ValueType::Object if v.is_array().js()? => {
            let a = unsafe { v.cast::<Array>() }.js()?;
            let mut values = vec![];
            for i in 0..a.len() {
                let item = a.get::<Unknown>(i).js()?.ok_or_else(|| invalid(format!("parameter {}: missing", i + 1)))?;
                values.push(scalar(item).map_err(|e| invalid(format!("parameter {}: {}", i + 1, e.reason)))?);
            }
            Ok(Params::Positional(values))
        }
        ValueType::Object if !v.is_date().js()? && !v.is_typedarray().js()? => {
            let o = unsafe { v.cast::<HashMap<String, Unknown>>() }.js()?;
            let mut map = HashMap::new();
            for (key, value) in o {
                let s = scalar(value).map_err(|e| invalid(format!("parameter '{key}': {}", e.reason)))?;
                map.insert(key, s);
            }
            Ok(Params::Named(map))
        }
        _ => Err(invalid("SQL parameters must be an array or a plain object")),
    }
}
