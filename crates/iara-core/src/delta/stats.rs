//! Per-file statistics of an `add` action: the JSON text
//! `{"numRecords": n, "minValues": {...}, "maxValues": {...}, "nullCount": {...}}`
//! (nested structs as nested objects) and its typed form for file pruning.
//!
//! Columns are keyed by their dotted path (`a.b` for field `b` of struct `a`);
//! columns whose names contain a dot get no statistics. Minimum and maximum
//! are bounds, not necessarily values of the file: strings are cut at
//! [`MAX_STRING_CHARS`], timestamps are written with millisecond precision
//! (minimum rounded down, maximum up), as other Delta writers do.

use std::collections::{BTreeMap, HashMap};

use arrow::array::AsArray;
use arrow::datatypes::{DataType, Decimal128Type, Fields, Schema, TimeUnit};
use chrono::{DateTime, Datelike, NaiveDate, NaiveDateTime};
use serde::Deserialize;
use serde_json::value::RawValue;

use crate::error::{Result, WhError};
use crate::scalar::Scalar;

/// Strings in min / max statistics keep this many characters.
pub const MAX_STRING_CHARS: usize = 32;

const UNIX_EPOCH_DAY_FROM_CE: i32 = 719_163;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct FileStats {
    /// `None` when the statistics do not say
    pub num_records: Option<u64>,
    /// lower bounds of the non-null values, by dotted column path
    pub min: HashMap<String, Scalar>,
    /// upper bounds
    pub max: HashMap<String, Scalar>,
    pub null_count: HashMap<String, u64>,
}

impl FileStats {
    /// The JSON text for the `stats` field of an `add`.
    pub fn to_json(&self) -> String {
        let section = |entries: Vec<(&String, String)>| {
            let mut root = BTreeMap::new();
            for (path, raw) in entries {
                insert(&mut root, path, raw);
            }
            render(&root)
        };
        let mins = self.min.iter().filter_map(|(k, v)| Some((k, render_scalar(v, false)?))).collect();
        let maxs = self.max.iter().filter_map(|(k, v)| Some((k, render_scalar(v, true)?))).collect();
        let nulls = self.null_count.iter().map(|(k, n)| (k, n.to_string())).collect();
        let mut out = String::from("{");
        if let Some(n) = self.num_records {
            out.push_str(&format!("\"numRecords\":{n},"));
        }
        out.push_str(&format!("\"minValues\":{},\"maxValues\":{},\"nullCount\":{}}}", section(mins), section(maxs), section(nulls)));
        out
    }

    /// The statistics of an `add`, typed by the table schema. Entries of
    /// columns the schema lacks, or that do not parse as the column's type,
    /// are left out.
    pub fn parse(json: &str, schema: &Schema) -> Result<FileStats> {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct Raw {
            num_records: Option<u64>,
            min_values: Option<BTreeMap<String, Box<RawValue>>>,
            max_values: Option<BTreeMap<String, Box<RawValue>>>,
            null_count: Option<BTreeMap<String, Box<RawValue>>>,
        }
        let raw: Raw = serde_json::from_str(json).map_err(|e| WhError::Execution(format!("invalid Delta file statistics: {e}")))?;
        let mut stats = FileStats { num_records: raw.num_records, ..Default::default() };
        let walk = |section: Option<BTreeMap<String, Box<RawValue>>>, f: &mut dyn FnMut(String, &DataType, &str)| {
            if let Some(section) = section {
                walk_leaves(schema.fields(), &section, "", f);
            }
        };
        walk(raw.min_values, &mut |path, dt, text| {
            if let Some(v) = parse_scalar(dt, text) {
                stats.min.insert(path, v);
            }
        });
        let mut max = HashMap::new();
        walk(raw.max_values, &mut |path, dt, text| {
            if let Some(v) = parse_scalar(dt, text) {
                max.insert(path, v);
            }
        });
        stats.max = max;
        let mut nulls = HashMap::new();
        walk(raw.null_count, &mut |path, _, text| {
            if let Ok(n) = text.trim().parse::<u64>() {
                nulls.insert(path, n);
            }
        });
        stats.null_count = nulls;
        Ok(stats)
    }
}

