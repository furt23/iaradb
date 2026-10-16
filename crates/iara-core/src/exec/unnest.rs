//! UNNEST / explode: one output row per list element, streaming per batch.
//!
//! For every input row the operator works out how many rows it produces (the
//! longest of its lists, or one with `keep_empty`), then builds the output:
//! the parent indices repeat the other columns (those read above it; the
//! others come out NULL), the element indices pick the list values (a missing
//! element is NULL, which zips lists of different lengths). A list whose rows
//! all produce exactly their elements is a slice of its values. Large
//! expansions are emitted in several batches.

use arrow::array::*;
use arrow::compute::take;
use arrow::datatypes::SchemaRef;
use arrow::record_batch::RecordBatch;

use crate::error::{Result, WhError};
use crate::exec::ops::make_batch;
use crate::exec::pipeline::{Emit, Operator};
use crate::physical::expr::PhysExpr;

/// Output rows aimed at per emitted batch (a single input row can exceed it).
const TARGET_ROWS: usize = 32 * 1024;

pub struct UnnestOp {
    pub exprs: Vec<PhysExpr>,
    pub keep_empty: bool,
    /// input columns read above (None: all)
    pub used: Option<Vec<bool>>,
    pub schema: SchemaRef,
}

/// A list argument and where its elements start.
struct Lists {
    array: ArrayRef,
}

impl Lists {
    fn list(&self) -> &ListArray {
        self.array.as_list::<i32>()
    }

    /// Elements of row `r` (none for a NULL list).
    fn span(&self, r: usize) -> (usize, usize) {
        let l = self.list();
        if l.is_null(r) {
            return (0, 0);
        }
        let o = l.value_offsets();
        (o[r] as usize, o[r + 1] as usize)
    }
}

impl UnnestOp {
    fn rows_of(&self, lists: &[Lists], r: usize) -> usize {
        let longest = lists.iter().map(|l| { let (s, e) = l.span(r); e - s }).max().unwrap_or(0);
        if longest == 0 && self.keep_empty { 1 } else { longest }
    }

    fn emit_rows(&self, batch: &RecordBatch, lists: &[Lists], counts: &[usize], range: (usize, usize), emit: Emit<'_>) -> Result<()> {
        let (start, end) = range;
        let rows: usize = counts[start..end].iter().sum();
        if rows == 0 {
            return Ok(());
        }
        let used = |c: usize| self.used.as_ref().is_none_or(|u| u[c]);
        let parents = (0..batch.num_columns()).any(used).then(|| {
            let mut p = Vec::with_capacity(rows);
            for r in start..end {
                p.extend(std::iter::repeat_n(r as u32, counts[r]));
            }
            UInt32Array::from(p)
        });
        let mut cols: Vec<ArrayRef> = batch
            .columns()
            .iter()
            .enumerate()
            .map(|(c, a)| match &parents {
                Some(p) if used(c) => take(a.as_ref(), p, None),
                _ => Ok(new_null_array(a.data_type(), rows)),
            })
            .collect::<Result<_, _>>()?;
        for l in lists {
            // every row yields exactly its elements, and they are contiguous
            // (a NULL list may still span values in the offsets)
            let o = l.list().value_offsets();
            let (s, e) = (o[start] as usize, o[end] as usize);
            if e - s == rows && (start..end).all(|r| { let (a, b) = l.span(r); b - a == counts[r] }) {
                cols.push(l.list().values().slice(s, rows));
                continue;
            }
            let mut picks = UInt32Builder::with_capacity(rows);
            for r in start..end {
                let (s, e) = l.span(r);
                for k in 0..counts[r] {
                    if s + k < e {
                        picks.append_value((s + k) as u32);
                    } else {
                        picks.append_null();
                    }
                }
            }
            cols.push(take(l.list().values().as_ref(), &picks.finish(), None)?);
        }
        emit(make_batch(&self.schema, cols, rows)?)
    }
}

impl Operator for UnnestOp {
    fn execute(&self, batch: RecordBatch, emit: Emit<'_>) -> Result<()> {
        let lists = self
            .exprs
            .iter()
            .map(|e| {
                let array = e.evaluate(&batch)?.into_array(batch.num_rows())?;
                match array.as_list_opt::<i32>() {
                    Some(_) => Ok(Lists { array }),
                    None => Err(WhError::Execution(format!("unnest expects a list, got {}", array.data_type()))),
                }
            })
            .collect::<Result<Vec<_>>>()?;
        let n = batch.num_rows();
        let counts: Vec<usize> = (0..n).map(|r| self.rows_of(&lists, r)).collect();
        let mut start = 0;
        while start < n {
            let (mut end, mut rows) = (start, 0usize);
            while end < n && (end == start || rows + counts[end] <= TARGET_ROWS) {
                rows += counts[end];
                end += 1;
            }
            self.emit_rows(&batch, &lists, &counts, (start, end), emit)?;
            start = end;
        }
        Ok(())
    }

    fn describe(&self) -> String {
        format!("Unnest({})", self.exprs.iter().map(|e| e.to_string()).collect::<Vec<_>>().join(", "))
    }
}
