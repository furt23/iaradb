//! Column statistics for the optimizer: distinct-count and range estimates
//! from row-group statistics (and a sample for strings).

use std::sync::Arc;

use arrow::array::{Array, ArrayRef, AsArray};
use arrow::compute::SortOptions;
use arrow::datatypes::{DataType, Int64Type, SchemaRef};
use arrow::util::display::array_value_to_string;
use parquet::arrow::ProjectionMask;
use parquet::arrow::arrow_reader::statistics::StatisticsConverter;

use super::decode::{chunk_ranges, reader};
use super::file::ParquetFile;
use super::sample_cache;
use crate::io::ColumnStats;

/// Distinct count of a string column, extrapolated from its first row
/// group: repetitive columns (flags, names, types) keep the sample's count,
/// unique-ish ones scale with the table size.
pub fn sample_ndv(files: &[Arc<ParquetFile>], column: usize, table_rows: usize) -> Option<f64> {
    let f = files.first()?;
    let (distinct, rows) = sample_cache::get_or_compute(f.blob.object().map(|o| o.version_key()), column, || sample(f, column))?;
    let (d, n) = (distinct as f64, rows as f64);
    Some(if d < n * 0.5 { d } else { d / n * table_rows as f64 })
}

/// (distinct values, rows) among the first rows of the file's first row group.
fn sample(f: &ParquetFile, column: usize) -> Option<(usize, usize)> {
    if f.meta.metadata().num_row_groups() == 0 {
        return None;
    }
    let mask = ProjectionMask::roots(f.meta.parquet_schema(), [column]);
    let input = f.blob.read(&chunk_ranges(&f.meta, 0, &mask), None).ok()?;
    let rows = reader(input, &f.meta, mask, 0).with_batch_size(1 << 16).with_limit(1 << 17).build().ok()?;
    let mut seen = hashbrown::HashSet::new();
    let mut n = 0usize;
    for b in rows {
        let b = b.ok()?;
        let mut hashes = vec![];
        crate::hash::hash_columns(&b.columns()[..1], &mut hashes).ok()?;
        n += hashes.len();
        seen.extend(hashes);
    }
    (n > 0).then_some((seen.len(), n))
}

/// Whether [`ndv`] of the column reads the statistics of every file (a
/// sample of the first one answers for strings).
pub fn reads_all_files(schema: &SchemaRef, column: usize) -> bool {
    let dt = schema.field(column).data_type();
    dt.is_integer() || matches!(dt, DataType::Date32 | DataType::Date64 | DataType::Timestamp(_, _))
}

/// Distinct-count estimate: from a sample for strings, and an upper bound
/// for integer-like columns (NDV <= max - min + 1, e.g. a nation key has at
/// most 25 values).
pub fn ndv(files: &[Arc<ParquetFile>], schema: &SchemaRef, column: usize, table_rows: usize) -> Option<f64> {
    let field = schema.field(column);
    let dt = field.data_type();
    if matches!(dt, DataType::Boolean) {
        return Some(2.0);
    }
    if matches!(dt, DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View | DataType::Binary | DataType::BinaryView) {
        return sample_ndv(files, column, table_rows);
    }
    let int_like = dt.is_integer() || matches!(dt, DataType::Date32 | DataType::Date64 | DataType::Timestamp(_, _));
    if !int_like {
        return None;
    }
    let (mut mn, mut mx) = (i64::MAX, i64::MIN);
    for f in files {
        let rgs = f.meta.metadata().row_groups();
        let conv = StatisticsConverter::try_new(field.name(), f.meta.schema(), f.meta.parquet_schema()).ok()?;
        let mins = arrow::compute::cast(&conv.row_group_mins(rgs.iter()).ok()?, &DataType::Int64).ok()?;
        let maxs = arrow::compute::cast(&conv.row_group_maxes(rgs.iter()).ok()?, &DataType::Int64).ok()?;
        if mins.null_count() > 0 || maxs.null_count() > 0 {
            return None;
        }
        mn = mn.min(arrow::compute::min(mins.as_primitive::<Int64Type>())?);
        mx = mx.max(arrow::compute::max(maxs.as_primitive::<Int64Type>())?);
    }
    if mn > mx {
        return None;
    }
    let range = (mx as i128 - mn as i128 + 1) as f64;
    Some(range.min(table_rows as f64).max(1.0))
}

/// (min, max) of an ordered column on the `ordinal_values` scale.
pub fn range(files: &[Arc<ParquetFile>], schema: &SchemaRef, column: usize) -> Option<(f64, f64)> {
    let field = schema.field(column);
    let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
    for f in files {
        let rgs = f.meta.metadata().row_groups();
        let conv = StatisticsConverter::try_new(field.name(), f.meta.schema(), f.meta.parquet_schema()).ok()?;
        let mins = conv.row_group_mins(rgs.iter()).ok()?;
        let maxs = conv.row_group_maxes(rgs.iter()).ok()?;
        let (a, b) = crate::io::ordinal_min_max(&mins, &maxs)?;
        lo = lo.min(a);
        hi = hi.max(b);
    }
    (lo <= hi).then_some((lo, hi))
}

/// Min / max / null counts of every top-level column over all row groups.
pub fn column_stats(files: &[Arc<ParquetFile>], schema: &SchemaRef) -> Vec<ColumnStats> {
    schema.fields().iter().filter_map(|f| one_column_stats(files, f.name())).collect()
}

fn one_column_stats(files: &[Arc<ParquetFile>], name: &str) -> Option<ColumnStats> {
    let (mut mins, mut maxs, mut nulls) = (vec![], vec![], 0u64);
    for f in files {
        let rgs = f.meta.metadata().row_groups();
        let conv = StatisticsConverter::try_new(name, f.meta.schema(), f.meta.parquet_schema()).ok()?;
        mins.push(conv.row_group_mins(rgs.iter()).ok()?);
        maxs.push(conv.row_group_maxes(rgs.iter()).ok()?);
        nulls += conv.row_group_null_counts(rgs.iter()).ok()?.iter().flatten().sum::<u64>();
    }
    let (mins, maxs) = (concat(&mins)?, concat(&maxs)?);
    let exact = mins.null_count() == 0 && maxs.null_count() == 0;
    Some(ColumnStats { column: name.to_string(), min: extreme(&mins, false), max: extreme(&maxs, true), nulls, exact })
}

fn concat(arrays: &[ArrayRef]) -> Option<ArrayRef> {
    let refs: Vec<&dyn Array> = arrays.iter().map(|a| a.as_ref()).collect();
    arrow::compute::concat(&refs).ok()
}

/// The smallest (or largest) non-null value, displayed.
fn extreme(a: &ArrayRef, largest: bool) -> Option<String> {
    let order = SortOptions { descending: largest, nulls_first: false };
    let idx = arrow::compute::sort_to_indices(a, Some(order), Some(1)).ok()?;
    let i = idx.values().first().copied()? as usize;
    (!a.is_null(i)).then(|| array_value_to_string(a, i).ok()).flatten()
}
