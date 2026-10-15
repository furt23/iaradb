//! Grace hash join: when a join's build side does not fit under the memory
//! limit, both sides are partitioned to disk by the hash of their keys, and
//! the join runs one partition at a time (each partition is a morsel of a
//! [`GraceJoinSource`], so partitions run in parallel and the operators
//! after the join stay fused in the same pipeline).

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use arrow::array::{ArrayRef, UInt32Array};
use arrow::compute::take;
use arrow::datatypes::SchemaRef;
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use parking_lot::Mutex;

use crate::error::Result;
use crate::exec::join::{HashJoinProbe, JoinHashTable, concat_parallel};
use crate::exec::pipeline::{Emit, Operator, Sink, Source};
use crate::exec::spill::{SpillFile, SpillWriter};
use crate::hash::hash_columns;
use crate::logical::JoinType;
use crate::physical::expr::PhysExpr;

static GRACE_JOINS: AtomicU64 = AtomicU64::new(0);

/// Joins this process ran out of core (for profiles and tests).
pub fn grace_joins() -> u64 {
    GRACE_JOINS.load(Ordering::Relaxed)
}

/// Partitions of a spilled join: enough that each build partition fits.
pub fn grace_partitions() -> usize {
    (rayon::current_num_threads() * 4).next_power_of_two().clamp(32, 256)
}

#[inline]
fn partition_of(h: u64, shift: u32) -> usize {
    // other bits than the in-memory tables' buckets and the aggregation's partitions
    (h.rotate_left(29) >> shift) as usize
}

/// Rows written to one spill file per partition (shared by all workers).
pub struct PartitionedSpill {
    schema: SchemaRef,
    writers: Vec<Mutex<Option<SpillWriter>>>,
}

impl PartitionedSpill {
    pub fn new(schema: SchemaRef, parts: usize) -> Self {
        assert!(parts.is_power_of_two());
        Self { schema, writers: (0..parts).map(|_| Mutex::new(None)).collect() }
    }

    pub fn parts(&self) -> usize {
        self.writers.len()
    }

    /// Write each row of `batch` to the partition of its key hash.
    pub fn write(&self, batch: &RecordBatch, keys: &[ArrayRef]) -> Result<()> {
        let n = batch.num_rows();
        if n == 0 {
            return Ok(());
        }
        let p = self.parts();
        let shift = 64 - p.trailing_zeros();
        let mut hashes = vec![];
        hash_columns(keys, &mut hashes)?;
        let mut rows: Vec<Vec<u32>> = vec![vec![]; p];
        for (i, &h) in hashes.iter().enumerate() {
            rows[partition_of(h, shift)].push(i as u32);
        }
        for (part, idx) in rows.into_iter().enumerate() {
            if idx.is_empty() {
                continue;
            }
            let sel = if idx.len() == n { batch.clone() } else { take_rows(batch, &self.schema, idx)? };
            let mut w = self.writers[part].lock();
            if w.is_none() {
                *w = Some(SpillWriter::try_new(self.schema.clone())?);
            }
            w.as_mut().expect("writer").write(&sel)?;
        }
        Ok(())
    }

    pub fn finish(&self) -> Result<Vec<Option<SpillFile>>> {
        self.writers.iter().map(|w| w.lock().take().map(|w| w.finish()).transpose()).collect()
    }
}

fn take_rows(batch: &RecordBatch, schema: &SchemaRef, idx: Vec<u32>) -> Result<RecordBatch> {
    let sel = UInt32Array::from(idx);
    let cols = batch.columns().iter().map(|c| take(c, &sel, None)).collect::<Result<Vec<_>, _>>()?;
    let opts = RecordBatchOptions::new().with_row_count(Some(sel.len()));
    Ok(RecordBatch::try_new_with_options(schema.clone(), cols, &opts)?)
}

/// The probe side of a spilled join: its rows, partitioned like the build side.
pub struct PartitionSink {
    keys: Vec<PhysExpr>,
    spill: PartitionedSpill,
}

impl PartitionSink {
    pub fn new(keys: Vec<PhysExpr>, schema: SchemaRef, parts: usize) -> Self {
        Self { keys, spill: PartitionedSpill::new(schema, parts) }
    }
}

