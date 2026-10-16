//! Struct functions: `struct_pack`, `struct_extract` (`s.field`, `s['field']`),
//! `struct_insert`. Field names are constant arguments (see `names.rs`).

mod build;
pub mod names;
pub mod plan;

use arrow::array::ArrayRef;
use arrow::datatypes::DataType;

use crate::error::{Result, WhError};
use crate::expr::ScalarFunc::{self, *};
use crate::physical::expr::ColumnarValue;

/// The constant string argument `i`.
fn const_name(args: &[ColumnarValue], i: usize) -> Result<String> {
    match args.get(i) {
        Some(ColumnarValue::Scalar(s)) => s
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| WhError::Execution("struct field name is NULL".into())),
        _ => Err(WhError::NotSupported("struct field names must be constants".into())),
    }
}

pub fn eval(func: ScalarFunc, args: &[ColumnarValue], m: usize, dt: &DataType) -> Result<ArrayRef> {
    let arr = |i: usize| args[i].clone().into_array(m);
    match func {
        StructPack => {
            let values = (1..args.len()).step_by(2).map(arr).collect::<Result<Vec<_>>>()?;
            build::pack(dt, values, m)
        }
        StructExtract => build::extract(&arr(0)?, &const_name(args, 1)?),
        StructInsert => {
            let values = (2..args.len()).step_by(2).map(arr).collect::<Result<Vec<_>>>()?;
            build::insert(&arr(0)?, dt, values)
        }
        StructRename => build::rename(&arr(0)?, dt),
        other => Err(WhError::Execution(format!("{} is not a struct kernel", other.name()))),
    }
}
