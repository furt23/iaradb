//! Scalar values. A scalar is represented as a length-1 Arrow array, which
//! lets every Arrow type be a literal and lets kernels consume literals as
//! `Datum`s without any conversion.

use std::fmt;
use std::sync::Arc;

use arrow::array::*;
use arrow::compute::{CastOptions, cast_with_options};
use arrow::datatypes::*;
use arrow::util::display::{ArrayFormatter, FormatOptions};

use crate::error::Result;

#[derive(Clone)]
pub struct Scalar(ArrayRef);

impl Scalar {
    pub fn new(array: ArrayRef) -> Self {
        debug_assert_eq!(array.len(), 1);
        Self(array)
    }

    /// Copy the value at `idx` out of `array` (does not keep the source buffers alive).
    pub fn from_array(array: &dyn Array, idx: usize) -> Result<Self> {
        let indices = UInt32Array::from(vec![idx as u32]);
        Ok(Self(arrow::compute::take(array, &indices, None)?))
    }

    pub fn null() -> Self {
        Self(Arc::new(NullArray::new(1)))
    }
    pub fn null_of(dt: &DataType) -> Self {
        Self(new_null_array(dt, 1))
    }
    pub fn boolean(v: bool) -> Self {
        Self(Arc::new(BooleanArray::from(vec![v])))
    }
    pub fn int64(v: i64) -> Self {
        Self(Arc::new(Int64Array::from(vec![v])))
    }
    pub fn uint64(v: u64) -> Self {
        Self(Arc::new(UInt64Array::from(vec![v])))
    }
    pub fn float64(v: f64) -> Self {
        Self(Arc::new(Float64Array::from(vec![v])))
    }
    pub fn utf8(v: &str) -> Self {
        Self(Arc::new(StringArray::from(vec![v])))
    }
    pub fn date32(days: i32) -> Self {
        Self(Arc::new(Date32Array::from(vec![days])))
    }
    pub fn timestamp_us(v: i64, tz: Option<Arc<str>>) -> Self {
        Self(Arc::new(TimestampMicrosecondArray::from(vec![v]).with_timezone_opt(tz)))
    }
    pub fn decimal128(v: i128, precision: u8, scale: i8) -> Result<Self> {
        Ok(Self(Arc::new(
            Decimal128Array::from(vec![v]).with_precision_and_scale(precision, scale)?,
        )))
    }
    pub fn interval_mdn(months: i32, days: i32, nanos: i64) -> Self {
        Self(Arc::new(IntervalMonthDayNanoArray::from(vec![
            IntervalMonthDayNano::new(months, days, nanos),
        ])))
    }

    pub fn array(&self) -> &ArrayRef {
        &self.0
    }
    pub fn data_type(&self) -> &DataType {
        self.0.data_type()
    }
    pub fn is_null(&self) -> bool {
        self.0.data_type() == &DataType::Null || self.0.is_null(0)
    }

    pub fn cast_to(&self, dt: &DataType) -> Result<Scalar> {
        if self.data_type() == dt {
            return Ok(self.clone());
        }
        let opts = CastOptions { safe: false, ..Default::default() };
        Ok(Scalar(crate::types::cast_array(&self.0, dt, &opts)?))
    }

    /// Cast that only succeeds when the value round-trips exactly.
    pub fn cast_exact(&self, dt: &DataType) -> Option<Scalar> {
        if self.is_null() {
            return Some(Scalar::null_of(dt));
        }
        let casted = self.cast_to(dt).ok()?;
        if casted.is_null() {
            return None;
        }
        let back = casted.cast_to(self.data_type()).ok()?;
        if back.0.to_data() == self.0.to_data() { Some(casted) } else { None }
    }

    /// Broadcast to an array of `n` rows.
    pub fn to_array(&self, n: usize) -> Result<ArrayRef> {
        if n == 1 {
            return Ok(self.0.clone());
        }
        if self.0.data_type() == &DataType::Null {
            return Ok(Arc::new(NullArray::new(n)));
        }
        let indices = UInt32Array::from(vec![0u32; n]);
        Ok(arrow::compute::take(&self.0, &indices, None)?)
    }

    pub fn as_bool(&self) -> Option<bool> {
        if self.is_null() {
            return None;
        }
        self.0.as_boolean_opt().map(|a| a.value(0))
    }
    pub fn as_i64(&self) -> Option<i64> {
        if self.is_null() || !self.data_type().is_integer() {
            return None;
        }
        let c = cast_with_options(&self.0, &DataType::Int64, &CastOptions::default()).ok()?;
        let c = c.as_primitive::<Int64Type>();
        if c.is_null(0) { None } else { Some(c.value(0)) }
    }
    pub fn as_f64(&self) -> Option<f64> {
        if self.is_null() || !self.data_type().is_numeric() {
            return None;
        }
        let c = cast_with_options(&self.0, &DataType::Float64, &CastOptions::default()).ok()?;
        let c = c.as_primitive::<Float64Type>();
        if c.is_null(0) { None } else { Some(c.value(0)) }
    }
    pub fn as_str(&self) -> Option<&str> {
        if self.is_null() {
            return None;
        }
        match self.data_type() {
            DataType::Utf8 => Some(self.0.as_string::<i32>().value(0)),
            DataType::LargeUtf8 => Some(self.0.as_string::<i64>().value(0)),
            DataType::Utf8View => Some(self.0.as_string_view().value(0)),
            _ => None,
        }
    }
}

impl Datum for Scalar {
    fn get(&self) -> (&dyn Array, bool) {
        (self.0.as_ref(), true)
    }
}

impl PartialEq for Scalar {
    fn eq(&self, other: &Self) -> bool {
        self.0.data_type() == other.0.data_type() && self.0.to_data() == other.0.to_data()
    }
}

impl fmt::Display for Scalar {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.is_null() {
            return write!(f, "NULL");
        }
        let opts = FormatOptions::default();
        let value = match ArrayFormatter::try_new(self.0.as_ref(), &opts) {
            Ok(fmt) => fmt.value(0).to_string(),
            Err(_) => "?".to_string(),
        };
        match self.data_type() {
            DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View => {
                write!(f, "'{}'", value.replace('\'', "''"))
            }
            DataType::Date32 | DataType::Date64 => write!(f, "DATE '{value}'"),
            DataType::Timestamp(_, _) => write!(f, "TIMESTAMP '{value}'"),
            DataType::Interval(_) => write!(f, "INTERVAL '{value}'"),
            _ => write!(f, "{value}"),
        }
    }
}

impl fmt::Debug for Scalar {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}::{}", self, self.data_type())
    }
}
