//! JSON text into typed values (`from_json(text, type)`, Python `json_decode`).
//! The text is read into the JSON-native types (booleans, Int64, Float64,
//! strings, lists, structs) and cast to the requested ones.

use arrow::array::{Array, ArrayRef, AsArray};
use arrow::compute::{CastOptions, cast_with_options};
use arrow::datatypes::DataType;

use super::build::Column;
use super::parse::Parser;
use crate::error::{Result, WhError};
use crate::nested::{element_type, list_of, struct_fields, struct_of};

/// The type JSON text is read as before it is cast to `dt`.
fn native(dt: &DataType) -> DataType {
    if let Some(elem) = element_type(dt) {
        return list_of(native(elem));
    }
    match dt {
        DataType::Boolean | DataType::Utf8 | DataType::Int64 | DataType::Float64 => dt.clone(),
        t if t.is_integer() => DataType::Int64,
        DataType::Float16 | DataType::Float32 => DataType::Float64,
        DataType::Struct(fields) => struct_of(fields.iter().map(|f| (f.name().clone(), native(f.data_type())))),
        // dates, timestamps, decimals, ...: read as text, cast from it
        _ => DataType::Utf8,
    }
}

/// Parse each JSON text of `texts` (a Utf8 array) as a value of type `dt`; NULL stays NULL.
pub fn decode_json(texts: &ArrayRef, dt: &DataType) -> Result<ArrayRef> {
    if struct_fields(dt).is_some_and(|f| f.is_empty()) {
        return Err(WhError::Plan("from_json: a struct type needs fields".into()));
    }
    let strings = texts.as_string::<i32>();
    let mut column = Column::new(&native(dt))?;
    for i in 0..strings.len() {
        if strings.is_null(i) {
            column.push(None, "json")?;
            continue;
        }
        let value = Parser::whole(strings.value(i).trim())?;
        column.push(Some(&value), "json")?;
    }
    let parsed = column.finish()?;
    let opts = CastOptions { safe: false, ..Default::default() };
    Ok(cast_with_options(&parsed, dt, &opts)?)
}