impl Sink for PartitionSink {
    type Local = ();
    type Output = Vec<Option<SpillFile>>;

    fn make_local(&self) {}

    fn push(&self, _local: &mut (), _morsel: usize, batch: RecordBatch) -> Result<()> {
        let keys = self.keys.iter().map(|e| e.evaluate_array(&batch)).collect::<Result<Vec<_>>>()?;
        self.spill.write(&batch, &keys)
    }

    fn finalize(&self, _locals: Vec<()>) -> Result<Self::Output> {
        self.spill.finish()
    }
}

/// How each partition is joined (the in-memory probe's settings).
pub struct GraceJoin {
    pub build_keys: Vec<PhysExpr>,
    pub build_schema: SchemaRef,
    pub probe_keys: Vec<PhysExpr>,
    pub join_type: JoinType,
    pub filter: Option<PhysExpr>,
    pub joined_schema: SchemaRef,
    pub output_schema: SchemaRef,
    pub order: Option<Vec<usize>>,
    pub mark_build: bool,
}

/// One morsel per partition: build that partition's table, stream its probe rows through it.
pub struct GraceJoinSource {
    join: GraceJoin,
    build: Vec<Option<SpillFile>>,
    probe: Vec<Option<SpillFile>>,
}

impl GraceJoinSource {
    pub fn new(join: GraceJoin, build: Vec<Option<SpillFile>>, probe: Vec<Option<SpillFile>>) -> Self {
        GRACE_JOINS.fetch_add(1, Ordering::Relaxed);
        Self { join, build, probe }
    }

    fn track_matches(&self) -> bool {
        matches!(self.join.join_type, JoinType::Full | JoinType::Right) || self.join.mark_build
    }

    /// Whether probe rows matter for a partition without build rows (they come out unmatched).
    fn probe_without_build(&self) -> bool {
        !self.join.mark_build && matches!(self.join.join_type, JoinType::Left | JoinType::Full | JoinType::Anti)
    }
}

impl Source for GraceJoinSource {
    fn num_morsels(&self) -> usize {
        self.build.len()
    }

    fn run_morsel(&self, p: usize, emit: Emit<'_>) -> Result<()> {
        let j = &self.join;
        if self.build[p].is_none() && !self.probe_without_build() {
            return Ok(());
        }
        let batches = match &self.build[p] {
            Some(f) => f.read_all()?,
            None => vec![],
        };
        let batch = if batches.is_empty() { RecordBatch::new_empty(j.build_schema.clone()) } else { concat_parallel(&j.build_schema, &batches)? };
        let keys = j.build_keys.iter().map(|e| e.evaluate_array(&batch)).collect::<Result<Vec<_>>>()?;
        let table = Arc::new(JoinHashTable::build(batch, keys, self.track_matches())?);
        let probe = HashJoinProbe {
            table: table.clone(),
            probe_keys: j.probe_keys.clone(),
            join_type: j.join_type,
            filter: j.filter.clone(),
            joined_schema: j.joined_schema.clone(),
            output_schema: j.output_schema.clone(),
            order: j.order.clone(),
            mark_only: j.mark_build,
        };
        if let Some(f) = &self.probe[p] {
            for b in f.read()? {
                probe.execute(b?, emit)?;
            }
        }
        if j.mark_build {
            for b in table.rows_by_match(j.join_type == JoinType::Semi)? {
                let opts = RecordBatchOptions::new().with_row_count(Some(b.num_rows()));
                emit(RecordBatch::try_new_with_options(j.output_schema.clone(), b.columns().to_vec(), &opts)?)?;
            }
            return Ok(());
        }
        for b in probe.finish()? {
            emit(b)?;
        }
        Ok(())
    }

    fn schema(&self) -> SchemaRef {
        self.join.output_schema.clone()
    }

    fn describe(&self) -> String {
        let spilled = self.build.iter().flatten().count();
        format!("GraceHashJoin[{:?}, partitions={}, spilled build partitions={spilled}]", self.join.join_type, self.build.len())
    }
}
