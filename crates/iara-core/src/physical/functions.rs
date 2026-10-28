//! Scalar function kernels.

use std::sync::Arc;

use arrow::array::*;
use arrow::buffer::Buffer;
use arrow::compute::kernels::{cmp, zip::zip};
use arrow::compute::{DatePart, date_part, is_not_null, nullif};
use arrow::datatypes::*;
use chrono::{Datelike, NaiveDate, NaiveDateTime, Timelike};

use crate::error::{Result, WhError};
use crate::expr::ScalarFunc;
use crate::physical::expr::ColumnarValue;
use crate::scalar::Scalar;

mod dates;
mod eval;
pub mod json;
pub mod lists;
mod math;
pub mod names;
mod parse;
mod pattern;
pub mod plan;
mod random;
mod strings;
pub mod structs;
mod time;

pub fn evaluate(func: ScalarFunc, args: &[ColumnarValue], n: usize, dt: &DataType) -> Result<ColumnarValue> {
    // random() yields one value per row even without column arguments
    let all_scalar = func != ScalarFunc::Random && args.iter().all(|a| a.is_scalar());
    let m = if all_scalar { 1 } else { n };
    let res = eval_arrays(func, args, m, dt)?;
    Ok(if all_scalar && res.len() == 1 {
        ColumnarValue::Scalar(Scalar::new(res))
    } else {
        ColumnarValue::Array(res)
    })
}

fn scalar_i64(v: &ColumnarValue, what: &str) -> Result<Option<i64>> {
    match v {
        ColumnarValue::Scalar(s) => Ok(s.as_i64()),
        _ => Err(WhError::NotSupported(format!("{what} must be a constant"))),
    }
}

fn unary_f64(a: &ArrayRef, f: impl Fn(f64) -> f64) -> ArrayRef {
    let p = a.as_primitive::<Float64Type>();
    Arc::new(p.unary::<_, Float64Type>(f))
}

fn case_map(a: &StringArray, upper: bool) -> ArrayRef {
    let data = a.value_data();
    if data.is_ascii() {
        let mapped: Vec<u8> = if upper {
            data.iter().map(|b| b.to_ascii_uppercase()).collect()
        } else {
            data.iter().map(|b| b.to_ascii_lowercase()).collect()
        };
        // SAFETY: ASCII case mapping preserves byte lengths and UTF-8 validity
        unsafe {
            Arc::new(StringArray::new_unchecked(a.offsets().clone(), Buffer::from_vec(mapped), a.nulls().cloned()))
        }
    } else {
        Arc::new(
            a.iter()
                .map(|o| o.map(|s| if upper { s.to_uppercase() } else { s.to_lowercase() }))
                .collect::<StringArray>(),
        )
    }
}

fn map_str(a: &StringArray, f: impl Fn(&str) -> Option<String>) -> ArrayRef {
    let mut b = StringBuilder::with_capacity(a.len(), a.value_data().len());
    for v in a.iter() {
        match v.and_then(&f) {
            Some(s) => b.append_value(s),
            None => b.append_null(),
        }
    }
    Arc::new(b.finish())
}

fn map_str_ref<'a>(a: &'a StringArray, f: impl Fn(&'a str) -> &'a str) -> ArrayRef {
    let mut b = StringBuilder::with_capacity(a.len(), a.value_data().len());
    for v in a.iter() {
        match v {
            Some(s) => b.append_value(f(s)),
            None => b.append_null(),
        }
    }
    Arc::new(b.finish())
}

fn substr_chars(s: &str, start: i64, len: Option<i64>) -> &str {
    // SQL semantics: 1-based start, may be <= 0
    let (begin, count) = if start < 1 {
        let c = len.map(|l| (l + start - 1).max(0));
        (0usize, c)
    } else {
        ((start - 1) as usize, len.map(|l| l.max(0)))
    };
    if s.is_ascii() {
        let b0 = begin.min(s.len());
        let end = count.map_or(s.len(), |c| b0.saturating_add(c as usize).min(s.len()));
        return &s[b0..end];
    }
    let mut it = s.char_indices().skip(begin);
    let Some((b0, _)) = it.next() else { return "" };
    match count {
        None => &s[b0..],
        Some(0) => "",
        Some(c) => {
            let mut end = s.len();
            let mut taken = 1;
            for (bi, _) in it {
                if taken == c as usize {
                    end = bi;
                    break;
                }
                taken += 1;
            }
            &s[b0..end]
        }
    }
}

