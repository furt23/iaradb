//! Statistics of a table from the per-file statistics of its log (a Delta
//! table's `add` actions): what the optimizer asks of a table is answered
//! without opening a file. The Parquet footers hold the same numbers per row
//! group, but a table of thousands of files would spend longer reading them
//! than running the query.
//!
//! The bounds of a column are kept as one array per side with a value per
//! file, built the first time the column is asked for.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, ArrayRef, AsArray, BooleanArray, Decimal128Array, Float64Array, Int64Array, StringArray, UInt32Array};
use arrow::compute::SortOptions;
use arrow::compute::kernels::cmp;
use arrow::datatypes::{DataType, Field, Float64Type, Schema};
use parking_lot::Mutex;
use rayon::prelude::*;

use super::stats::extreme;
use crate::delta::stats::{Bound, Leaves, RawStats, parse_bound};
use crate::io::{ColumnStats, StatsAgg};
use crate::scalar::Scalar;

/// What the log says of one column, a value per file (null or `None`: it does not say).
#[derive(Debug, Default)]
struct Column {
    /// lower and upper bounds, as arrays of the column's type in the log
    bounds: [Option<ArrayRef>; 2],
    nulls: Option<Vec<Option<u64>>>,
}

#[derive(Debug, Default)]
pub struct LogStats {
    files: usize,
    rows: Vec<Option<u64>>,
    /// a file's bounds may be wider than its values (`tightBounds` is false: rows of it
    /// are deleted)
    wide: bool,
    /// by dotted path
    columns: HashMap<String, Column>,
    /// the bounds asked for so far, in the type they were asked in
    typed: Mutex<HashMap<String, [Option<ArrayRef>; 2]>>,
}

/// What the log says of an aggregate over the whole table.
#[derive(Debug)]
pub enum Answer {
    Exact(Scalar),
    /// the value is in one of these files (the log's bounds are not exact values)
    Files(Vec<usize>),
    Unknown,
}

/// Values of one type, one per file of a part of the table.
enum Values {
    Int(Vec<Option<i64>>),
    Float(Vec<Option<f64>>),
    Text(Vec<Option<String>>),
    Decimal(Vec<Option<i128>>),
}

impl Values {
    fn empty(like: &Bound, files: usize) -> Values {
        match like {
            Bound::Int(_) => Values::Int(vec![None; files]),
            Bound::Float(_) => Values::Float(vec![None; files]),
            Bound::Text(_) => Values::Text(vec![None; files]),
            Bound::Decimal(_) => Values::Decimal(vec![None; files]),
        }
    }

    fn set(&mut self, file: usize, bound: Bound) {
        match (self, bound) {
            (Values::Int(v), Bound::Int(b)) => v[file] = Some(b),
            (Values::Float(v), Bound::Float(b)) => v[file] = Some(b),
            (Values::Text(v), Bound::Text(b)) => v[file] = Some(b),
            (Values::Decimal(v), Bound::Decimal(b)) => v[file] = Some(b),
            // a column's bounds are of one kind (its type's)
            _ => {}
        }
    }

    /// The parts of a table one after the other (`None`: a part of that many files with
    /// no value), as an array of type `dt`.
    fn concat(parts: Vec<(Option<Values>, usize)>, dt: &DataType) -> Option<ArrayRef> {
        let kind = parts.iter().find_map(|(v, _)| v.as_ref())?;
        macro_rules! all {
            ($variant:ident) => {
                parts.iter().flat_map(|(v, files)| match v {
                    Some(Values::$variant(v)) => v.clone(),
                    _ => vec![None; *files],
                })
            };
        }
        let array: ArrayRef = match kind {
            Values::Int(_) => Arc::new(Int64Array::from_iter(all!(Int))),
            Values::Float(_) => Arc::new(Float64Array::from_iter(all!(Float))),
            Values::Text(_) => Arc::new(StringArray::from_iter(all!(Text))),
            Values::Decimal(_) => {
                let DataType::Decimal128(p, s) = dt else { return None };
                Arc::new(Decimal128Array::from_iter(all!(Decimal)).with_precision_and_scale(*p, *s).ok()?)
            }
        };
        if array.data_type() == dt { Some(array) } else { arrow::compute::cast(&array, dt).ok() }
    }
}

