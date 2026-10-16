//! Kernels of the list functions (see `plan.rs` for the coercions, `names.rs`
//! for the names and result types). A list argument is always a canonical
//! `List<item>` array here.

mod access;
mod build;
mod gather;
pub mod names;
mod order;
pub mod plan;
mod reduce;
mod search;
mod split;

use arrow::array::ArrayRef;

use crate::error::{Result, WhError};
use crate::expr::ScalarFunc::{self, *};
use crate::physical::expr::ColumnarValue;

/// A constant string argument (`None` when absent or NULL).
fn const_str(args: &[ColumnarValue], i: usize) -> Result<Option<String>> {
    match args.get(i) {
        None => Ok(None),
        Some(ColumnarValue::Scalar(s)) => Ok(s.as_str().map(str::to_string)),
        Some(_) => Err(WhError::NotSupported("this argument must be a constant".into())),
    }
}

pub fn eval(func: ScalarFunc, args: &[ColumnarValue], m: usize) -> Result<ArrayRef> {
    let arr = |i: usize| args[i].clone().into_array(m);
    match func {
        ListValue => build::list_value(&(0..args.len()).map(arr).collect::<Result<Vec<_>>>()?, m),
        ListExtract => access::extract(&arr(0)?, &arr(1)?),
        ListLength => access::length(&arr(0)?),
        ListSlice => access::slice(&arr(0)?, &arr(1)?, args.get(2).map(|_| arr(2)).transpose()?.as_ref()),
        ListContains => search::contains(&arr(0)?, &arr(1)?),
        ListPosition => search::position(&arr(0)?, &arr(1)?),
        ListConcat => build::concat(&(0..args.len()).map(arr).collect::<Result<Vec<_>>>()?),
        ListReverse => build::reverse(&arr(0)?),
        ListSort => order::sort(&arr(0)?, const_str(args, 1)?.as_deref(), const_str(args, 2)?.as_deref()),
        ListDistinct => order::distinct(&arr(0)?, const_str(args, 1)?.as_deref() == Some("keep_nulls")),
        ListUnique => order::unique(&arr(0)?),
        ArrayToString => reduce::join(&arr(0)?, &arr(1)?, args.get(2).map(|_| arr(2)).transpose()?.as_ref()),
        ListAgg(agg) => reduce::aggregate(&arr(0)?, agg),
        StringSplit => split::string_split(&arr(0)?, &args[1], m),
        RegexpSplit => split::regexp_split(&arr(0)?, args),
        other => Err(WhError::Execution(format!("{} is not a list kernel", other.name()))),
    }
}
