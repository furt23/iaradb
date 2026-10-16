//! File statistics from a Parquet footer: the row-group statistics of every
//! leaf column outside lists and maps, combined over the row groups.
//! A column is left out of `min` / `max` when any row group that holds a
//! value lacks them (or the type has none in Delta: booleans, binaries), and
//! out of `null_count` when any row group does not count its nulls.

use std::cmp::Ordering;

use arrow::datatypes::{DataType, Fields, TimeUnit};
use parquet::file::metadata::ParquetMetaData;
use parquet::file::statistics::Statistics;

use super::schema_json::{arrow_type_of, delta_type_of};
use super::stats::{FileStats, MAX_STRING_CHARS};
use crate::scalar::Scalar;

/// A bound on a common scale: integers (and dates, timestamps in microseconds,
/// unscaled decimals), floats or strings.
#[derive(Debug, Clone, PartialEq)]
enum Val {
    Int(i128),
    Float(f64),
    Str(String),
}

impl Val {
    fn cmp(&self, other: &Val) -> Option<Ordering> {
        match (self, other) {
            (Val::Int(a), Val::Int(b)) => Some(a.cmp(b)),
            (Val::Float(a), Val::Float(b)) => a.partial_cmp(b),
            (Val::Str(a), Val::Str(b)) => Some(a.cmp(b)),
            _ => None,
        }
    }
}

impl FileStats {
    /// The statistics of a Parquet file from its footer.
    pub fn from_parquet(meta: &ParquetMetaData) -> FileStats {
        let mut stats = FileStats { num_records: Some(meta.file_metadata().num_rows().max(0) as u64), ..Default::default() };
        let descr = meta.file_metadata().schema_descr();
        let Ok(arrow) = parquet::arrow::parquet_to_arrow_schema(descr, meta.file_metadata().key_value_metadata()) else {
            return stats;
        };
        for (i, col) in descr.columns().iter().enumerate() {
            let parts = col.path().parts();
            if col.max_rep_level() > 0 || parts.iter().any(|p| p.contains('.')) {
                continue;
            }
            let Some(dt) = leaf_type(arrow.fields(), parts) else { continue };
            let path = parts.join(".");
            let chunks: Vec<(&Statistics, i64)> = meta.row_groups().iter().filter_map(|rg| Some((rg.column(i).statistics()?, rg.num_rows()))).collect();
            let complete = chunks.len() == meta.num_row_groups();
            if complete {
                let nulls: Option<Vec<u64>> = chunks.iter().map(|(s, _)| s.null_count_opt()).collect();
                if let Some(n) = nulls {
                    stats.null_count.insert(path.clone(), n.iter().sum());
                }
            }
            let Some(target) = delta_target(dt) else { continue };
            if !complete {
                continue;
            }
            if let Some((min, max)) = bounds(&chunks, dt) {
                if let Some(v) = to_scalar(&truncate_min(min), &target) {
                    stats.min.insert(path.clone(), v);
                }
                if let Some(v) = truncate_max(max).and_then(|m| to_scalar(&m, &target)) {
                    stats.max.insert(path, v);
                }
            }
        }
        stats
    }
}

/// The Arrow type of the leaf at `parts`, through structs only.
fn leaf_type<'a>(fields: &'a Fields, parts: &[String]) -> Option<&'a DataType> {
    let (head, rest) = parts.split_first()?;
    let field = fields.iter().find(|f| f.name() == head)?;
    match (rest.is_empty(), field.data_type()) {
        (true, dt) => Some(dt),
        (false, DataType::Struct(children)) => leaf_type(children, rest),
        _ => None,
    }
}

/// The type bounds of this column have in the table schema; `None` when
/// Delta keeps no min / max for it.
fn delta_target(dt: &DataType) -> Option<DataType> {
    let t = arrow_type_of(&delta_type_of(dt).ok()?).ok()?;
    matches!(
        t,
        DataType::Int8
            | DataType::Int16
            | DataType::Int32
            | DataType::Int64
            | DataType::Float32
            | DataType::Float64
            | DataType::Utf8
            | DataType::Date32
            | DataType::Timestamp(..)
            | DataType::Decimal128(..)
    )
    .then_some(t)
}

