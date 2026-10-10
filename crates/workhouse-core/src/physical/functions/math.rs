//! sign and isnan.

use std::sync::Arc;

use arrow::array::*;
use arrow::datatypes::*;

use crate::error::{Result, WhError};

macro_rules! signed {
    ($a:expr, $t:ty) => {
        Arc::new($a.as_primitive::<$t>().unary::<_, $t>(|v| v.signum())) as ArrayRef
    };
}

macro_rules! unsigned {
    ($a:expr, $t:ty) => {
        Arc::new($a.as_primitive::<$t>().unary::<_, $t>(|v| (v > 0) as _)) as ArrayRef
    };
}

macro_rules! float {
    ($a:expr, $t:ty) => {
        // 0 stays 0 and NaN stays NaN (Polars)
        Arc::new($a.as_primitive::<$t>().unary::<_, $t>(|v| if v > 0.0 { 1.0 } else if v < 0.0 { -1.0 } else { v }))
            as ArrayRef
    };
}

/// Same type as the input (Polars); DuckDB returns TINYINT but the values match.
pub fn sign(a: &ArrayRef) -> Result<ArrayRef> {
    Ok(match a.data_type() {
        DataType::Int8 => signed!(a, Int8Type),
        DataType::Int16 => signed!(a, Int16Type),
        DataType::Int32 => signed!(a, Int32Type),
        DataType::Int64 => signed!(a, Int64Type),
        DataType::UInt8 => unsigned!(a, UInt8Type),
        DataType::UInt16 => unsigned!(a, UInt16Type),
        DataType::UInt32 => unsigned!(a, UInt32Type),
        DataType::UInt64 => unsigned!(a, UInt64Type),
        DataType::Float32 => float!(a, Float32Type),
        DataType::Float64 => float!(a, Float64Type),
        t => return Err(WhError::Execution(format!("sign not supported for {t}"))),
    })
}

/// NULL in, NULL out (DuckDB, Polars); Spark returns false for NULL.
pub fn is_nan(a: &ArrayRef) -> ArrayRef {
    Arc::new(BooleanArray::from_unary(a.as_primitive::<Float64Type>(), |v| v.is_nan()))
}

/// Apply `f` to a Float64 array (NULL stays NULL).
pub fn unary(a: &ArrayRef, f: impl Fn(f64) -> f64) -> ArrayRef {
    Arc::new(a.as_primitive::<Float64Type>().unary::<_, Float64Type>(f))
}

/// `atan2(y, x)`.
pub fn atan2(y: &ArrayRef, x: &ArrayRef) -> Result<ArrayRef> {
    let out = arrow::compute::kernels::arity::binary::<_, _, _, Float64Type>(
        y.as_primitive::<Float64Type>(),
        x.as_primitive::<Float64Type>(),
        |y, x| y.atan2(x),
    )?;
    Ok(Arc::new(out))
}

/// `m` copies of a constant.
pub fn constant(v: f64, m: usize) -> ArrayRef {
    Arc::new(Float64Array::from(vec![v; m]))
}