/// The statistics of some of a table's files, in order.
struct Part {
    rows: Vec<Option<u64>>,
    wide: bool,
    /// per leaf of the schema: lower bounds, upper bounds, null counts
    columns: Vec<(Option<Values>, Option<Values>, Option<Vec<Option<u64>>>)>,
}

impl Part {
    fn read(stats: &[Option<&str>], leaves: &Leaves) -> Part {
        let files = stats.len();
        let mut part = Part { rows: vec![None; files], wide: false, columns: leaves.columns.iter().map(|_| (None, None, None)).collect() };
        for (file, json) in stats.iter().enumerate() {
            // statistics that are not JSON say nothing of their file
            let Some(raw) = json.and_then(|json| serde_json::from_str::<RawStats>(json).ok()) else { continue };
            part.rows[file] = raw.num_records;
            part.wide |= raw.tight_bounds == Some(false);
            for (section, upper) in [(raw.min_values, false), (raw.max_values, true)] {
                let Some(section) = section else { continue };
                leaves.walk(section, &mut |column, text| {
                    let Some(bound) = parse_bound(&leaves.columns[column].1, text) else { return };
                    let side = if upper { &mut part.columns[column].1 } else { &mut part.columns[column].0 };
                    side.get_or_insert_with(|| Values::empty(&bound, files)).set(file, bound);
                });
            }
            if let Some(section) = raw.null_count {
                leaves.walk(section, &mut |column, text| {
                    if let Ok(n) = text.trim().parse::<u64>() {
                        part.columns[column].2.get_or_insert_with(|| vec![None; files])[file] = Some(n);
                    }
                });
            }
        }
        part
    }
}

impl LogStats {
    /// The statistics of each file of a table (the JSON text of its `add`; `None`: the
    /// log has none), typed by the table's `schema`. Entries of columns the schema
    /// lacks, or that are not of the column's type, are left out.
    pub fn parse(stats: &[Option<&str>], schema: &Schema) -> Self {
        let leaves = Leaves::of(schema);
        // the text is megabytes for a table of many files: every thread reads a share
        let share = stats.len().div_ceil(rayon::current_num_threads() * 4).max(256);
        let mut parts: Vec<Part> = stats.par_chunks(share).map(|files| Part::read(files, &leaves)).collect();
        let mut columns = HashMap::new();
        for (path, dt) in leaves.columns.iter().rev() {
            let (mut mins, mut maxs, mut nulls) = (vec![], vec![], vec![]);
            for part in &mut parts {
                let (min, max, null) = part.columns.pop().expect("a column per leaf");
                mins.push((min, part.rows.len()));
                maxs.push((max, part.rows.len()));
                nulls.push((null, part.rows.len()));
            }
            let nulls = nulls.iter().any(|(n, _)| n.is_some()).then(|| nulls.into_iter().flat_map(|(n, files)| n.unwrap_or_else(|| vec![None; files])).collect());
            let column = Column { bounds: [Values::concat(mins, dt), Values::concat(maxs, dt)], nulls };
            if column.bounds.iter().any(|b| b.is_some()) || column.nulls.is_some() {
                columns.insert(path.clone(), column);
            }
        }
        LogStats { files: stats.len(), rows: parts.iter().flat_map(|p| p.rows.iter().copied()).collect(), wide: parts.iter().any(|p| p.wide), columns, typed: Default::default() }
    }

    /// The statistics of some of the files, in the order given.
    pub fn select(&self, files: &[usize]) -> LogStats {
        let indices = UInt32Array::from_iter_values(files.iter().map(|&i| i as u32));
        let pick = |a: &Option<ArrayRef>| a.as_ref().and_then(|a| arrow::compute::take(a, &indices, None).ok());
        let columns = self
            .columns
            .iter()
            .map(|(name, c)| (name.clone(), Column { bounds: [pick(&c.bounds[0]), pick(&c.bounds[1])], nulls: c.nulls.as_ref().map(|n| files.iter().map(|&i| n[i]).collect()) }))
            .collect();
        LogStats { files: files.len(), rows: files.iter().map(|&i| self.rows[i]).collect(), wide: self.wide, columns, typed: Default::default() }
    }

    pub fn rows_of(&self, file: usize) -> Option<u64> {
        self.rows[file]
    }

