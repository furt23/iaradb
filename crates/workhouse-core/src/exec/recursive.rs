//! Recursive CTE evaluation: run the base term, then feed each iteration's
//! new rows to the recursive term (through the work table) until it
//! produces none.

use arrow::array::BooleanArray;
use arrow::compute::filter_record_batch;
use arrow::datatypes::SchemaRef;
use arrow::record_batch::RecordBatch;
use arrow::row::{RowConverter, SortField};
use hashbrown::HashSet;

use crate::error::Result;
use crate::io::work_table::WorkTable;

/// Rows already produced (UNION semantics: every row is emitted once).
struct Seen {
    converter: RowConverter,
    rows: HashSet<Box<[u8]>>,
}

impl Seen {
    fn new(schema: &SchemaRef) -> Result<Self> {
        let fields = schema.fields().iter().map(|f| SortField::new(f.data_type().clone())).collect();
        Ok(Self { converter: RowConverter::new(fields)?, rows: HashSet::new() })
    }

    /// Keep the rows of `batches` not seen before.
    fn fresh(&mut self, batches: Vec<RecordBatch>) -> Result<Vec<RecordBatch>> {
        let mut out = Vec::with_capacity(batches.len());
        for b in batches {
            let rows = self.converter.convert_columns(b.columns())?;
            let keep: BooleanArray = rows.iter().map(|r| Some(self.rows.insert(r.as_ref().into()))).collect();
            let b = filter_record_batch(&b, &keep)?;
            if b.num_rows() > 0 {
                out.push(b);
            }
        }
        Ok(out)
    }
}

fn rows(batches: &[RecordBatch]) -> usize {
    batches.iter().map(|b| b.num_rows()).sum()
}

/// Iterate a recursive CTE. `base` is the result of the non-recursive term
/// and `step` runs the recursive term over the current work table.
pub fn iterate(
    base: Vec<RecordBatch>,
    work_table: &WorkTable,
    distinct: bool,
    fetch: Option<usize>,
    mut step: impl FnMut() -> Result<Vec<RecordBatch>>,
) -> Result<Vec<RecordBatch>> {
    let schema = work_table.schema_ref();
    let mut seen = if distinct { Some(Seen::new(&schema)?) } else { None };
    let conform = |batches: Vec<RecordBatch>| -> Result<Vec<RecordBatch>> {
        batches.into_iter().filter(|b| b.num_rows() > 0).map(|b| work_table.conform(b)).collect()
    };
    let mut fresh = conform(base)?;
    if let Some(s) = &mut seen {
        fresh = s.fresh(fresh)?;
    }
    let mut result = vec![];
    let done = |result: &[RecordBatch]| fetch.is_some_and(|f| rows(result) >= f);
    // the recursive term's pipelines run once per iteration: profile them once
    let query = crate::exec::query::current();
    let since = query.as_ref().map_or(0, |q| q.pipeline_count());
    while !fresh.is_empty() {
        result.extend(fresh.iter().cloned());
        if done(&result) {
            break;
        }
        work_table.set(fresh)?;
        fresh = conform(step()?)?;
        if let Some(q) = &query {
            q.fold_repeats(since);
        }
        if let Some(s) = &mut seen {
            fresh = s.fresh(fresh)?;
        }
    }
    work_table.clear();
    Ok(match fetch {
        Some(f) => crate::exec::pipeline::apply_limit(result, 0, Some(f)),
        None => result,
    })
}