/// (min, max) over the row groups that hold values; `None` when one of them lacks bounds.
fn bounds(chunks: &[(&Statistics, i64)], dt: &DataType) -> Option<(Val, Val)> {
    let (mut min, mut max): (Option<Val>, Option<Val>) = (None, None);
    for (s, rows) in chunks {
        if s.null_count_opt().is_some_and(|n| n as i64 >= *rows) {
            continue; // all null
        }
        let (lo, hi) = (value(s, dt, false)?, value(s, dt, true)?);
        if min.as_ref().is_none_or(|m| lo.cmp(m) == Some(Ordering::Less)) {
            min = Some(lo);
        }
        if max.as_ref().is_none_or(|m| hi.cmp(m) == Some(Ordering::Greater)) {
            max = Some(hi);
        }
    }
    Some((min?, max?))
}

/// The min (or max) of a column chunk on the common scale.
fn value(s: &Statistics, dt: &DataType, upper: bool) -> Option<Val> {
    match s {
        Statistics::Int32(v) => {
            let x = *pick(v.min_opt(), v.max_opt(), upper)?;
            match dt {
                DataType::Int8 | DataType::Int16 | DataType::Int32 | DataType::Date32 | DataType::Date64 | DataType::Decimal128(..) => Some(Val::Int(x.into())),
                DataType::UInt8 | DataType::UInt16 | DataType::UInt32 => Some(Val::Int((x as u32).into())),
                _ => None,
            }
        }
        Statistics::Int64(v) => {
            let x = *pick(v.min_opt(), v.max_opt(), upper)?;
            match dt {
                DataType::Int64 | DataType::Decimal128(..) => Some(Val::Int(x.into())),
                DataType::UInt64 => Some(Val::Int((x as u64).into())),
                DataType::Timestamp(unit, _) => Some(Val::Int(micros(x, unit, upper)?.into())),
                _ => None,
            }
        }
        Statistics::Float(v) => float(f64::from(*pick(v.min_opt(), v.max_opt(), upper)?)),
        Statistics::Double(v) => float(*pick(v.min_opt(), v.max_opt(), upper)?),
        Statistics::ByteArray(v) => {
            let b = pick(v.min_opt(), v.max_opt(), upper)?.data();
            match dt {
                DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View => std::str::from_utf8(b).ok().map(|s| Val::Str(s.to_string())),
                DataType::Decimal128(..) => be_i128(b).map(Val::Int),
                _ => None,
            }
        }
        Statistics::FixedLenByteArray(v) => match dt {
            DataType::Decimal128(..) => be_i128(pick(v.min_opt(), v.max_opt(), upper)?.data()).map(Val::Int),
            _ => None,
        },
        Statistics::Boolean(_) | Statistics::Int96(_) => None,
    }
}

fn pick<T>(lo: Option<T>, hi: Option<T>, upper: bool) -> Option<T> {
    if upper { hi } else { lo }
}

fn float(x: f64) -> Option<Val> {
    x.is_finite().then_some(Val::Float(x))
}

/// Microseconds of `x` in `unit`; sub-microsecond digits round down (min) or up (max).
fn micros(x: i64, unit: &TimeUnit, upper: bool) -> Option<i64> {
    match unit {
        TimeUnit::Second => x.checked_mul(1_000_000),
        TimeUnit::Millisecond => x.checked_mul(1_000),
        TimeUnit::Microsecond => Some(x),
        TimeUnit::Nanosecond => Some(if upper { x.div_euclid(1000) + i64::from(x.rem_euclid(1000) != 0) } else { x.div_euclid(1000) }),
    }
}

/// A big-endian two's complement integer of up to 16 bytes.
fn be_i128(b: &[u8]) -> Option<i128> {
    if b.is_empty() || b.len() > 16 {
        return None;
    }
    let mut buf = if b[0] & 0x80 != 0 { [0xffu8; 16] } else { [0u8; 16] };
    buf[16 - b.len()..].copy_from_slice(b);
    Some(i128::from_be_bytes(buf))
}

