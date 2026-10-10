//! Date arithmetic kernels. Dates are Date32 (days since 1970-01-01);
//! timestamps are computed in microseconds, wall-clock (time zones ignored).
//! Invalid results (out of range, impossible date) are NULL.

use std::sync::Arc;

use arrow::array::*;
use arrow::compute::cast;
use arrow::compute::kernels::arity::binary;
use arrow::datatypes::*;
use chrono::{Datelike, Months, NaiveDate, NaiveDateTime, TimeDelta};

use crate::error::{Result, WhError};

const EPOCH_CE_DAYS: i32 = 719_163;

pub fn to_date(days: i32) -> Option<NaiveDate> {
    NaiveDate::from_num_days_from_ce_opt(days.checked_add(EPOCH_CE_DAYS)?)
}

pub fn from_date(d: NaiveDate) -> i32 {
    d.num_days_from_ce() - EPOCH_CE_DAYS
}

fn to_ts(us: i64) -> Option<NaiveDateTime> {
    chrono::DateTime::from_timestamp_micros(us).map(|d| d.naive_utc())
}

fn zip_map<A: ArrowPrimitiveType, B: ArrowPrimitiveType, O: ArrowPrimitiveType>(
    a: &ArrayRef,
    b: &ArrayRef,
    f: impl Fn(A::Native, B::Native) -> Option<O::Native>,
) -> PrimitiveArray<O> {
    let (a, b) = (a.as_primitive::<A>(), b.as_primitive::<B>());
    a.iter().zip(b.iter()).map(|(x, y)| f(x?, y?)).collect()
}

/// date_add / date_sub on (Date32, Int32).
pub fn add_days(a: &ArrayRef, n: &ArrayRef, sign: i32) -> Result<ArrayRef> {
    let out = binary::<_, _, _, Date32Type>(
        a.as_primitive::<Date32Type>(),
        n.as_primitive::<Int32Type>(),
        |d, k| d.wrapping_add(sign.wrapping_mul(k)),
    )?;
    Ok(Arc::new(out))
}

/// Add `n` months to a date; the day is clamped to the month length.
pub fn add_months_date(d: NaiveDate, n: i64) -> Option<NaiveDate> {
    let m = Months::new(n.unsigned_abs().try_into().ok()?);
    if n >= 0 { d.checked_add_months(m) } else { d.checked_sub_months(m) }
}

pub fn add_months(a: &ArrayRef, n: &ArrayRef) -> ArrayRef {
    let out: Date32Array =
        zip_map::<Date32Type, Int64Type, Date32Type>(a, n, |d, k| add_months_date(to_date(d)?, k).map(from_date));
    Arc::new(out)
}

pub fn make_date(y: &ArrayRef, mo: &ArrayRef, d: &ArrayRef) -> ArrayRef {
    let (y, mo, d) = (y.as_primitive::<Int64Type>(), mo.as_primitive::<Int64Type>(), d.as_primitive::<Int64Type>());
    let out: Date32Array = (0..y.len())
        .map(|i| {
            if y.is_null(i) || mo.is_null(i) || d.is_null(i) {
                return None;
            }
            let date = NaiveDate::from_ymd_opt(
                i32::try_from(y.value(i)).ok()?,
                u32::try_from(mo.value(i)).ok()?,
                u32::try_from(d.value(i)).ok()?,
            )?;
            Some(from_date(date))
        })
        .collect();
    Arc::new(out)
}

fn month_end_of(d: NaiveDate) -> Option<NaiveDate> {
    add_months_date(NaiveDate::from_ymd_opt(d.year(), d.month(), 1)?, 1)?.pred_opt()
}

fn month_start_of(d: NaiveDate) -> Option<NaiveDate> {
    NaiveDate::from_ymd_opt(d.year(), d.month(), 1)
}

/// Apply a date function to Date32 or Timestamp (a timestamp lands on midnight
/// of the resulting day, as Polars `month_end` does).
fn map_temporal(
    a: &ArrayRef,
    f_date: impl Fn(NaiveDate) -> Option<NaiveDate>,
    f_ts: impl Fn(NaiveDateTime) -> Option<NaiveDateTime>,
) -> Result<ArrayRef> {
    match a.data_type() {
        DataType::Date32 => {
            let out: Date32Array = a.as_primitive::<Date32Type>().iter().map(|v| Some(from_date(f_date(to_date(v?)?)?))).collect();
            Ok(Arc::new(out))
        }
        DataType::Timestamp(..) => {
            let us = cast(a, &DataType::Timestamp(TimeUnit::Microsecond, None))?;
            let out: TimestampMicrosecondArray = us
                .as_primitive::<TimestampMicrosecondType>()
                .iter()
                .map(|v| f_ts(to_ts(v?)?).map(|t| t.and_utc().timestamp_micros()))
                .collect();
            Ok(cast(&(Arc::new(out) as ArrayRef), a.data_type())?)
        }
        t => Err(WhError::Execution(format!("date function not supported for {t}"))),
    }
}

