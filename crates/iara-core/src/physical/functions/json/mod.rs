//! JSON functions on text: `json_extract` (`->`), `json_extract_string`
//! (`->>`), `json_array_length`, `to_json` and `from_json`.

mod lookup;
pub mod names;
mod path;
pub mod plan;

use arrow::array::ArrayRef;
use arrow::datatypes::DataType;

use crate::error::{Result, WhError};
use crate::expr::ScalarFunc::{self, *};
use crate::physical::expr::ColumnarValue;

/// The constant path argument `i`, parsed (the root when absent).
fn steps(args: &[ColumnarValue], i: usize) -> Result<Vec<path::Step>> {
    match args.get(i) {
        None => Ok(vec![]),
        Some(ColumnarValue::Scalar(s)) => plan::steps_of(&crate::physical::expr::PhysExpr::Literal(s.clone())),
        Some(_) => Err(WhError::NotSupported("a JSON path must be a constant".into())),
    }
}

pub fn eval(func: ScalarFunc, args: &[ColumnarValue], m: usize, dt: &DataType) -> Result<ArrayRef> {
    let text = args[0].clone().into_array(m)?;
    match func {
        JsonExtract => lookup::extract(&text, &steps(args, 1)?),
        JsonExtractString => lookup::extract_string(&text, &steps(args, 1)?),
        JsonArrayLength => lookup::array_length(&text, &steps(args, 1)?),
        ToJson => Ok(std::sync::Arc::new(crate::io::json::json_text(&text)?)),
        FromJson => crate::io::json::decode_json(&text, dt),
        other => Err(WhError::Execution(format!("{} is not a JSON kernel", other.name()))),
    }
}