fn truncate_min(v: Val) -> Val {
    match v {
        Val::Str(s) if s.chars().count() > MAX_STRING_CHARS => Val::Str(s.chars().take(MAX_STRING_CHARS).collect()),
        v => v,
    }
}

/// The maximum, cut when long: the prefix followed by the largest code point
/// is still at least the original; if it is not, no maximum is kept.
fn truncate_max(v: Val) -> Option<Val> {
    match v {
        Val::Str(s) if s.chars().count() > MAX_STRING_CHARS => {
            let mut cut: String = s.chars().take(MAX_STRING_CHARS).collect();
            cut.push(char::MAX);
            (cut >= s).then_some(Val::Str(cut))
        }
        v => Some(v),
    }
}

fn to_scalar(v: &Val, target: &DataType) -> Option<Scalar> {
    match (v, target) {
        (Val::Int(x), DataType::Decimal128(p, s)) => Scalar::decimal128(*x, *p, *s).ok(),
        (Val::Int(x), t) => Scalar::int64(i64::try_from(*x).ok()?).cast_exact(t),
        (Val::Float(x), t) => Scalar::float64(*x).cast_to(t).ok(),
        (Val::Str(s), _) => Some(Scalar::utf8(s)),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use arrow::array::{ArrayRef, BooleanArray, Date32Array, Decimal128Array, Float64Array, Int32Array, Int64Array, ListArray, RecordBatch, StringArray, StructArray, TimestampNanosecondArray, UInt32Array};
    use arrow::datatypes::{Field, Schema};
    use bytes::Bytes;
    use parquet::arrow::ArrowWriter;
    use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;
    use parquet::file::properties::WriterProperties;

    use super::*;
    use crate::scalar::Scalar;

    fn footer(batch: &RecordBatch, row_group: usize) -> Arc<ParquetMetaData> {
        let mut buf = vec![];
        let props = WriterProperties::builder().set_max_row_group_row_count(Some(row_group)).build();
        let mut w = ArrowWriter::try_new(&mut buf, batch.schema(), Some(props)).unwrap();
        w.write(batch).unwrap();
        w.close().unwrap();
        ParquetRecordBatchReaderBuilder::try_new(Bytes::from(buf)).unwrap().metadata().clone()
    }

    #[test]
    fn stats_from_a_parquet_footer() {
        let long_max = format!("{}z", "m".repeat(40));
        let strings: Vec<Option<&str>> = vec![Some("beta"), None, Some("alpha"), Some(long_max.as_str()), Some("gamma"), Some("delta")];
        let st_fields = vec![Field::new("a", DataType::Int32, true)];
        let st = StructArray::new(
            st_fields.clone().into(),
            vec![Arc::new(Int32Array::from(vec![Some(5), Some(-2), None, Some(9), None, None])) as ArrayRef],
            None,
        );
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("name", DataType::Utf8, true),
            Field::new("price", DataType::Decimal128(10, 2), true),
            Field::new("day", DataType::Date32, true),
            Field::new("at", DataType::Timestamp(TimeUnit::Nanosecond, Some("UTC".into())), true),
            Field::new("u", DataType::UInt32, true),
            Field::new("f", DataType::Float64, true),
            Field::new("flag", DataType::Boolean, true),
            Field::new("s", DataType::Struct(st_fields.into()), true),
            Field::new("l", DataType::List(Arc::new(Field::new("item", DataType::Int32, true))), true),
        ]));
        let list = ListArray::from_iter_primitive::<arrow::datatypes::Int32Type, _, _>(vec![Some(vec![Some(1)]); 6]);
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Int64Array::from(vec![3, 1, 4, 1, 5, 9])),
                Arc::new(StringArray::from(strings)),
                Arc::new(Decimal128Array::from(vec![Some(1250), Some(-3), None, Some(7), Some(100), Some(0)]).with_precision_and_scale(10, 2).unwrap()),
                Arc::new(Date32Array::from(vec![Some(10), Some(20), None, Some(5), Some(6), Some(7)])),
                Arc::new(TimestampNanosecondArray::from(vec![Some(1_500), Some(2_000_001), None, Some(0), Some(7), Some(8)]).with_timezone("UTC")),
                Arc::new(UInt32Array::from(vec![Some(4_000_000_000), Some(1), None, Some(2), Some(3), Some(4)])),
                Arc::new(Float64Array::from(vec![Some(1.5), Some(-0.5), None, Some(2.0), Some(3.0), Some(4.0)])),
                Arc::new(BooleanArray::from(vec![true; 6])),
                Arc::new(st),
                Arc::new(list),
            ],
        )
        .unwrap();

        let stats = FileStats::from_parquet(&footer(&batch, 2));
        assert_eq!(stats.num_records, Some(6));
        assert_eq!((stats.min["id"].as_i64(), stats.max["id"].as_i64()), (Some(1), Some(9)));
        assert_eq!(stats.min["name"], Scalar::utf8("alpha"));
        let max = stats.max["name"].as_str().unwrap().to_string();
        assert!(max.chars().count() == MAX_STRING_CHARS + 1 && max > long_max, "truncated max stays an upper bound");
        assert_eq!(stats.min["price"], Scalar::decimal128(-3, 10, 2).unwrap());
        assert_eq!(stats.max["price"], Scalar::decimal128(1250, 10, 2).unwrap());
        assert_eq!((stats.min["day"].clone(), stats.max["day"].clone()), (Scalar::date32(5), Scalar::date32(20)));
        // nanoseconds become microseconds: the minimum rounds down, the maximum up
        assert_eq!(stats.min["at"], Scalar::timestamp_us(0, Some("UTC".into())));
        assert_eq!(stats.max["at"], Scalar::timestamp_us(2_001, Some("UTC".into())));
        // unsigned 32 bit values widen to long
        assert_eq!(stats.max["u"].as_i64(), Some(4_000_000_000));
        assert_eq!((stats.min["f"].as_f64(), stats.max["f"].as_f64()), (Some(-0.5), Some(4.0)));
        assert!(!stats.min.contains_key("flag") && !stats.max.contains_key("flag"));
        assert_eq!(stats.null_count["flag"], 0);
        assert_eq!((stats.min["s.a"].as_i64(), stats.max["s.a"].as_i64()), (Some(-2), Some(9)));
        assert_eq!(stats.null_count["s.a"], 3);
        assert_eq!(stats.null_count["name"], 1);
        assert!(!stats.null_count.keys().any(|k| k.starts_with('l')), "list contents have no statistics");

        // JSON and back through the table schema
        let table_schema = Schema::new(vec![
            Field::new("id", DataType::Int64, false),
            Field::new("name", DataType::Utf8, true),
            Field::new("price", DataType::Decimal128(10, 2), true),
            Field::new("at", DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())), true),
            Field::new("s", DataType::Struct(vec![Field::new("a", DataType::Int32, true)].into()), true),
        ]);
        let json = stats.to_json();
        let back = FileStats::parse(&json, &table_schema).unwrap();
        assert_eq!(back.num_records, Some(6));
        assert_eq!(back.min["price"], stats.min["price"]);
        assert_eq!(back.max["name"], stats.max["name"]);
        assert_eq!(back.max["s.a"].as_i64(), Some(9));
        assert_eq!(back.null_count["s.a"], 3);
    }

    #[test]
    fn all_null_row_groups_do_not_hide_bounds() {
        let schema = Arc::new(Schema::new(vec![Field::new("x", DataType::Int32, true)]));
        let batch = RecordBatch::try_new(schema, vec![Arc::new(Int32Array::from(vec![None, None, Some(7), Some(3)]))]).unwrap();
        let stats = FileStats::from_parquet(&footer(&batch, 2));
        assert_eq!((stats.min["x"].as_i64(), stats.max["x"].as_i64(), stats.null_count["x"]), (Some(3), Some(7), 2));
    }
}