/// Call `f(path, type, json text)` for each leaf of `schema` present in `node`.
fn walk_leaves(fields: &Fields, node: &BTreeMap<String, Box<RawValue>>, prefix: &str, f: &mut dyn FnMut(String, &DataType, &str)) {
    for field in fields {
        let Some(raw) = node.get(field.name()) else { continue };
        let path = if prefix.is_empty() { field.name().clone() } else { format!("{prefix}.{}", field.name()) };
        match field.data_type() {
            DataType::Struct(children) => {
                if let Ok(inner) = serde_json::from_str::<BTreeMap<String, Box<RawValue>>>(raw.get()) {
                    walk_leaves(children, &inner, &path, f);
                }
            }
            dt => f(path, dt, raw.get()),
        }
    }
}

enum Node {
    Leaf(String),
    Obj(BTreeMap<String, Node>),
}

fn insert(root: &mut BTreeMap<String, Node>, path: &str, raw: String) {
    match path.split_once('.') {
        None => {
            root.insert(path.to_string(), Node::Leaf(raw));
        }
        Some((head, rest)) => {
            let child = root.entry(head.to_string()).or_insert_with(|| Node::Obj(BTreeMap::new()));
            if !matches!(child, Node::Obj(_)) {
                *child = Node::Obj(BTreeMap::new());
            }
            if let Node::Obj(m) = child {
                insert(m, rest, raw);
            }
        }
    }
}

fn render(m: &BTreeMap<String, Node>) -> String {
    let items: Vec<String> = m
        .iter()
        .map(|(k, n)| {
            let key = serde_json::to_string(k).expect("string");
            match n {
                Node::Leaf(raw) => format!("{key}:{raw}"),
                Node::Obj(inner) => format!("{key}:{}", render(inner)),
            }
        })
        .collect();
    format!("{{{}}}", items.join(","))
}

/// A bound as a JSON value; `None` for values with no statistics form.
fn render_scalar(s: &Scalar, upper: bool) -> Option<String> {
    if s.is_null() {
        return None;
    }
    let a = s.array();
    match s.data_type() {
        DataType::Int8 | DataType::Int16 | DataType::Int32 | DataType::Int64 => Some(s.as_i64()?.to_string()),
        DataType::Float32 => {
            let v = a.as_primitive::<arrow::datatypes::Float32Type>().value(0);
            v.is_finite().then(|| v.to_string())
        }
        DataType::Float64 => {
            let v = a.as_primitive::<arrow::datatypes::Float64Type>().value(0);
            v.is_finite().then(|| v.to_string())
        }
        DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View => serde_json::to_string(s.as_str()?).ok(),
        DataType::Date32 => {
            let days = a.as_primitive::<arrow::datatypes::Date32Type>().value(0);
            let d = NaiveDate::from_num_days_from_ce_opt(days.checked_add(UNIX_EPOCH_DAY_FROM_CE)?)?;
            Some(format!("\"{}\"", d.format("%Y-%m-%d")))
        }
        DataType::Timestamp(TimeUnit::Microsecond, tz) => {
            let micros = a.as_primitive::<arrow::datatypes::TimestampMicrosecondType>().value(0);
            let ms = if upper { micros.checked_add(999)?.div_euclid(1000) } else { micros.div_euclid(1000) };
            let dt = DateTime::from_timestamp_millis(ms)?;
            Some(if tz.is_some() { format!("\"{}\"", dt.format("%Y-%m-%dT%H:%M:%S%.3fZ")) } else { format!("\"{}\"", dt.format("%Y-%m-%dT%H:%M:%S%.3f")) })
        }
        DataType::Decimal128(_, scale) => Some(decimal_text(a.as_primitive::<Decimal128Type>().value(0), *scale)),
        _ => None,
    }
}

