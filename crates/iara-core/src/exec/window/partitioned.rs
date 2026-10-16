//! Window functions out of core: when the input does not fit under the
//! memory limit and every window shares its PARTITION BY keys, rows are
//! written to disk partitioned by those keys (a window partition never
//! spans two of them), and each disk partition is evaluated on its own as a
//! morsel of [`WindowPartitions`]. Rows then come out grouped by partition
//! instead of in input order.

use std::sync::atomic::{AtomicU64, Ordering};

use arrow::datatypes::SchemaRef;
use arrow::record_batch::RecordBatch;

use crate::error::Result;
use crate::exec::join::concat_parallel;
use crate::exec::pipeline::{Emit, MORSEL_ROWS, Source, rechunk};
use crate::exec::spill::SpillFile;
use crate::physical::expr::PhysExpr;

use super::{WindowEval, WindowSpec};

static SPILLED_WINDOWS: AtomicU64 = AtomicU64::new(0);

/// Windows evaluated from disk partitions since the process started.
pub fn spilled_windows() -> u64 {
    SPILLED_WINDOWS.load(Ordering::Relaxed)
}

/// The PARTITION BY keys all windows share (None: they differ, or a window has none).
pub fn common_partition(specs: &[WindowSpec]) -> Option<Vec<PhysExpr>> {
    let first = specs.first()?;
    if first.partition_by.is_empty() {
        return None;
    }
    let key = |s: &WindowSpec| s.partition_by.iter().map(|e| e.to_string()).collect::<Vec<_>>();
    let k0 = key(first);
    specs.iter().all(|s| key(s) == k0).then(|| first.partition_by.clone())
}

pub struct WindowPartitions {
    eval: WindowEval,
    input_schema: SchemaRef,
    files: Vec<Option<SpillFile>>,
}

impl WindowPartitions {
    pub fn new(eval: WindowEval, input_schema: SchemaRef, files: Vec<Option<SpillFile>>) -> Self {
        SPILLED_WINDOWS.fetch_add(1, Ordering::Relaxed);
        Self { eval, input_schema, files }
    }

    /// Every partition evaluated, in order (when the result must be whole).
    pub fn into_batches(self) -> Result<Vec<RecordBatch>> {
        let mut out = vec![];
        for p in 0..self.files.len() {
            self.run_morsel(p, &mut |b| {
                out.push(b);
                Ok(())
            })?;
        }
        Ok(out)
    }
}

impl Source for WindowPartitions {
    fn num_morsels(&self) -> usize {
        self.files.len()
    }

    fn run_morsel(&self, p: usize, emit: Emit<'_>) -> Result<()> {
        let Some(file) = &self.files[p] else { return Ok(()) };
        let batches = file.read_all()?;
        if batches.is_empty() {
            return Ok(());
        }
        let input = concat_parallel(&self.input_schema, &batches)?;
        for b in rechunk(vec![self.eval.evaluate(&input)?], MORSEL_ROWS) {
            emit(b)?;
        }
        Ok(())
    }

    fn schema(&self) -> SchemaRef {
        self.eval.schema.clone()
    }

    fn describe(&self) -> String {
        format!("WindowPartitions[partitions={}, spilled={}]", self.files.len(), self.files.iter().flatten().count())
    }
}
