//! `OPTIMIZE`: compact the small files of a table. In every partition the
//! files smaller than the target size are bin-packed into new files of about
//! that size; one commit removes the old files and adds the new ones, all with
//! `dataChange: false` (the rows are the same). Readers of older versions
//! still find the old files until `VACUUM`.
//!
//! The commit does not read the table in the conflict sense
//! ([`Transaction::reads_table`]): blind appends meanwhile are harmless, a
//! concurrent commit that removed one of the compacted files is a conflict.

use std::collections::BTreeMap;
use std::sync::Arc;

use arrow::array::{Array, ArrayRef, Int64Array, StringArray};
use arrow::compute::cast;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;

use super::{check_writable, now_ms};
use crate::delta::actions::{Action, Add, PartitionValues, Remove};
use crate::delta::log_store::LogStore;
use crate::delta::provider::DeltaTable;
use crate::delta::snapshot::Snapshot;
use crate::delta::txn::Transaction;
use crate::delta::write_files::write_data_files;
use crate::error::{Result, WhError};
use crate::expr::{Expr, col};
use crate::io::memory::MemTable;
use crate::io::options::StorageOptions;
use crate::session::SessionContext;

/// Files smaller than this are compacted, into files of about this size.
pub const DEFAULT_TARGET_FILE_SIZE: u64 = 128 * 1024 * 1024;

/// What an `OPTIMIZE` did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OptimizeSummary {
    /// the table's version after it (the existing one when nothing was compacted)
    pub version: u64,
    pub files_removed: usize,
    pub files_added: usize,
    pub bytes_removed: u64,
    pub bytes_added: u64,
    pub partitions_optimized: usize,
    /// no commit was made: no partition had two files to combine
    pub skipped: bool,
}

/// Compact the small files of the table at `location`. `target_file_size`
/// (default [`DEFAULT_TARGET_FILE_SIZE`]) is both the size under which a file
/// is small and the size the new files are packed up to; `predicate` limits
/// the partitions to compact and may only use partition columns.
pub fn optimize(ctx: &SessionContext, location: &str, storage: &StorageOptions, target_file_size: Option<u64>, predicate: Option<&Expr>) -> Result<OptimizeSummary> {
    let target = target_file_size.unwrap_or(DEFAULT_TARGET_FILE_SIZE);
    if target == 0 {
        return Err(WhError::Plan("OPTIMIZE: the target file size must be positive".into()));
    }
    let log = LogStore::open(location, storage)?;
    let snapshot = Snapshot::load(&log, None)?;
    check_writable(&snapshot)?;

    let mut groups: BTreeMap<&PartitionValues, Vec<&Add>> = BTreeMap::new();
    for add in &snapshot.files {
        groups.entry(&add.partition_values).or_default().push(add);
    }
    let selected = match predicate {
        Some(p) => matching_partitions(ctx, &snapshot, &groups.keys().copied().collect::<Vec<_>>(), p)?,
        None => vec![true; groups.len()],
    };

    // (partition, files to combine into one)
    let mut bins: Vec<(usize, Vec<&Add>)> = vec![];
    for (i, ((_, files), selected)) in groups.into_iter().zip(selected).enumerate() {
        if !selected {
            continue;
        }
        let mut small: Vec<&Add> = files.into_iter().filter(|a| (a.size.max(0) as u64) < target && a.deletion_vector.is_none()).collect();
        if small.len() < 2 {
            continue;
        }
        small.sort_by(|a, b| a.size.cmp(&b.size).then_with(|| a.path.cmp(&b.path)));
        bins.extend(pack(small, target).into_iter().filter(|b| b.len() >= 2).map(|b| (i, b)));
    }
    if bins.is_empty() {
        return Ok(OptimizeSummary { version: snapshot.version, files_removed: 0, files_added: 0, bytes_removed: 0, bytes_added: 0, partitions_optimized: 0, skipped: true });
    }

    // dropped (and so deleted) unless the commit succeeds
    let mut written = vec![];
    let (mut adds, mut removes) = (vec![], vec![]);
    let now = now_ms();
    for (_, bin) in &bins {
        let part = Snapshot {
            version: snapshot.version,
            protocol: snapshot.protocol.clone(),
            metadata: snapshot.metadata.clone(),
            schema: snapshot.schema.clone(),
            partition_columns: snapshot.partition_columns.clone(),
            files: bin.iter().map(|a| (*a).clone()).collect(),
            txns: vec![],
            timestamp: snapshot.timestamp,
        };
        let lf = ctx.scan_provider("optimize", Arc::new(DeltaTable::from_snapshot(location, storage, part)?))?;
        let data = write_data_files(&lf, location, storage, &snapshot.partition_columns, &snapshot.schema)?;
        adds.extend(data.adds.iter().cloned().map(|mut a| {
            a.data_change = false;
            a
        }));
        removes.extend(bin.iter().map(|a| Remove::of(a, now, false)));
        written.push(data);
    }

    let sizes = |sizes: Vec<i64>| (sizes.iter().copied().min().unwrap_or(0), sizes.iter().copied().max().unwrap_or(0));
    let (added_min, added_max) = sizes(adds.iter().map(|a| a.size).collect());
    let (removed_min, removed_max) = sizes(removes.iter().map(|r| r.size.unwrap_or(0)).collect());
    let bytes_added: u64 = adds.iter().map(|a| a.size.max(0) as u64).sum();
    let bytes_removed: u64 = removes.iter().map(|r| r.size.unwrap_or(0).max(0) as u64).sum();
    let mut partitions: Vec<usize> = bins.iter().map(|(i, _)| *i).collect();
    partitions.dedup();
    let considered = snapshot.files.len();
    let (n_added, n_removed) = (adds.len(), removes.len());

    let predicate_param = serde_json::to_string(&predicate.map(|p| p.to_string()).into_iter().collect::<Vec<_>>()).unwrap_or_else(|_| "[]".into());
    let mut txn = Transaction::new(Some(snapshot.version), "OPTIMIZE")
        .parameter("predicate", predicate_param)
        .parameter("zOrderBy", "[]")
        .parameter("auto", false)
        .parameter("targetFileSize", target as i64)
        .metric("numFilesAdded", n_added as i64)
        .metric("numFilesRemoved", n_removed as i64)
        .metric("numBytesAdded", bytes_added as i64)
        .metric("numBytesRemoved", bytes_removed as i64)
        .metric("filesAddedMinSize", added_min)
        .metric("filesAddedMaxSize", added_max)
        .metric("filesRemovedMinSize", removed_min)
        .metric("filesRemovedMaxSize", removed_max)
        .metric("partitionsOptimized", partitions.len() as i64)
        .metric("numBatches", bins.len() as i64)
        .metric("totalConsideredFiles", considered as i64)
        .metric("totalFilesSkipped", (considered - n_removed) as i64);
    txn.extend(removes.into_iter().map(Action::Remove));
    txn.extend(adds.into_iter().map(Action::Add));
    let version = txn.commit(&log)?;
    for d in &mut written {
        d.keep();
    }
    Ok(OptimizeSummary {
        version,
        files_removed: n_removed,
        files_added: n_added,
        bytes_removed,
        bytes_added,
        partitions_optimized: partitions.len(),
        skipped: false,
    })
}