fn date_trunc_days(days: i32, unit: &str) -> Result<i32> {
    let d = NaiveDate::from_num_days_from_ce_opt(days + 719_163)
        .ok_or_else(|| WhError::Execution("date out of range".into()))?;
    let t = match unit {
        "year" | "years" | "y" => NaiveDate::from_ymd_opt(d.year(), 1, 1),
        "quarter" | "q" => NaiveDate::from_ymd_opt(d.year(), ((d.month() - 1) / 3) * 3 + 1, 1),
        "month" | "months" | "mo" => NaiveDate::from_ymd_opt(d.year(), d.month(), 1),
        "week" | "weeks" | "w" => Some(d - chrono::Duration::days(d.weekday().num_days_from_monday() as i64)),
        "day" | "days" | "d" => Some(d),
        u => return Err(WhError::Execution(format!("unsupported date_trunc unit '{u}'"))),
    }
    .ok_or_else(|| WhError::Execution("invalid date".into()))?;
    Ok(t.num_days_from_ce() - 719_163)
}

fn date_trunc_ts(dt: NaiveDateTime, unit: &str) -> Result<NaiveDateTime> {
    let date = dt.date();
    Ok(match unit {
        "hour" | "h" => date.and_hms_opt(dt.hour(), 0, 0).unwrap(),
        "minute" | "min" | "m" => date.and_hms_opt(dt.hour(), dt.minute(), 0).unwrap(),
        "second" | "s" => date.and_hms_opt(dt.hour(), dt.minute(), dt.second()).unwrap(),
        u => {
            let days = date.num_days_from_ce() - 719_163;
            let td = date_trunc_days(days, u)?;
            NaiveDate::from_num_days_from_ce_opt(td + 719_163).unwrap().and_hms_opt(0, 0, 0).unwrap()
        }
    })
}

/// Characters of each string of a view array: the view's length when the
/// bytes it may point into are ASCII, else counted (NULL rows get 0 under
/// their NULL).
fn view_char_lengths(v: &StringViewArray) -> Int64Array {
    // per buffer: one non-ASCII string sends only its own buffer's strings to the slow count
    let ascii: Vec<bool> = v.data_buffers().iter().map(|b| b.as_slice().is_ascii()).collect();
    let vals: Vec<i64> = v
        .views()
        .iter()
        .enumerate()
        .map(|(i, &view)| {
            let len = view as u32 as usize;
            // inline strings of up to 12 bytes sit in the view after the length;
            // longer ones name their buffer in bits 64..96
            let plain = if len <= 12 { (view >> 32).to_le_bytes()[..len].is_ascii() } else { ascii[(view >> 64) as u32 as usize] };
            if plain { len as i64 } else { v.value(i).chars().count() as i64 }
        })
        .collect();
    Int64Array::new(vals.into(), v.nulls().cloned())
}