    /// Rows of each file.
    pub fn row_counts(&self) -> Vec<Option<u64>> {
        self.rows.clone()
    }

    /// Nulls of a column in each file.
    pub fn null_counts(&self, column: &str) -> Vec<Option<u64>> {
        self.columns.get(column).and_then(|c| c.nulls.clone()).unwrap_or_else(|| vec![None; self.files])
    }

    /// Rows of the table, when every file has a count.
    pub fn rows(&self) -> Option<u64> {
        self.rows.iter().copied().sum()
    }

    /// The lower (or upper) bound of `field` in each file, as an array of
    /// its type with a null where the log has none. `None`: no file has one.
    pub fn bounds(&self, field: &Field, upper: bool) -> Option<ArrayRef> {
        let column = self.columns.get(field.name())?;
        // the log's types are the table's but for how the engine decodes strings
        let typed = |side: &Option<ArrayRef>| {
            let side = side.as_ref()?;
            if side.data_type() == field.data_type() { Some(side.clone()) } else { arrow::compute::cast(side, field.data_type()).ok() }
        };
        let mut cache = self.typed.lock();
        let sides = cache.entry(field.name().clone()).or_insert_with(|| [typed(&column.bounds[0]), typed(&column.bounds[1])]);
        sides[usize::from(upper)].clone().filter(|a| a.data_type() == field.data_type())
    }

    /// Whether the file has no value of the column: no rows, or only nulls.
    fn without_values(&self, file: usize, column: &str) -> bool {
        let Some(rows) = self.rows[file] else { return false };
        rows == 0 || self.columns.get(column).and_then(|c| c.nulls.as_ref()).is_some_and(|n| n[file] == Some(rows))
    }

    /// (min, max) of a column on the `ordinal_values` scale, over the files that have bounds.
    pub fn range(&self, field: &Field) -> Option<(f64, f64)> {
        let side = |upper: bool| -> Option<Vec<f64>> {
            let values = crate::io::ordinal_values(&self.bounds(field, upper)?)?;
            Some(values.as_primitive::<Float64Type>().iter().flatten().filter(|v| v.is_finite()).collect())
        };
        let lo = side(false)?.into_iter().fold(f64::INFINITY, f64::min);
        let hi = side(true)?.into_iter().fold(f64::NEG_INFINITY, f64::max);
        (lo <= hi).then_some((lo, hi))
    }

    /// An upper bound of the distinct values of a column: the width of an
    /// integer-like column's range (strings are unknown).
    pub fn ndv(&self, field: &Field, table_rows: usize) -> Option<f64> {
        let dt = field.data_type();
        if matches!(dt, DataType::Boolean) {
            return Some(2.0);
        }
        if !(dt.is_integer() || matches!(dt, DataType::Date32 | DataType::Date64 | DataType::Timestamp(_, _))) {
            return None;
        }
        let (lo, hi) = self.range(field)?;
        Some((hi - lo + 1.0).min(table_rows as f64).max(1.0))
    }

    /// Min / max / null counts of the top-level columns the log has statistics of.
    pub fn column_stats(&self, schema: &Schema) -> Vec<ColumnStats> {
        let one = |field: &Field| -> Option<ColumnStats> {
            let name = field.name();
            let (mins, maxs) = (self.bounds(field, false), self.bounds(field, true));
            let nulls = self.null_counts(name);
            if mins.is_none() && maxs.is_none() && nulls.iter().all(|n| n.is_none()) {
                return None;
            }
            let known = |side: &Option<ArrayRef>, i: usize| side.as_ref().is_some_and(|a| a.is_valid(i)) || self.without_values(i, name);
            let exact = (0..self.files).all(|i| nulls[i].is_some() && known(&mins, i) && known(&maxs, i));
            Some(ColumnStats {
                column: name.clone(),
                min: mins.as_ref().and_then(|a| extreme(a, false)),
                max: maxs.as_ref().and_then(|a| extreme(a, true)),
                nulls: nulls.iter().flatten().sum(),
                exact,
            })
        };
        schema.fields().iter().filter_map(|f| one(f)).collect()
    }

