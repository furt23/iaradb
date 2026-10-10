//! Date/time parsing and formatting with strptime/strftime formats.
//!
//! Formats with a `%` use chrono's strftime syntax (DuckDB/Polars style). A
//! format without `%` is read as a Spark pattern (`yyyy-MM-dd HH:mm:ss`).
//! `%f` is microseconds when formatting, as in DuckDB.

use std::fmt::Write;
use std::sync::Arc;

use arrow::array::*;
use arrow::compute::cast;
use arrow::datatypes::*;
use chrono::format::{Item, Parsed, StrftimeItems, parse};
use chrono::{NaiveDateTime, NaiveTime};

use super::dates::from_date;
use crate::error::{Result, WhError};

type Items = Vec<Item<'static>>;

/// Spark pattern letters -> strftime.
fn from_spark(p: &str) -> String {
    let c: Vec<char> = p.chars().collect();
    let (mut out, mut i) = (String::new(), 0);
    while i < c.len() {
        let ch = c[i];
        let mut j = i;
        while j < c.len() && c[j] == ch {
            j += 1;
        }
        let run = j - i;
        match ch {
            '\'' => {
                // quoted literal
                let end = c[i + 1..].iter().position(|&x| x == '\'').map(|k| i + 1 + k).unwrap_or(c.len());
                out.extend(c[i + 1..end].iter());
                i = (end + 1).min(c.len());
                continue;
            }
            'y' => out.push_str(if run == 2 { "%y" } else { "%Y" }),
            'M' => out.push_str(match run { 1 | 2 => "%m", 3 => "%b", _ => "%B" }),
            'd' => out.push_str("%d"),
            'H' => out.push_str("%H"),
            'h' => out.push_str("%I"),
            'm' => out.push_str("%M"),
            's' => out.push_str("%S"),
            'S' => out.push_str(&format!("%.{run}f")),
            'a' => out.push_str("%p"),
            'E' => out.push_str(if run >= 4 { "%A" } else { "%a" }),
            'D' => out.push_str("%j"),
            'z' | 'Z' | 'X' => out.push_str("%z"),
            '%' => out.push_str("%%"),
            _ => out.extend(std::iter::repeat_n(ch, run)),
        }
        i = j;
    }
    out
}

fn items(fmt: &str, formatting: bool) -> Result<Items> {
    let mut f = if fmt.contains('%') { fmt.to_string() } else { from_spark(fmt) };
    if formatting {
        f = f.replace("%f", "%6f");
    }
    let items: Items = StrftimeItems::new(&f).map(|i| i.to_owned()).collect();
    if items.iter().any(|i| matches!(i, Item::Error)) {
        return Err(WhError::Plan(format!("invalid date format '{fmt}'")));
    }
    Ok(items)
}

pub fn check_format(fmt: &str, formatting: bool) -> Result<()> {
    items(fmt, formatting).map(|_| ())
}

fn parse_ts(s: &str, items: &Items) -> Option<NaiveDateTime> {
    let mut p = Parsed::new();
    parse(&mut p, s, items.iter()).ok()?;
    if let Ok(dt) = p.to_datetime() {
        return Some(dt.naive_utc());
    }
    let date = p.to_naive_date().ok()?;
    let time = p.to_naive_time().unwrap_or(NaiveTime::MIN);
    Some(date.and_time(time))
}

fn first_arg_fmt(fmt: &str) -> Result<Items> {
    items(fmt, false)
}

fn run<T>(
    a: &ArrayRef,
    fmt: &str,
    strict: bool,
    conv: impl Fn(NaiveDateTime) -> T,
) -> Result<Vec<Option<T>>> {
    let items = first_arg_fmt(fmt)?;
    let mut out = Vec::with_capacity(a.len());
    for v in a.as_string::<i32>().iter() {
        out.push(match v {
            None => None,
            Some(s) => match parse_ts(s, &items) {
                Some(t) => Some(conv(t)),
                None if strict => {
                    return Err(WhError::Execution(format!("cannot parse '{s}' with format '{fmt}'")));
                }
                None => None,
            },
        });
    }
    Ok(out)
}

pub fn to_date_fmt(a: &ArrayRef, fmt: &str, strict: bool) -> Result<ArrayRef> {
    let v = run(a, fmt, strict, |t| from_date(t.date()))?;
    Ok(Arc::new(v.into_iter().collect::<Date32Array>()))
}

pub fn to_timestamp_fmt(a: &ArrayRef, fmt: &str, strict: bool) -> Result<ArrayRef> {
    let v = run(a, fmt, strict, |t| t.and_utc().timestamp_micros())?;
    Ok(Arc::new(v.into_iter().collect::<TimestampMicrosecondArray>()))
}

pub fn strftime(a: &ArrayRef, fmt: &str) -> Result<ArrayRef> {
    let items = items(fmt, true)?;
    let us = cast(a, &DataType::Timestamp(TimeUnit::Microsecond, None))?;
    let us = us.as_primitive::<TimestampMicrosecondType>();
    let mut b = StringBuilder::with_capacity(us.len(), us.len() * fmt.len());
    let mut buf = String::new();
    for v in us.iter() {
        match v.and_then(chrono::DateTime::from_timestamp_micros) {
            None => b.append_null(),
            Some(d) => {
                buf.clear();
                write!(buf, "{}", d.naive_utc().format_with_items(items.iter()))
                    .map_err(|_| WhError::Execution(format!("cannot format with '{fmt}'")))?;
                b.append_value(&buf);
            }
        }
    }
    Ok(Arc::new(b.finish()))
}
