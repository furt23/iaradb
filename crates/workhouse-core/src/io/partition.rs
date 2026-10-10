//! Hive-style partitioned datasets: `table/year=2024/month=05/part-0.parquet`.
//!
//! The `key=value` folders of every file become columns of the table (after
//! the files' own columns). Their values are known per file before any of it
//! is read, so filters on them skip whole files.

use std::collections::HashSet;
use std::sync::Arc;

use arrow::array::{Array, ArrayRef, BooleanArray, Date32Array, Int64Array, StringViewArray};
use arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use arrow::util::display::array_value_to_string;

use crate::error::Result;
use crate::expr::{Expr, split_conjunction};
use crate::io::ColumnStats;
use crate::physical::expr::create_physical_expr;
use crate::schema::PlanSchema;

/// The value Hive writes for a null partition value.
pub const NULL_PARTITION: &str = "__HIVE_DEFAULT_PARTITION__";

/// Partition columns of a set of files: one row of `values` per file.
#[derive(Debug, Clone)]
pub struct Partitions {
    pub values: RecordBatch,
}

impl Partitions {
    pub fn schema(&self) -> SchemaRef {
        self.values.schema()
    }

    /// Which files may hold rows passing `filters` (the conjuncts that only
    /// read partition columns decide; the others keep every file).
    pub fn keep(&self, filters: &[Expr]) -> Vec<bool> {
        let n = self.values.num_rows();
        let mut keep = vec![true; n];
        let plan = PlanSchema::from_arrow(None, &self.schema());
        for f in filters.iter().flat_map(split_conjunction) {
            let Ok(e) = create_physical_expr(&f, &plan) else { continue };
            let Ok(result) = e.evaluate_array(&self.values) else { continue };
            let Some(mask) = result.as_any().downcast_ref::<BooleanArray>() else { continue };
            for (i, k) in keep.iter_mut().enumerate() {
                // a null or false predicate passes no row of the file
                if mask.is_null(i) || !mask.value(i) {
                    *k = false;
                }
            }
        }
        keep
    }

    /// The partition values of the kept files.
    pub fn select(&self, keep: &[bool]) -> Result<Partitions> {
        let mask = BooleanArray::from(keep.to_vec());
        Ok(Partitions { values: arrow::compute::filter_record_batch(&self.values, &mask)? })
    }

    /// Distinct values of partition column `j`.
    pub fn ndv(&self, j: usize) -> f64 {
        let col = self.values.column(j);
        let seen: HashSet<String> = (0..col.len()).filter(|&i| col.is_valid(i)).filter_map(|i| array_value_to_string(col, i).ok()).collect();
        seen.len() as f64
    }

    /// (min, max) of partition column `j` on the ordinal scale (numbers, dates).
    pub fn range(&self, j: usize) -> Option<(f64, f64)> {
        let v = crate::io::ordinal_values(self.values.column(j))?;
        let v = v.as_any().downcast_ref::<arrow::array::Float64Array>()?;
        let (lo, hi) = v.iter().flatten().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), x| (lo.min(x), hi.max(x)));
        (lo <= hi).then_some((lo, hi))
    }

    /// Statistics of partition column `j` (exact: every file's value is known).
    pub fn stats(&self, j: usize) -> ColumnStats {
        let col = self.values.column(j);
        let order = arrow::compute::sort_to_indices(col, None, None).ok();
        let valid: Vec<usize> = order.map(|o| o.values().iter().map(|&i| i as usize).filter(|&i| col.is_valid(i)).collect()).unwrap_or_default();
        let show = |i: Option<&usize>| i.and_then(|&i| array_value_to_string(col, i).ok());
        ColumnStats { column: self.schema().field(j).name().clone(), min: show(valid.first()), max: show(valid.last()), nulls: 0, exact: true }
    }
}

/// The folders a table's files live under: its path up to any glob.
fn root_of(pattern: &str) -> String {
    let p = pattern.replace('\\', "/");
    match p.find(['*', '?', '[']) {
        Some(i) => p[..p[..i].rfind('/').map_or(0, |j| j + 1)].to_string(),
        None => p,
    }
}

/// `key=value` folders of a file path or URL below `root`, outermost first.
fn segments(root: &str, path: &str) -> Vec<(String, String)> {
    let path = path.replace('\\', "/");
    let below = path.strip_prefix(root).unwrap_or(&path);
    let parts: Vec<&str> = below.split('/').collect();
    let folders = &parts[..parts.len().saturating_sub(1)];
    folders
        .iter()
        .filter_map(|s| s.split_once('='))
        .filter(|(k, _)| !k.is_empty())
        .map(|(k, v)| (k.to_string(), unescape(v)))
        .collect()
}

/// Undo Hive's escaping of special characters (`%2F` for `/` ...).
pub fn unescape(v: &str) -> String {
    let bytes = v.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(b) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| v.to_string())
}