fn eval_arrays(func: ScalarFunc, args: &[ColumnarValue], m: usize, dt: &DataType) -> Result<ArrayRef> {
    use ScalarFunc::*;
    let arr = |i: usize| args[i].clone().into_array(m);
    Ok(match func {
        Abs => {
            let a = arr(0)?;
            macro_rules! abs_int {
                ($t:ty) => {
                    Arc::new(a.as_primitive::<$t>().unary::<_, $t>(|v| v.wrapping_abs())) as ArrayRef
                };
            }
            match a.data_type() {
                DataType::Int8 => abs_int!(Int8Type),
                DataType::Int16 => abs_int!(Int16Type),
                DataType::Int32 => abs_int!(Int32Type),
                DataType::Int64 => abs_int!(Int64Type),
                DataType::Float32 => Arc::new(a.as_primitive::<Float32Type>().unary::<_, Float32Type>(|v| v.abs())),
                DataType::Float64 => unary_f64(&a, f64::abs),
                DataType::Decimal128(p, s) => Arc::new(
                    a.as_primitive::<Decimal128Type>()
                        .unary::<_, Decimal128Type>(|v| v.wrapping_abs())
                        .with_precision_and_scale(*p, *s)?,
                ),
                _ => a,
            }
        }
        Ceil | Floor => {
            let a = arr(0)?;
            let f: fn(f64) -> f64 = if func == Ceil { f64::ceil } else { f64::floor };
            match a.data_type() {
                DataType::Float64 => unary_f64(&a, f),
                DataType::Float32 => {
                    let g: fn(f32) -> f32 = if func == Ceil { f32::ceil } else { f32::floor };
                    Arc::new(a.as_primitive::<Float32Type>().unary::<_, Float32Type>(g))
                }
                DataType::Decimal128(_, _) => {
                    let f64a = arrow::compute::cast(&a, &DataType::Float64)?;
                    arrow::compute::cast(&unary_f64(&f64a, f), a.data_type())?
                }
                _ => a,
            }
        }
        Round => {
            let a = arr(0)?;
            let digits = if args.len() > 1 { scalar_i64(&args[1], "round digits")?.unwrap_or(0) } else { 0 };
            let p = 10f64.powi(digits as i32);
            unary_f64(&a, move |v| (v * p).round() / p)
        }
        Sqrt => unary_f64(&arr(0)?, f64::sqrt),
        Exp => unary_f64(&arr(0)?, f64::exp),
        Ln => unary_f64(&arr(0)?, f64::ln),
        Log10 => unary_f64(&arr(0)?, f64::log10),
        Log2 => unary_f64(&arr(0)?, f64::log2),
        Power => {
            let a = arr(0)?;
            let b = arr(1)?;
            Arc::new(arrow::compute::kernels::arity::binary::<_, _, _, Float64Type>(
                a.as_primitive::<Float64Type>(),
                b.as_primitive::<Float64Type>(),
                |x, y| x.powf(y),
            )?)
        }
        Upper | Lower => case_map(arr(0)?.as_string::<i32>(), func == Upper),
        Length => {
            let a = arr(0)?;
            if let Some(v) = a.as_string_view_opt() {
                return Ok(Arc::new(view_char_lengths(v)));
            }
            let s = a.as_string::<i32>();
            let out: Int64Array = if s.value_data().is_ascii() {
                let offs = s.value_offsets();
                let vals: Vec<i64> = offs.windows(2).map(|w| (w[1] - w[0]) as i64).collect();
                Int64Array::new(vals.into(), s.nulls().cloned())
            } else {
                s.iter().map(|v| v.map(|x| x.chars().count() as i64)).collect()
            };
            Arc::new(out)
        }
        Trim => map_str_ref(arr(0)?.as_string::<i32>(), str::trim).clone(),
        LTrim => map_str_ref(arr(0)?.as_string::<i32>(), str::trim_start).clone(),
        RTrim => map_str_ref(arr(0)?.as_string::<i32>(), str::trim_end).clone(),
        Reverse => map_str(arr(0)?.as_string::<i32>(), |s| Some(s.chars().rev().collect())),
        Substring => {
            let a = arr(0)?;
            let start = scalar_i64(&args[1], "substring start")?.unwrap_or(1);
            let len = if args.len() > 2 { scalar_i64(&args[2], "substring length")? } else { None };
            if a.data_type() == &DataType::Utf8View {
                let s = a.as_string_view();
                let cap = len.map_or(8, |l| l.clamp(0, 64) as usize) * s.len();
                let mut b = StringBuilder::with_capacity(s.len(), cap);
                for v in s.iter() {
                    match v {
                        Some(x) => b.append_value(substr_chars(x, start, len)),
                        None => b.append_null(),
                    }
                }
                return Ok(Arc::new(b.finish()));
            }
            let s = a.as_string::<i32>();
            let mut b = StringBuilder::with_capacity(s.len(), s.value_data().len());
            for v in s.iter() {
                match v {
                    Some(x) => b.append_value(substr_chars(x, start, len)),
                    None => b.append_null(),
                }
            }
            Arc::new(b.finish())
        }
        Left | Right => {
            let a = arr(0)?;
            let k = scalar_i64(&args[1], "left/right length")?.unwrap_or(0);
            let s = a.as_string::<i32>();
            let mut b = StringBuilder::with_capacity(s.len(), s.value_data().len());
            for v in s.iter() {
                match v {
                    Some(x) => {
                        let nchars = x.chars().count() as i64;
                        let r = if func == Left {
                            let take = if k >= 0 { k } else { (nchars + k).max(0) };
                            substr_chars(x, 1, Some(take))
                        } else {
                            let take = if k >= 0 { k.min(nchars) } else { (nchars + k).max(0) };
                            substr_chars(x, nchars - take + 1, Some(take))
                        };
                        b.append_value(r)
                    }
                    None => b.append_null(),
                }
            }
            Arc::new(b.finish())
        }
        Replace => {
            let a = arr(0)?;
            let from = arr(1)?;
            let to = arr(2)?;
            let (s, f, t) = (a.as_string::<i32>(), from.as_string::<i32>(), to.as_string::<i32>());
            let mut b = StringBuilder::with_capacity(s.len(), s.value_data().len());
            for i in 0..s.len() {
                if s.is_null(i) || f.is_null(i) || t.is_null(i) {
                    b.append_null();
                } else {
                    b.append_value(s.value(i).replace(f.value(i), t.value(i)));
                }
            }
            Arc::new(b.finish())
        }
        Concat => {
            let arrays = (0..args.len()).map(arr).collect::<Result<Vec<_>>>()?;
            let mut b = StringBuilder::with_capacity(m, m * 8);
            let strs: Vec<&StringArray> = arrays.iter().map(|a| a.as_string::<i32>()).collect();
            let mut buf = String::new();
            for i in 0..m {
                buf.clear();
                for s in &strs {
                    if s.is_valid(i) {
                        buf.push_str(s.value(i));
                    }
                }
                b.append_value(&buf);
            }
            Arc::new(b.finish())
        }
        StrPos => {
            let a = arr(0)?;
            let sub = arr(1)?;
            let (s, p) = (a.as_string::<i32>(), sub.as_string::<i32>());
            let out: Int64Array = (0..s.len())
                .map(|i| {
                    if s.is_null(i) || p.is_null(i) {
                        None
                    } else {
                        let h = s.value(i);
                        Some(match h.find(p.value(i)) {
                            Some(bi) => h[..bi].chars().count() as i64 + 1,
                            None => 0,
                        })
                    }
                })
                .collect();
            Arc::new(out)
        }
        StartsWith | EndsWith | Contains => {
            use arrow::compute::kernels::comparison as c;
            let r = match func {
                StartsWith => c::starts_with(&args[0], &args[1])?,
                EndsWith => c::ends_with(&args[0], &args[1])?,
                _ => c::contains(&args[0], &args[1])?,
            };
            if r.len() != m && r.len() == 1 {
                Scalar::new(Arc::new(r)).to_array(m)?
            } else {
                Arc::new(r)
            }
        }
        Coalesce => {
            let mut acc = arr(0)?;
            for i in 1..args.len() {
                if acc.null_count() == 0 {
                    break;
                }
                let mask = is_not_null(&acc)?;
                acc = zip(&mask, &acc, &args[i])?;
            }
            acc
        }
        NullIf => {
            let a = arr(0)?;
            let eq = cmp::eq(&a, &args[1])?;
            nullif(&a, &eq)?
        }
        Greatest | Least => {
            let mut acc = arr(0)?;
            for i in 1..args.len() {
                let next = arr(i)?;
                let better = if func == Greatest { cmp::gt(&next, &acc)? } else { cmp::lt(&next, &acc)? };
                // take `next` when it is better, or when acc is null and next is not
                let acc_null = arrow::compute::is_null(&acc)?;
                let pick = arrow::compute::or(
                    &crate::physical::expr::null_as_false(&better),
                    &arrow::compute::and(&acc_null, &is_not_null(&next)?)?,
                )?;
                acc = zip(&pick, &next, &acc)?;
            }
            acc
        }
        Year | Quarter | Month | Week | Day | DayOfWeek | DayOfYear | Hour | Minute | Second => {
            let part = match func {
                Year => DatePart::Year,
                Quarter => DatePart::Quarter,
                Month => DatePart::Month,
                Week => DatePart::WeekISO,
                Day => DatePart::Day,
                DayOfWeek => DatePart::DayOfWeekSunday0,
                DayOfYear => DatePart::DayOfYear,
                Hour => DatePart::Hour,
                Minute => DatePart::Minute,
                _ => DatePart::Second,
            };
            date_part(&arr(0)?, part)?
        }
        DateTrunc => {
            let unit = match &args[0] {
                ColumnarValue::Scalar(s) => s.as_str().map(|s| s.to_ascii_lowercase()).unwrap_or_default(),
                _ => return Err(WhError::NotSupported("date_trunc unit must be constant".into())),
            };
            let a = arr(1)?;
            match a.data_type() {
                DataType::Date32 => {
                    let p = a.as_primitive::<Date32Type>();
                    let out: Date32Array = p.try_unary(|d| date_trunc_days(d, &unit).map_err(|e| {
                        arrow::error::ArrowError::ComputeError(e.to_string())
                    }))?;
                    Arc::new(out)
                }
                DataType::Timestamp(_, _) => {
                    let us = arrow::compute::cast(&a, &DataType::Timestamp(TimeUnit::Microsecond, None))?;
                    let p = us.as_primitive::<TimestampMicrosecondType>();
                    let out: TimestampMicrosecondArray = p.try_unary(|v| {
                        let dt = chrono::DateTime::from_timestamp_micros(v)
                            .ok_or_else(|| arrow::error::ArrowError::ComputeError("ts out of range".into()))?
                            .naive_utc();
                        date_trunc_ts(dt, &unit)
                            .map(|t| t.and_utc().timestamp_micros())
                            .map_err(|e| arrow::error::ArrowError::ComputeError(e.to_string()))
                    })?;
                    arrow::compute::cast(&(Arc::new(out) as ArrayRef), dt)?
                }
                t => return Err(WhError::Execution(format!("date_trunc not supported for {t}"))),
            }
        }
        f if structs::names::is_struct_func(f) => structs::eval(f, args, m, dt)?,
        f if json::names::is_json_func(f) => json::eval(f, args, m, dt)?,
        f => eval::eval(f, args, m)?,
    })
}