    /// An ungrouped aggregate over all the table's rows (`schema` is the files').
    pub fn aggregate(&self, schema: &Schema, agg: StatsAgg) -> Answer {
        let exact = |v: Option<u64>| v.map_or(Answer::Unknown, |v| Answer::Exact(Scalar::int64(v as i64)));
        match agg {
            StatsAgg::Rows => exact(self.rows()),
            StatsAgg::NonNull(c) => {
                let nulls: Option<u64> = self.null_counts(schema.field(c).name()).into_iter().sum();
                exact(self.rows().zip(nulls).and_then(|(rows, nulls)| rows.checked_sub(nulls)))
            }
            StatsAgg::Min(c) => self.extreme(schema.field(c), false).unwrap_or(Answer::Unknown),
            StatsAgg::Max(c) => self.extreme(schema.field(c), true).unwrap_or(Answer::Unknown),
        }
    }

    /// The smallest (or largest) value of a column. The log's bounds are the
    /// values themselves for integers, dates and decimals; timestamps are
    /// rounded to the millisecond there, so their bounds only say which files
    /// can hold the value. Not floats (NaN is outside the bounds) nor strings
    /// (cut short).
    fn extreme(&self, field: &Field, largest: bool) -> Option<Answer> {
        let dt = field.data_type();
        let exact = dt.is_integer() || matches!(dt, DataType::Date32 | DataType::Decimal128(_, _));
        if !exact && !matches!(dt, DataType::Date64 | DataType::Timestamp(_, _)) {
            return None;
        }
        let name = field.name();
        let unknown = |side: &Option<ArrayRef>, i: usize| !side.as_ref().is_some_and(|a| a.is_valid(i)) && !self.without_values(i, name);
        let (mins, maxs) = (self.bounds(field, false), self.bounds(field, true));
        let (toward, away) = if largest { (&maxs, &mins) } else { (&mins, &maxs) };
        if exact && !self.wide && (0..self.files).all(|i| !unknown(toward, i)) {
            let value = toward.as_ref().and_then(|a| pick(a, largest));
            return Some(Answer::Exact(value.unwrap_or_else(|| Scalar::null_of(dt))));
        }
        // a file whose bound on the far side is the best holds a value at least that good:
        // files that cannot reach it are out
        let reach = away.as_ref().and_then(|a| pick(a, largest));
        let within: Option<BooleanArray> = match (toward, &reach) {
            (Some(bounds), Some(reach)) if largest => cmp::gt_eq(bounds, reach).ok(),
            (Some(bounds), Some(reach)) => cmp::lt_eq(bounds, reach).ok(),
            _ => None,
        };
        let may_hold = |i: usize| match &within {
            Some(w) => !w.is_valid(i) || w.value(i),
            None => true,
        };
        Some(Answer::Files((0..self.files).filter(|&i| !self.without_values(i, name) && may_hold(i)).collect()))
    }
}

/// The smallest (or largest) non-null value of an array.
fn pick(a: &ArrayRef, largest: bool) -> Option<Scalar> {
    let order = SortOptions { descending: largest, nulls_first: false };
    let idx = arrow::compute::sort_to_indices(a, Some(order), Some(1)).ok()?;
    let i = idx.values().first().copied()? as usize;
    if a.is_null(i) { None } else { Scalar::from_array(a.as_ref(), i).ok() }
}

#[cfg(test)]
mod tests {
    use arrow::datatypes::TimeUnit;

    use super::*;
    use crate::delta::stats::FileStats;

    fn file(rows: u64, id: Option<(i64, i64)>, at: Option<(i64, i64)>, id_nulls: u64) -> Option<String> {
        let mut s = FileStats { num_records: Some(rows), ..Default::default() };
        s.null_count.insert("id".into(), id_nulls);
        if let Some((lo, hi)) = id {
            s.min.insert("id".into(), Scalar::int64(lo));
            s.max.insert("id".into(), Scalar::int64(hi));
        }
        if let Some((lo, hi)) = at {
            s.min.insert("at".into(), Scalar::timestamp_us(lo, None));
            s.max.insert("at".into(), Scalar::timestamp_us(hi, None));
        }
        Some(s.to_json())
    }

    fn schema() -> Schema {
        Schema::new(vec![Field::new("id", DataType::Int64, true), Field::new("at", DataType::Timestamp(TimeUnit::Microsecond, None), true)])
    }