/// Escape a partition value for a folder name (Hive's set of special characters).
pub fn escape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    for c in v.chars() {
        if c.is_control() || "\"#%'*/:=?\\\u{7f}{[]^".contains(c) {
            for b in c.to_string().bytes() {
                out.push_str(&format!("%{b:02X}"));
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn parse_date(v: &str) -> Option<i32> {
    let d = chrono::NaiveDate::parse_from_str(v, "%Y-%m-%d").ok()?;
    let epoch = chrono::NaiveDate::from_ymd_opt(1970, 1, 1)?;
    Some((d - epoch).num_days() as i32)
}

/// A column of partition values: integers, dates, else strings.
fn column(values: &[Option<String>]) -> (DataType, ArrayRef) {
    let present = || values.iter().flatten();
    if present().all(|v| v.parse::<i64>().is_ok()) {
        let a: Int64Array = values.iter().map(|v| v.as_ref().and_then(|v| v.parse().ok())).collect();
        return (DataType::Int64, Arc::new(a));
    }
    if present().all(|v| v.len() == 10 && parse_date(v).is_some()) {
        let a: Date32Array = values.iter().map(|v| v.as_deref().and_then(parse_date)).collect();
        return (DataType::Date32, Arc::new(a));
    }
    let a: StringViewArray = values.iter().map(|v| v.as_deref()).collect();
    (DataType::Utf8View, Arc::new(a))
}

/// The partition columns of the `files` (paths or URLs) a table `pattern`
/// names, if every file sits in the same `key=value` folders below it; keys
/// the files already hold as columns are left to the files.
pub fn detect(pattern: &str, files: &[&str], file_schema: &Schema) -> Result<Option<Partitions>> {
    let root = root_of(pattern);
    let per_file: Vec<Vec<(String, String)>> = files.iter().map(|f| segments(&root, f)).collect();
    let Some(first) = per_file.first() else { return Ok(None) };
    let keys: Vec<&String> = first.iter().map(|(k, _)| k).collect();
    if keys.is_empty() || per_file.iter().any(|s| s.len() != keys.len() || s.iter().zip(&keys).any(|((k, _), want)| k != *want)) {
        return Ok(None);
    }
    let mut fields = vec![];
    let mut arrays = vec![];
    for (i, key) in keys.iter().enumerate() {
        if file_schema.field_with_name(key).is_ok() {
            continue;
        }
        let values: Vec<Option<String>> = per_file.iter().map(|s| Some(s[i].1.clone()).filter(|v| v != NULL_PARTITION)).collect();
        let (dt, array) = column(&values);
        fields.push(Field::new(key.as_str(), dt, true));
        arrays.push(array);
    }
    if fields.is_empty() {
        return Ok(None);
    }
    let opts = RecordBatchOptions::new().with_row_count(Some(files.len()));
    let values = RecordBatch::try_new_with_options(Arc::new(Schema::new(fields)), arrays, &opts)?;
    Ok(Some(Partitions { values }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::expr::{col, lit};
    use crate::scalar::Scalar;

    fn files() -> Vec<&'static str> {
        vec![
            "s3://b/sales/year=2023/region=north/part-0.parquet",
            "s3://b/sales/year=2024/region=north/part-0.parquet",
            "s3://b/sales/year=2024/region=s%2Fe/part-0.parquet",
            "s3://b/sales/year=2024/region=__HIVE_DEFAULT_PARTITION__/part-0.parquet",
        ]
    }

    #[test]
    fn detects_typed_partition_columns() {
        let file_schema = Schema::new(vec![Field::new("amount", DataType::Float64, true)]);
        let p = detect("s3://b/sales/", &files(), &file_schema).unwrap().unwrap();
        let s = p.schema();
        assert_eq!(s.field(0).data_type(), &DataType::Int64);
        assert_eq!(s.field(1).data_type(), &DataType::Utf8View);
        let regions = p.values.column(1).as_any().downcast_ref::<StringViewArray>().unwrap();
        assert_eq!(regions.value(2), "s/e");
        assert!(regions.is_null(3));
    }

    #[test]
    fn skips_files_by_partition_filters() {
        let p = detect("s3://b/sales", &files(), &Schema::empty()).unwrap().unwrap();
        assert_eq!(p.keep(&[col("year").eq(lit(Scalar::int64(2024)))]), vec![false, true, true, true]);
        // nulls never pass a comparison; other columns' filters keep everything
        assert_eq!(p.keep(&[col("region").eq(lit(Scalar::utf8("north"))).and(col("amount").gt(lit(Scalar::int64(1))))]), vec![true, true, false, false]);
    }

    #[test]
    fn plain_or_inconsistent_folders_are_not_partitions() {
        assert!(detect("data", &["data/a.parquet", "data/b.parquet"], &Schema::empty()).unwrap().is_none());
        assert!(detect("t", &["t/x=1/a.parquet", "t/y=1/b.parquet"], &Schema::empty()).unwrap().is_none());
        let in_file = Schema::new(vec![Field::new("x", DataType::Int64, true)]);
        assert!(detect("t", &["t/x=1/a.parquet"], &in_file).unwrap().is_none());
        // folders above the table are not its partitions
        assert!(detect(r"c:\ws\a=b\t", &[r"c:\ws\a=b\t\f.parquet"], &Schema::empty()).unwrap().is_none());
        let globbed = detect("ws/k=v/t/*/*.parquet", &["ws/k=v/t/y=1/f.parquet"], &Schema::empty()).unwrap().unwrap();
        assert_eq!(globbed.schema().fields().len(), 1);
        assert_eq!(globbed.schema().field(0).name(), "y");
    }

    #[test]
    fn dates_and_escapes_round_trip() {
        let p = detect("t", &["t/day=2024-05-01/a.parquet"], &Schema::empty()).unwrap().unwrap();
        assert_eq!(p.schema().field(0).data_type(), &DataType::Date32);
        assert_eq!(unescape(&escape("a/b=c%d")), "a/b=c%d");
        assert_eq!(escape("a/b"), "a%2Fb");
    }
}
