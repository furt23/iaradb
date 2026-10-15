//! K-way merge of sorted runs (external sort): runs are read batch by batch,
//! their sort keys compared in Arrow's row format, and the output assembled
//! with `interleave`, so memory holds one batch per run plus the output.

use arrow::array::{ArrayRef, new_empty_array};
use arrow::compute::interleave;
use arrow::datatypes::SchemaRef;
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use arrow::row::{RowConverter, Rows, SortField};

use crate::error::Result;

/// A sorted run: its batches in order.
pub type Run = Box<dyn Iterator<Item = Result<RecordBatch>> + Send>;

struct Cursor {
    run: Run,
    /// slot of the current batch in the output's batch list
    slot: usize,
    rows: Rows,
    len: usize,
    pos: usize,
}

pub struct Merge<K> {
    converter: RowConverter,
    keys: K,
    schema: SchemaRef,
    out_rows: usize,
    /// stand-ins for freed slots (never picked; `interleave` needs one type per column)
    empties: Vec<ArrayRef>,
}

impl<K: Fn(&RecordBatch) -> Result<Vec<ArrayRef>>> Merge<K> {
    /// `keys` evaluates a batch's sort columns, compared by `fields`.
    pub fn new(fields: Vec<SortField>, keys: K, schema: SchemaRef, out_rows: usize) -> Result<Self> {
        let empties = schema.fields().iter().map(|f| new_empty_array(f.data_type())).collect();
        Ok(Self { converter: RowConverter::new(fields)?, keys, schema, out_rows, empties })
    }

    fn advance(&self, run: &mut Run, slots: &mut Vec<Option<RecordBatch>>) -> Result<Option<Cursor>> {
        loop {
            let Some(batch) = run.next().transpose()? else { return Ok(None) };
            if batch.num_rows() == 0 {
                continue;
            }
            let rows = self.converter.convert_columns(&(self.keys)(&batch)?)?;
            let len = batch.num_rows();
            let slot = slots.iter().position(|s| s.is_none()).unwrap_or(slots.len());
            if slot == slots.len() {
                slots.push(None);
            }
            slots[slot] = Some(batch);
            let run = std::mem::replace(run, Box::new(std::iter::empty()));
            return Ok(Some(Cursor { run, slot, rows, len, pos: 0 }));
        }
    }

    /// Merge the runs, emitting batches of `out_rows` rows in order.
    pub fn run(&self, runs: Vec<Run>, mut emit: impl FnMut(RecordBatch) -> Result<()>) -> Result<()> {
        let mut slots: Vec<Option<RecordBatch>> = vec![];
        let mut cursors: Vec<Cursor> = vec![];
        for mut r in runs {
            if let Some(c) = self.advance(&mut r, &mut slots)? {
                cursors.push(c);
            }
        }
        let less = |c: &[Cursor], a: usize, b: usize| c[a].rows.row(c[a].pos) < c[b].rows.row(c[b].pos);
        let mut heap: Vec<usize> = (0..cursors.len()).collect();
        for i in (0..heap.len() / 2).rev() {
            sift_down(&mut heap, i, |a, b| less(&cursors, a, b));
        }
        let mut picks: Vec<(usize, usize)> = Vec::with_capacity(self.out_rows);
        let mut retired: Vec<usize> = vec![];
        while let Some(&top) = heap.first() {
            let c = &mut cursors[top];
            picks.push((c.slot, c.pos));
            c.pos += 1;
            if c.pos == c.len {
                // this batch is done: its slot is freed after the next emit
                retired.push(c.slot);
                let mut run = std::mem::replace(&mut c.run, Box::new(std::iter::empty()));
                match self.advance(&mut run, &mut slots)? {
                    Some(next) => cursors[top] = next,
                    None => {
                        let last = heap.pop().expect("heap");
                        if !heap.is_empty() {
                            heap[0] = last;
                        }
                    }
                }
            }
            if !heap.is_empty() {
                sift_down(&mut heap, 0, |a, b| less(&cursors, a, b));
            }
            if picks.len() == self.out_rows {
                emit(self.assemble(&slots, &picks)?)?;
                picks.clear();
                for s in retired.drain(..) {
                    slots[s] = None;
                }
            }
        }
        if !picks.is_empty() {
            emit(self.assemble(&slots, &picks)?)?;
        }
        Ok(())
    }

    fn assemble(&self, slots: &[Option<RecordBatch>], picks: &[(usize, usize)]) -> Result<RecordBatch> {
        let cols = (0..self.schema.fields().len())
            .map(|c| {
                let arrays: Vec<&dyn arrow::array::Array> =
                    slots.iter().map(|s| s.as_ref().map_or(self.empties[c].as_ref(), |b| b.column(c).as_ref())).collect();
                interleave(&arrays, picks)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let opts = RecordBatchOptions::new().with_row_count(Some(picks.len()));
        Ok(RecordBatch::try_new_with_options(self.schema.clone(), cols, &opts)?)
    }
}

fn sift_down(heap: &mut [usize], mut i: usize, less: impl Fn(usize, usize) -> bool) {
    loop {
        let (l, r) = (2 * i + 1, 2 * i + 2);
        let mut m = i;
        if l < heap.len() && less(heap[l], heap[m]) {
            m = l;
        }
        if r < heap.len() && less(heap[r], heap[m]) {
            m = r;
        }
        if m == i {
            return;
        }
        heap.swap(i, m);
        i = m;
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use arrow::array::{AsArray, Int64Array};
    use arrow::datatypes::{DataType, Field, Int64Type, Schema};

    use super::*;

    fn run_of(schema: &SchemaRef, values: &[&[i64]]) -> Run {
        let batches: Vec<Result<RecordBatch>> = values
            .iter()
            .map(|v| Ok(RecordBatch::try_new(schema.clone(), vec![Arc::new(Int64Array::from(v.to_vec()))]).unwrap()))
            .collect();
        Box::new(batches.into_iter())
    }

    #[test]
    fn merges_runs_in_order() {
        let schema = Arc::new(Schema::new(vec![Field::new("v", DataType::Int64, false)]));
        let merge = Merge::new(vec![SortField::new(DataType::Int64)], |b: &RecordBatch| Ok(vec![b.column(0).clone()]), schema.clone(), 4).unwrap();
        let runs = vec![run_of(&schema, &[&[1, 4, 7], &[10, 13]]), run_of(&schema, &[&[2, 5]]), run_of(&schema, &[]), run_of(&schema, &[&[0, 3, 6, 9, 12]])];
        let mut out = vec![];
        merge.run(runs, |b| Ok(out.push(b))).unwrap();
        let all: Vec<i64> = out.iter().flat_map(|b| b.column(0).as_primitive::<Int64Type>().values().to_vec()).collect();
        assert_eq!(all, vec![0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 12, 13]);
        assert_eq!(out.iter().map(|b| b.num_rows()).collect::<Vec<_>>(), vec![4, 4, 4]);
    }
}