fn midnight(d: NaiveDate) -> Option<NaiveDateTime> {
    d.and_hms_opt(0, 0, 0)
}

pub fn month_edge(a: &ArrayRef, end: bool) -> Result<ArrayRef> {
    let f = move |d: NaiveDate| if end { month_end_of(d) } else { month_start_of(d) };
    map_temporal(a, f, move |t| f(t.date()).and_then(midnight))
}

pub fn last_day(a: &ArrayRef) -> Result<ArrayRef> {
    month_edge(a, true)
}

/// Parsed `offset_by` interval, e.g. "1y2mo", "-3d", "12h".
#[derive(Debug, Default, Clone, Copy)]
pub struct Offset {
    pub months: i64,
    pub days: i64,
    pub micros: i64,
}

impl Offset {
    pub fn parse(s: &str) -> Result<Self> {
        let bad = || WhError::Plan(format!("invalid offset '{s}' (examples: 1d, -2mo, 1y3mo, 12h)"));
        let b = s.trim().as_bytes();
        let (mut o, mut i) = (Offset::default(), 0);
        // like Polars, a leading '-' negates the whole interval ("-1y2d")
        let all_neg = b.first() == Some(&b'-');
        if b.is_empty() {
            return Err(bad());
        }
        while i < b.len() {
            let signed = b[i] == b'-' || b[i] == b'+';
            let neg = b[i] == b'-' || (all_neg && b[i] != b'+');
            i += usize::from(signed);
            let start = i;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            let n: i64 = s.trim()[start..i].parse().map_err(|_| bad())?;
            let n = if neg { -n } else { n };
            let u = i;
            while i < b.len() && b[i].is_ascii_alphabetic() {
                i += 1;
            }
            match &s.trim()[u..i] {
                "y" => o.months += 12 * n,
                "q" => o.months += 3 * n,
                "mo" => o.months += n,
                "w" => o.days += 7 * n,
                "d" => o.days += n,
                "h" => o.micros += n * 3_600_000_000,
                "m" => o.micros += n * 60_000_000,
                "s" => o.micros += n * 1_000_000,
                "ms" => o.micros += n * 1_000,
                "us" => o.micros += n,
                "ns" => o.micros += n / 1_000,
                _ => return Err(bad()),
            }
        }
        Ok(o)
    }

    fn apply_date(&self, d: NaiveDate) -> Option<NaiveDate> {
        add_months_date(d, self.months)?.checked_add_signed(TimeDelta::try_days(self.days)?)
    }

    fn apply_ts(&self, t: NaiveDateTime) -> Option<NaiveDateTime> {
        let d = self.apply_date(t.date())?;
        d.and_time(t.time()).checked_add_signed(TimeDelta::microseconds(self.micros))
    }
}

pub fn offset_by(a: &ArrayRef, off: &Offset) -> Result<ArrayRef> {
    map_temporal(a, |d| off.apply_date(d), |t| off.apply_ts(t))
}

const UNITS: [&str; 8] = ["day", "week", "month", "quarter", "year", "hour", "minute", "second"];

pub fn check_unit(unit: &str) -> Result<()> {
    if UNITS.contains(&unit.to_ascii_lowercase().as_str()) {
        Ok(())
    } else {
        Err(WhError::Plan(format!("unsupported datediff unit '{unit}'")))
    }
}

/// Index of the calendar bucket containing `t`; differences of indexes count
/// boundaries crossed, which is what DuckDB's `datediff` returns.
fn bucket(t: NaiveDateTime, unit: &str) -> i64 {
    let days = t.date().num_days_from_ce() as i64 - EPOCH_CE_DAYS as i64;
    let secs = t.and_utc().timestamp();
    match unit {
        "day" => days,
        "week" => (days + 3).div_euclid(7),
        "month" => t.year() as i64 * 12 + t.month0() as i64,
        "quarter" => t.year() as i64 * 4 + (t.month0() / 3) as i64,
        "year" => t.year() as i64,
        "hour" => secs.div_euclid(3600),
        "minute" => secs.div_euclid(60),
        _ => secs,
    }
}

/// datediff(unit, start, end) on microsecond timestamps.
pub fn datediff(unit: &str, start: &ArrayRef, end: &ArrayRef) -> ArrayRef {
    let unit = unit.to_ascii_lowercase();
    let out: Int64Array = zip_map::<TimestampMicrosecondType, TimestampMicrosecondType, Int64Type>(start, end, |s, e| {
        Some(bucket(to_ts(e)?, &unit) - bucket(to_ts(s)?, &unit))
    });
    Arc::new(out)
}

#[cfg(test)]
mod tests {
    use super::Offset;

    #[test]
    fn leading_minus_negates_every_unit() {
        let o = Offset::parse("-1y2d").unwrap();
        assert_eq!((o.months, o.days), (-12, -2));
        let o = Offset::parse("1y2d").unwrap();
        assert_eq!((o.months, o.days), (12, 2));
        assert!(Offset::parse("-").is_err());
    }
}
