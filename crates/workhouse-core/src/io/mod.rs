//! Table providers (data sources) and writers.

pub mod blob;
pub mod csv;
pub mod dataset;
pub mod json;
pub mod listing;
pub mod location;
pub mod memory;
pub mod object;
pub mod options;
pub mod output;
pub mod parquet;
pub mod partition;
pub mod work_table;

use std::fmt::Debug;
use std::sync::Arc;

use arrow::datatypes::SchemaRef;

use crate::error::Result;
use crate::exec::pipeline::Source;
use crate::expr::Expr;

pub use blob::DataFile;
pub use listing::{expand_paths, list_files};
pub use location::{Location, is_remote};
pub use options::StorageOptions;

/// Statistics of one top-level column over all of a table's files.
#[derive(Debug, Clone, PartialEq)]
pub struct ColumnStats {
    pub column: String,
    /// Display form of the smallest / largest value (None = unknown).
    pub min: Option<String>,
    pub max: Option<String>,
    pub nulls: u64,
    /// Every row group had statistics for the column.
    pub exact: bool,
}

pub trait TableProvider: Send + Sync + Debug {
    fn schema(&self) -> SchemaRef;
    fn num_rows(&self) -> Option<usize>;
    fn kind(&self) -> &'static str;
    /// Estimated number of distinct values of a column (None = unknown).
    fn column_ndv(&self, _column: usize) -> Option<f64> {
        None
    }
    /// (min, max) of an ordered column on the `ordinal_values` scale (None = unknown).
    fn column_range(&self, _column: usize) -> Option<(f64, f64)> {
        None
    }
    /// Per-column min / max / null counts from file metadata (None = not
    /// available for this kind of table).
    fn column_stats(&self) -> Option<Vec<ColumnStats>> {
        None
    }
    /// Where the table's files live, when it is a folder of Parquet files
    /// that rows can be added to.
    fn location(&self) -> Option<dataset::TableLocation> {
        None
    }
    /// The table as a Delta table, when it is one (its root, storage and snapshot).
    fn as_delta(&self) -> Option<&crate::delta::DeltaTable> {
        None
    }
    /// The rows of an in-memory table.
    fn memory_batches(&self) -> Option<&[arrow::record_batch::RecordBatch]> {
        None
    }
    /// Create a parallel source. `filters` are pruning hints expressed over
    /// the table's (unqualified) columns; they need not be applied exactly.
    fn create_source(
        &self,
        projection: Option<&[usize]>,
        filters: &[Expr],
        fetch: Option<usize>,
    ) -> Result<Arc<dyn Source>>;
}

/// Numbers, dates, times and timestamps as Float64 on their native scale
/// (days, units since epoch, ...), for range-selectivity estimates.
pub fn ordinal_values(a: &arrow::array::ArrayRef) -> Option<arrow::array::ArrayRef> {
    use arrow::compute::cast;
    use arrow::datatypes::DataType;
    let a = match a.data_type() {
        DataType::Date32 | DataType::Time32(_) => cast(a, &DataType::Int32).ok()?,
        DataType::Date64 | DataType::Timestamp(_, _) | DataType::Time64(_) | DataType::Duration(_) => {
            cast(a, &DataType::Int64).ok()?
        }
        d if d.is_numeric() => a.clone(),
        _ => return None,
    };
    cast(&a, &DataType::Float64).ok()
}

/// (min, max) over ordinal arrays; None if empty or any value is unknown.
pub fn ordinal_min_max(mins: &arrow::array::ArrayRef, maxs: &arrow::array::ArrayRef) -> Option<(f64, f64)> {
    use arrow::array::{Array, AsArray};
    use arrow::datatypes::Float64Type;
    let (mins, maxs) = (ordinal_values(mins)?, ordinal_values(maxs)?);
    if mins.null_count() > 0 || maxs.null_count() > 0 {
        return None;
    }
    let lo = mins.as_primitive::<Float64Type>().values().iter().copied().fold(f64::INFINITY, f64::min);
    let hi = maxs.as_primitive::<Float64Type>().values().iter().copied().fold(f64::NEG_INFINITY, f64::max);
    (lo <= hi).then_some((lo, hi))
}