    fn log(files: Vec<Option<String>>) -> LogStats {
        let text: Vec<Option<&str>> = files.iter().map(|f| f.as_deref()).collect();
        LogStats::parse(&text, &schema())
    }

    #[test]
    fn counts_and_integer_extremes_are_exact() {
        let log = log(vec![file(10, Some((5, 20)), None, 0), file(4, None, None, 4), file(6, Some((-3, 7)), None, 1)]);
        let s = schema();
        let value = |agg| match log.aggregate(&s, agg) {
            Answer::Exact(v) => v.as_i64(),
            other => panic!("{other:?}"),
        };
        assert_eq!(value(StatsAgg::Rows), Some(20));
        assert_eq!(value(StatsAgg::NonNull(0)), Some(15));
        assert_eq!(value(StatsAgg::Min(0)), Some(-3));
        assert_eq!(value(StatsAgg::Max(0)), Some(20));
        assert_eq!(log.range(s.field(0)), Some((-3.0, 20.0)));
        assert_eq!(log.ndv(s.field(0), 20), Some(20.0));
        let stats = log.column_stats(&s);
        assert_eq!((stats[0].min.as_deref(), stats[0].max.as_deref(), stats[0].nulls, stats[0].exact), (Some("-3"), Some("20"), 5, true));
        // some of the files, in another order
        let some = log.select(&[2, 0]);
        assert_eq!((some.rows(), some.rows_of(0), some.null_counts("id")), (Some(16), Some(6), vec![Some(1), Some(0)]));
        assert_eq!(some.range(s.field(0)), Some((-3.0, 20.0)));
        assert!(matches!(log.select(&[1]).aggregate(&s, StatsAgg::Max(0)), Answer::Exact(v) if v.is_null()));
    }

    #[test]
    fn a_file_without_statistics_leaves_the_table_unknown() {
        let log = log(vec![file(10, Some((5, 20)), None, 0), None, Some("not json".into())]);
        let s = schema();
        assert!(matches!(log.aggregate(&s, StatsAgg::Rows), Answer::Unknown));
        // the files without bounds, and the one that reaches the best known value, can hold it
        assert!(matches!(log.aggregate(&s, StatsAgg::Max(0)), Answer::Files(f) if f == vec![0, 1, 2]));
        assert_eq!(log.range(s.field(0)), Some((5.0, 20.0)));
        assert!(!log.column_stats(&s)[0].exact);
    }

    #[test]
    fn timestamps_name_the_files_that_can_hold_the_extreme() {
        let log = log(vec![file(5, None, Some((0, 999_000)), 0), file(5, None, Some((1_000_000, 5_000_000)), 0), file(5, None, Some((4_000_000, 6_000_000)), 0)]);
        let s = schema();
        assert!(matches!(log.aggregate(&s, StatsAgg::Max(1)), Answer::Files(f) if f == vec![1, 2]));
        assert!(matches!(log.aggregate(&s, StatsAgg::Min(1)), Answer::Files(f) if f == vec![0]));
    }

    #[test]
    fn rows_deleted_from_a_file_leave_its_bounds_wide() {
        let wide = r#"{"numRecords":3,"tightBounds":false,"minValues":{"id":1},"maxValues":{"id":9},"nullCount":{"id":0}}"#;
        let log = log(vec![file(10, Some((5, 20)), None, 0), Some(wide.into())]);
        assert!(matches!(log.aggregate(&schema(), StatsAgg::Min(0)), Answer::Files(f) if f == vec![0, 1]));
    }

    #[test]
    fn many_files_are_read_in_parts() {
        let files: Vec<Option<String>> = (0..5_000).map(|i| if i % 1000 == 7 { None } else { file(2, Some((i, i + 1)), None, 0) }).collect();
        let log = log(files);
        assert_eq!((log.rows_of(4_999), log.rows_of(1_007), log.rows()), (Some(2), None, None));
        let s = schema();
        let mins = log.bounds(s.field(0), false).unwrap();
        let mins = mins.as_primitive::<arrow::datatypes::Int64Type>();
        assert_eq!((mins.len(), mins.value(0), mins.value(4_999), mins.is_null(2_007)), (5_000, 0, 4_999, true));
        assert_eq!(log.range(s.field(0)), Some((0.0, 5_000.0)));
    }
}