fn decimal_text(v: i128, scale: i8) -> String {
    let sign = if v < 0 { "-" } else { "" };
    let digits = v.unsigned_abs().to_string();
    let scale = scale.max(0) as usize;
    if scale == 0 {
        return format!("{sign}{digits}");
    }
    let padded = format!("{digits:0>width$}", width = scale + 1);
    let (int, frac) = padded.split_at(padded.len() - scale);
    format!("{sign}{int}.{frac}")
}

/// The unscaled value of a JSON number at `scale`, when exact.
fn parse_decimal(text: &str, scale: i8) -> Option<i128> {
    let t = text.trim();
    let (mantissa, exp) = match t.split_once(['e', 'E']) {
        Some((m, e)) => (m, e.parse::<i32>().ok()?),
        None => (t, 0),
    };
    let (neg, mantissa) = match mantissa.strip_prefix('-') {
        Some(m) => (true, m),
        None => (false, mantissa),
    };
    let (int, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
    let digits: i128 = format!("{int}{frac}").parse().ok()?;
    let shift = i32::from(scale) - frac.len() as i32 + exp;
    let v = if shift >= 0 {
        digits.checked_mul(10i128.checked_pow(u32::try_from(shift).ok()?)?)?
    } else {
        let div = 10i128.checked_pow(u32::try_from(-shift).ok()?)?;
        (digits % div == 0).then_some(digits / div)?
    };
    Some(if neg { -v } else { v })
}

fn parse_timestamp_micros(s: &str) -> Option<i64> {
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Some(dt.timestamp_micros());
    }
    NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f").ok().map(|n| n.and_utc().timestamp_micros())
}

/// A bound read from JSON `text` as a value of type `dt`.
fn parse_scalar(dt: &DataType, text: &str) -> Option<Scalar> {
    let text = text.trim();
    if text == "null" {
        return None;
    }
    let string = || serde_json::from_str::<String>(text).ok();
    match dt {
        DataType::Int8 | DataType::Int16 | DataType::Int32 | DataType::Int64 => {
            let v = match text.parse::<i64>() {
                Ok(v) => v,
                Err(_) => {
                    let f: f64 = text.parse().ok()?;
                    (f.fract() == 0.0 && f.abs() < 9.0e18).then_some(f as i64)?
                }
            };
            Scalar::int64(v).cast_exact(dt)
        }
        DataType::Float32 | DataType::Float64 => {
            let f: f64 = text.parse().ok().filter(|f: &f64| f.is_finite())?;
            Scalar::float64(f).cast_to(dt).ok()
        }
        DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View => Scalar::utf8(&string()?).cast_to(dt).ok(),
        DataType::Date32 => {
            let d = NaiveDate::parse_from_str(&string()?, "%Y-%m-%d").ok()?;
            Some(Scalar::date32(d.num_days_from_ce() - UNIX_EPOCH_DAY_FROM_CE))
        }
        DataType::Timestamp(TimeUnit::Microsecond, tz) => Some(Scalar::timestamp_us(parse_timestamp_micros(&string()?)?, tz.clone())),
        DataType::Decimal128(p, s) => Scalar::decimal128(parse_decimal(text, *s)?, *p, *s).ok(),
        _ => None,
    }
}

#[cfg(test)]
mod tests {

    use arrow::datatypes::Field;

    use super::*;

