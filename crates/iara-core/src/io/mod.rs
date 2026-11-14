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

/// An ungrouped aggregate of a whole table that metadata may answer
/// ([`TableProvider::stats_aggregates`]); columns are the table's.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StatsAgg {
    /// `COUNT(*)`
    Rows,
    /// `COUNT(column)`
    NonNull(usize),
    Min(usize),
    Max(usize),
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
    /// The values of ungrouped aggregates over the whole table, answered
    /// from file metadata; None unless the metadata gives every one exactly.
    fn stats_aggregates(&self, _aggs: &[StatsAgg]) -> Option<Vec<crate::scalar::Scalar>> {
        None
    }
    /// Where the table's files live, when it is a folder of Parquet files
    /// that rows can be added to.
    fn location(&self) -> Option<dataset::TableLocation> {
        None
    }
    /// What a query that scans the table reads: its location and Delta version (None: not a
    /// table of storage, or only the inner part of one).
    fn origin(&self) -> Option<crate::exec::query::TableRead> {
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
    /// Rows addressable by position, for late materialization (None: this
    /// kind of table cannot).
    fn late_rows(&self) -> Option<Arc<dyn LateRows>> {
        None
    }
    /// A source like [`Self::create_source`] that drops rows while it reads:
    /// rows past a top k's running bound, and rows whose key is not among a
    /// hash join's build keys (None: this kind of table cannot).
    fn create_gated_source(
        &self,
        _projection: Option<&[usize]>,
        _filters: &[Expr],
        _bound: Option<&ScanBound>,
        _joins: &[ScanJoinKeys],
    ) -> Option<Result<Arc<dyn Source>>> {
        None
    }
}

/// A top k's running bound on a column of the scanned table (see
/// [`crate::exec::topk_bound`]).
#[derive(Debug, Clone)]
pub struct ScanBound {
    pub column: usize,
    pub bound: Arc<crate::exec::topk_bound::TopKBound>,
}

/// The build keys of a hash join on a column of the scanned table (see
/// [`crate::exec::join_filter`]).
#[derive(Debug, Clone)]
pub struct ScanJoinKeys {
    pub column: usize,
    pub keys: Arc<crate::exec::join_filter::JoinKeyFilter>,
}

/// A table whose rows can be read by position: a scan emitting each row's
/// position (a last UInt64 column), and the other columns of given rows.
pub trait LateRows: Send + Sync {
    fn positioned_source(&self, projection: &[usize], filters: &[Expr], bound: Option<&ScanBound>) -> Result<Arc<dyn Source>>;
    /// Columns `projection` of the rows at `positions`, in that order.
    fn fetch(&self, projection: &[usize], positions: &[u64]) -> Result<arrow::record_batch::RecordBatch>;
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
