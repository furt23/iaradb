//! The work table of a recursive CTE: inside the recursive term, the CTE's
//! name refers to the rows produced by the previous iteration. Its sources
//! read the current contents when they run, so a physical plan built once is
//! re-executed for every iteration.

use std::sync::Arc;

use arrow::datatypes::SchemaRef;
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use parking_lot::RwLock;

use crate::error::Result;
use crate::exec::pipeline::{Emit, MORSEL_ROWS, Source, apply_limit, rechunk};
use crate::expr::Expr;
use crate::io::TableProvider;

#[derive(Debug, Default)]
struct Contents {
    batches: RwLock<Arc<Vec<RecordBatch>>>,
}

impl Contents {
    fn snapshot(&self) -> Arc<Vec<RecordBatch>> {
        self.batches.read().clone()
    }
}

#[derive(Debug)]
pub struct WorkTable {
    name: String,
    schema: SchemaRef,
    /// planning estimate: the size of the non-recursive term
    estimated_rows: usize,
    contents: Arc<Contents>,
}

impl WorkTable {
    pub fn new(name: &str, schema: SchemaRef, estimated_rows: usize) -> Self {
        Self { name: name.to_string(), schema, estimated_rows, contents: Arc::default() }
    }

    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn schema_ref(&self) -> SchemaRef {
        self.schema.clone()
    }

    /// A batch relabelled (and cast) to the work table's schema.
    pub fn conform(&self, b: RecordBatch) -> Result<RecordBatch> {
        let cols = b
            .columns()
            .iter()
            .zip(self.schema.fields())
            .map(|(c, f)| if c.data_type() == f.data_type() { Ok(c.clone()) } else { arrow::compute::cast(c, f.data_type()) })
            .collect::<Result<Vec<_>, _>>()?;
        let opts = RecordBatchOptions::new().with_row_count(Some(b.num_rows()));
        Ok(RecordBatch::try_new_with_options(self.schema.clone(), cols, &opts)?)
    }

    /// Replace the contents.
    pub fn set(&self, batches: Vec<RecordBatch>) -> Result<()> {
        let batches = batches.into_iter().filter(|b| b.num_rows() > 0).map(|b| self.conform(b)).collect::<Result<Vec<_>>>()?;
        *self.contents.batches.write() = Arc::new(rechunk(batches, MORSEL_ROWS));
        Ok(())
    }

    pub fn clear(&self) {
        *self.contents.batches.write() = Arc::new(vec![]);
    }
}

impl TableProvider for WorkTable {
    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }
    fn num_rows(&self) -> Option<usize> {
        Some(self.estimated_rows)
    }
    fn kind(&self) -> &'static str {
        "recursive cte work table"
    }
    fn create_source(&self, projection: Option<&[usize]>, _filters: &[Expr], fetch: Option<usize>) -> Result<Arc<dyn Source>> {
        let schema = match projection {
            Some(p) => Arc::new(self.schema.project(p)?),
            None => self.schema.clone(),
        };
        Ok(Arc::new(WorkTableSource {
            name: self.name.clone(),
            contents: self.contents.clone(),
            projection: projection.map(|p| p.to_vec()),
            fetch,
            schema,
        }))
    }
}

struct WorkTableSource {
    name: String,
    contents: Arc<Contents>,
    projection: Option<Vec<usize>>,
    fetch: Option<usize>,
    schema: SchemaRef,
}

impl WorkTableSource {
    fn batches(&self) -> Arc<Vec<RecordBatch>> {
        let all = self.contents.snapshot();
        match self.fetch {
            None => all,
            Some(_) => Arc::new(apply_limit(all.as_ref().clone(), 0, self.fetch)),
        }
    }
}

impl Source for WorkTableSource {
    fn num_morsels(&self) -> usize {
        self.batches().len()
    }
    fn run_morsel(&self, morsel: usize, emit: Emit<'_>) -> Result<()> {
        let batches = self.batches();
        let Some(b) = batches.get(morsel) else { return Ok(()) };
        match &self.projection {
            Some(p) => emit(b.project(p)?),
            None => emit(b.clone()),
        }
    }
    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }
    fn describe(&self) -> String {
        format!("WorkTableScan[{}]", self.name)
    }
}