    fn schema() -> Schema {
        let ts = DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into()));
        Schema::new(vec![
            Field::new("id", DataType::Int64, true),
            Field::new("name", DataType::Utf8, true),
            Field::new("price", DataType::Decimal128(10, 2), true),
            Field::new("day", DataType::Date32, true),
            Field::new("at", ts, true),
            Field::new("f", DataType::Float64, true),
            Field::new("s", DataType::Struct(vec![Field::new("a", DataType::Int32, true)].into()), true),
        ])
    }

    #[test]
    fn parses_stats_written_by_other_engines() {
        let json = r#"{"numRecords":3,"minValues":{"id":1,"name":"abc","price":12.30,"day":"2024-01-15","at":"2024-01-15T10:00:00.123Z","f":0.5,"s":{"a":-4},"extra":1},"maxValues":{"id":9,"s":{"a":7}},"nullCount":{"id":0,"name":2,"s":{"a":1}}}"#;
        let s = FileStats::parse(json, &schema()).unwrap();
        assert_eq!(s.num_records, Some(3));
        assert_eq!(s.min["id"], Scalar::int64(1));
        assert_eq!(s.min["name"], Scalar::utf8("abc"));
        assert_eq!(s.min["price"], Scalar::decimal128(1230, 10, 2).unwrap());
        assert_eq!(s.min["day"], Scalar::date32(19737));
        assert_eq!(s.min["at"], Scalar::timestamp_us(1_705_312_800_123_000, Some("UTC".into())));
        assert_eq!(s.min["s.a"].as_i64(), Some(-4));
        assert_eq!(s.max["s.a"].as_i64(), Some(7));
        assert!(!s.min.contains_key("extra"));
        assert_eq!((s.null_count["name"], s.null_count["s.a"]), (2, 1));
    }

    #[test]
    fn json_round_trips() {
        let ts = |us| Scalar::timestamp_us(us, Some("UTC".into()));
        let stats = FileStats {
            num_records: Some(10),
            min: [
                ("id".to_string(), Scalar::int64(-5)),
                ("name".to_string(), Scalar::utf8("a\"b")),
                ("price".to_string(), Scalar::decimal128(-5, 10, 2).unwrap()),
                ("day".to_string(), Scalar::date32(0)),
                ("at".to_string(), ts(1_000)),
                ("s.a".to_string(), Scalar::int64(3).cast_to(&DataType::Int32).unwrap()),
            ]
            .into(),
            max: [("id".to_string(), Scalar::int64(100)), ("at".to_string(), ts(1_001))].into(),
            null_count: [("id".to_string(), 0), ("s.a".to_string(), 4)].into(),
        };
        let json = stats.to_json();
        assert!(json.starts_with("{\"numRecords\":10,\"minValues\":{\"at\":\"1970-01-01T00:00:00.001Z\""), "{json}");
        assert!(json.contains("\"price\":-0.05") && json.contains("\"s\":{\"a\":3}") && json.contains("\"nullCount\":{\"id\":0,\"s\":{\"a\":4}}"));
        // the maximum is rounded up to the millisecond
        assert!(json.contains("\"maxValues\":{\"at\":\"1970-01-01T00:00:00.002Z\""), "{json}");
        let back = FileStats::parse(&json, &schema()).unwrap();
        assert_eq!(back.min["name"], stats.min["name"]);
        assert_eq!(back.min["price"], stats.min["price"]);
        assert_eq!(back.min["at"], ts(1_000));
        assert_eq!(back.max["at"], ts(2_000));
        assert_eq!(back.null_count, stats.null_count);
    }

    #[test]
    fn decimals_and_strings_edge_cases() {
        assert_eq!(decimal_text(12345, 2), "123.45");
        assert_eq!(decimal_text(5, 3), "0.005");
        assert_eq!(decimal_text(-7, 0), "-7");
        assert_eq!(parse_decimal("1.5e1", 2), Some(1500));
        assert_eq!(parse_decimal("0.123", 2), None, "not exact");
        assert_eq!(parse_decimal("-3", 1), Some(-30));
        let s = Schema::new(vec![Field::new("n", DataType::Utf8, true)]);
        assert!(FileStats::parse("{\"numRecords\":1,\"minValues\":{\"n\":5}}", &s).unwrap().min.is_empty());
        assert!(FileStats::parse("nope", &s).is_err());
    }
}
