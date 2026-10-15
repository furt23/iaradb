//! Read options of CSV and JSON files from Python: a `{name: value}` dict
//! whose names the engine's `set_option` knows (`quote_char`, `null_values`,
//! `skip_rows`, `schema_overrides`, `format`, ...).

use pyo3::exceptions::PyValueError;
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyDict, PyFloat, PyInt, PyList, PyString, PyTuple};

use iara_core::io::csv::CsvOptions;
use iara_core::io::csv::args::OptValue;
use iara_core::io::json::JsonOptions;

use crate::PyResultExt;

fn opt_value(v: &Bound<'_, PyAny>) -> PyResult<OptValue> {
    if v.is_instance_of::<PyBool>() {
        return Ok(OptValue::Bool(v.extract()?));
    }
    if v.is_instance_of::<PyString>() {
        return Ok(OptValue::Text(v.extract()?));
    }
    if v.is_instance_of::<PyInt>() || v.is_instance_of::<PyFloat>() {
        return Ok(OptValue::Number(v.extract()?));
    }
    if v.is_instance_of::<PyList>() || v.is_instance_of::<PyTuple>() {
        return Ok(OptValue::List(v.try_iter()?.map(|x| x?.str().map(|s| s.to_string())).collect::<PyResult<_>>()?));
    }
    if let Ok(d) = v.cast::<PyDict>() {
        let pairs = d.iter().map(|(k, t)| Ok((k.str()?.to_string(), t.str()?.to_string()))).collect::<PyResult<_>>()?;
        return Ok(OptValue::Map(pairs));
    }
    Err(PyValueError::new_err(format!("unsupported option value {v}")))
}

/// Apply every non-None entry of `options` with `set`; unknown names are errors.
fn apply(options: Option<&Bound<'_, PyDict>>, kind: &str, mut set: impl FnMut(&str, &OptValue) -> iara_core::error::Result<bool>) -> PyResult<()> {
    for (k, v) in options.into_iter().flat_map(|d| d.iter()) {
        if v.is_none() {
            continue;
        }
        let key: String = k.extract()?;
        if !set(&key, &opt_value(&v)?).py()? {
            return Err(PyValueError::new_err(format!("unknown {kind} option '{key}'")));
        }
    }
    Ok(())
}

pub fn csv_options(options: Option<&Bound<'_, PyDict>>, mut base: CsvOptions) -> PyResult<CsvOptions> {
    apply(options, "CSV", |k, v| base.set_option(k, v))?;
    Ok(base)
}

pub fn json_options(options: Option<&Bound<'_, PyDict>>) -> PyResult<JsonOptions> {
    let mut o = JsonOptions::default();
    apply(options, "JSON", |k, v| o.set_option(k, v))?;
    Ok(o)
}