/// Files (ascending by size) in consecutive bins of at most `target` bytes (a bin always holds a file).
fn pack(files: Vec<&Add>, target: u64) -> Vec<Vec<&Add>> {
    let mut bins = vec![];
    let (mut current, mut total) = (vec![], 0u64);
    for f in files {
        let size = f.size.max(0) as u64;
        if !current.is_empty() && total + size > target {
            bins.push(std::mem::take(&mut current));
            total = 0;
        }
        total += size;
        current.push(f);
    }
    if !current.is_empty() {
        bins.push(current);
    }
    bins
}

/// For each partition (by its values) whether the predicate holds. The
/// predicate is run by the engine on a table of the partitions' values.
fn matching_partitions(ctx: &SessionContext, snapshot: &Snapshot, partitions: &[&PartitionValues], predicate: &Expr) -> Result<Vec<bool>> {
    let columns = &snapshot.partition_columns;
    if columns.is_empty() {
        return Err(WhError::Plan("OPTIMIZE ... WHERE needs a partitioned table: this one has no partition columns".into()));
    }
    for c in predicate.column_refs() {
        if !columns.iter().any(|p| p.eq_ignore_ascii_case(&c.name)) {
            return Err(WhError::Plan(format!("OPTIMIZE ... WHERE can only use partition columns ({columns:?}), not '{}'", c.name)));
        }
    }
    const ROW: &str = "__wh_partition";
    let mut fields = vec![];
    let mut arrays: Vec<ArrayRef> = vec![];
    for c in columns {
        let field = snapshot.schema.field_with_name(c)?;
        // an empty value is a null one
        let text: StringArray = partitions.iter().map(|p| p.get(c).cloned().flatten().filter(|v| !v.is_empty())).collect();
        arrays.push(cast(&text, field.data_type())?);
        fields.push(Field::new(c, field.data_type().clone(), true));
    }
    fields.push(Field::new(ROW, DataType::Int64, false));
    arrays.push(Arc::new(Int64Array::from((0..partitions.len() as i64).collect::<Vec<_>>())));
    let schema = Arc::new(Schema::new(fields));
    let batch = RecordBatch::try_new(schema.clone(), arrays)?;
    let lf = ctx.scan_provider("partitions", Arc::new(MemTable::new(schema, vec![batch])))?;
    let (_, batches) = lf.filter(predicate.clone())?.select(vec![col(ROW)])?.collect()?;
    let mut keep = vec![false; partitions.len()];
    for b in &batches {
        let rows = b.column(0).as_any().downcast_ref::<Int64Array>().expect("the partition row numbers");
        for i in 0..rows.len() {
            keep[rows.value(i) as usize] = true;
        }
    }
    Ok(keep)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn add(path: &str, size: i64) -> Add {
        Add::new(path, PartitionValues::new(), size, 0, None)
    }

    #[test]
    fn packing_fills_bins_up_to_the_target() {
        let files: Vec<Add> = [10, 20, 30, 40, 70].iter().enumerate().map(|(i, s)| add(&format!("f{i}"), *s)).collect();
        let bins = pack(files.iter().collect(), 100);
        let sizes: Vec<Vec<i64>> = bins.iter().map(|b| b.iter().map(|a| a.size).collect()).collect();
        assert_eq!(sizes, vec![vec![10, 20, 30, 40], vec![70]]);
        let one = pack(files.iter().take(1).collect(), 5);
        assert_eq!(one.len(), 1);
    }
}
