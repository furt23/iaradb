//! Evaluation of the P1 scalar functions (see `plan.rs` for the coercions).

use arrow::array::ArrayRef;

use super::{dates, math, parse, pattern, random, strings};
use crate::error::{Result, WhError};
use crate::expr::ScalarFunc::{self, *};
use crate::physical::expr::ColumnarValue;

fn const_str(v: &ColumnarValue) -> Result<String> {
    match v {
        ColumnarValue::Scalar(s) => s
            .as_str()
            .map(str::to_string)
            .ok_or_else(|| WhError::Execution("constant argument is NULL".into())),
        _ => Err(WhError::NotSupported("argument must be a constant".into())),
    }
}

pub fn eval(func: ScalarFunc, args: &[ColumnarValue], m: usize) -> Result<ArrayRef> {
    let arr = |i: usize| args[i].clone().into_array(m);
    Ok(match func {
        Sign => math::sign(&arr(0)?)?,
        IsNan => math::is_nan(&arr(0)?),
        Sin => math::unary(&arr(0)?, f64::sin),
        Cos => math::unary(&arr(0)?, f64::cos),
        Tan => math::unary(&arr(0)?, f64::tan),
        // out of range gives NaN (Polars, Spark); DuckDB raises an error
        Asin => math::unary(&arr(0)?, f64::asin),
        Acos => math::unary(&arr(0)?, f64::acos),
        Atan => math::unary(&arr(0)?, f64::atan),
        Degrees => math::unary(&arr(0)?, f64::to_degrees),
        Radians => math::unary(&arr(0)?, f64::to_radians),
        Atan2 => math::atan2(&arr(0)?, &arr(1)?)?,
        Pi => math::constant(std::f64::consts::PI, m),
        Random => random::random(args, m)?,
        DateAdd => dates::add_days(&arr(0)?, &arr(1)?, 1)?,
        DateSub => dates::add_days(&arr(0)?, &arr(1)?, -1)?,
        AddMonths => dates::add_months(&arr(0)?, &arr(1)?),
        DateDiff => dates::datediff(&const_str(&args[0])?, &arr(1)?, &arr(2)?),
        LastDay => dates::last_day(&arr(0)?)?,
        MonthStart => dates::month_edge(&arr(0)?, false)?,
        MonthEnd => dates::month_edge(&arr(0)?, true)?,
        MakeDate => dates::make_date(&arr(0)?, &arr(1)?, &arr(2)?),
        OffsetBy => dates::offset_by(&arr(0)?, &dates::Offset::parse(&const_str(&args[1])?)?)?,
        ToDate | StrictToDate => parse::to_date_fmt(&arr(0)?, &const_str(&args[1])?, func == StrictToDate)?,
        ToTimestamp | StrictToTimestamp => {
            parse::to_timestamp_fmt(&arr(0)?, &const_str(&args[1])?, func == StrictToTimestamp)?
        }
        Strftime => parse::strftime(&arr(0)?, &const_str(&args[1])?)?,
        LPad | RPad => strings::pad(&arr(0)?, &arr(1)?, &arr(2)?, func == LPad),
        ZFill => strings::zfill(&arr(0)?, &arr(1)?),
        SplitPart => strings::split_part(&arr(0)?, &arr(1)?, &arr(2)?),
        ConcatWs => strings::concat_ws(&(0..args.len()).map(arr).collect::<Result<Vec<_>>>()?, m),
        InitCap => strings::initcap(&arr(0)?),
        Repeat => strings::repeat(&arr(0)?, &arr(1)?),
        RegexpLike => pattern::like(args, m)?,
        RegexpCount => pattern::count(args, m)?,
        RegexpExtract => pattern::extract(args, m)?,
        RegexpReplace => pattern::replace(args, m)?,
        other if super::lists::names::is_list_func(other) => super::lists::eval(other, args, m)?,
        other => return Err(WhError::Execution(format!("{} is not a kernel function", other.name()))),
    })
}

