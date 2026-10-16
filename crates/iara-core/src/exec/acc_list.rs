//! `array_agg`, `list`, `collect_list`, `collect_set`: the values of a group
//! as a list.
//!
//! State is the raw rows, like the spill path of every other aggregate: each
//! `update` keeps its input arrays together with the group id of every row
//! (nothing is copied unless NULLs are skipped). The lists are built in
//! `finish`: rows are grouped with a counting sort, ordered inside their
//! group, de-duplicated if asked, and gathered with one `take`.
//!
//! Input columns: `[value, order keys.., sequence]`. The sequence is the
//! scan position of the row (see `AggregateSink`), so a list without an
//! `ORDER BY` still lists its values in table order, however many workers
//! produced them, and ties of an `ORDER BY` are broken the same way.

use std::any::Any;
use std::sync::Arc;

use arrow::array::*;
use arrow::buffer::{NullBuffer, OffsetBuffer, ScalarBuffer};
use arrow::compute::{SortOptions, concat, filter, is_not_null, take};
use arrow::datatypes::{DataType, Field};
use arrow::row::{RowConverter, SortField};
use hashbrown::HashSet;

use super::accumulators::{Accumulator, downcast};
use crate::error::Result;
use crate::nested::ITEM;

#[derive(Debug, Clone)]
pub struct ListSpec {
    /// the element type (canonical)
    pub elem: DataType,
    /// the order keys: type and direction
    pub keys: Vec<(DataType, SortOptions)>,
    pub skip_nulls: bool,
    pub distinct: bool,
    /// a group without values is NULL (DuckDB's `array_agg`) instead of `[]` (Spark)
    pub null_if_empty: bool,
}

/// Rows of one `update`: group ids and the input columns.
struct Chunk {
    gids: Vec<u32>,
    cols: Vec<ArrayRef>,
}

impl Chunk {
    fn rows(&self) -> usize {
        self.gids.len()
    }

    fn bytes(&self) -> usize {
        self.gids.len() * 4 + self.cols.iter().map(|c| crate::exec::batch_mem::array_bytes(c.as_ref())).sum::<usize>()
    }

    /// The rows at `rows`, with group ids `gids[rows]`.
    fn select(&self, rows: &[u32], gids: Vec<u32>) -> Result<Chunk> {
        let idx = UInt32Array::from(rows.to_vec());
        let cols = self.cols.iter().map(|c| take(c.as_ref(), &idx, None)).collect::<Result<_, _>>()?;
        Ok(Chunk { gids, cols })
    }
}

pub struct ListAcc {
    spec: ListSpec,
    chunks: Vec<Chunk>,
    bytes: usize,
}

impl ListAcc {
    pub fn new(spec: ListSpec) -> Self {
        Self { spec, chunks: vec![], bytes: 0 }
    }

    fn push(&mut self, chunk: Chunk) {
        if chunk.rows() > 0 {
            self.bytes += chunk.bytes();
            self.chunks.push(chunk);
        }
    }
}

const NONE: u32 = u32::MAX;

impl Accumulator for ListAcc {
    fn update(&mut self, values: &[ArrayRef], gids: &[u32], _num_groups: usize) -> Result<()> {
        let value = &values[0];
        if self.spec.skip_nulls && value.null_count() > 0 {
            let keep = is_not_null(value)?;
            let cols = values.iter().map(|c| filter(c.as_ref(), &keep)).collect::<Result<_, _>>()?;
            let gids = gids.iter().zip(keep.values().iter()).filter_map(|(g, k)| k.then_some(*g)).collect();
            self.push(Chunk { gids, cols });
        } else {
            self.push(Chunk { gids: gids.to_vec(), cols: values.to_vec() });
        }
        Ok(())
    }

    fn merge(&mut self, other: &dyn Accumulator, src: &[u32], dst: &[u32], _num_groups: usize) -> Result<()> {
        let o = downcast::<ListAcc>(other)?;
        let mut lookup = vec![NONE; src.iter().max().map_or(0, |m| *m as usize + 1)];
        for (&s, &d) in src.iter().zip(dst) {
            lookup[s as usize] = d;
        }
        for chunk in &o.chunks {
            let mapped: Vec<u32> = chunk.gids.iter().map(|g| lookup.get(*g as usize).copied().unwrap_or(NONE)).collect();
            if mapped.iter().all(|g| *g != NONE) {
                self.push(Chunk { gids: mapped, cols: chunk.cols.clone() });
                continue;
            }
            let rows: Vec<u32> = (0..mapped.len() as u32).filter(|r| mapped[*r as usize] != NONE).collect();
            let gids = rows.iter().map(|r| mapped[*r as usize]).collect();
            self.push(chunk.select(&rows, gids)?);
        }
        Ok(())
    }

    fn finish(&mut self, num_groups: usize) -> Result<ArrayRef> {
        let chunks = std::mem::take(&mut self.chunks);
        self.bytes = 0;
        build(&self.spec, chunks, num_groups)
    }

    fn state_bytes(&self) -> usize {
        self.bytes
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
}

fn concat_column(chunks: &[Chunk], c: usize) -> Result<ArrayRef> {
    if let [only] = chunks {
        return Ok(only.cols[c].clone());
    }
    let parts: Vec<&dyn Array> = chunks.iter().map(|ch| ch.cols[c].as_ref()).collect();
    Ok(concat(&parts)?)
}

/// Row ids ordered by group id (stable), and where every group starts.
fn group_rows(gids: &[u32], num_groups: usize) -> (Vec<u32>, Vec<usize>) {
    let mut starts = vec![0usize; num_groups + 1];
    for g in gids {
        starts[*g as usize + 1] += 1;
    }
    for i in 1..=num_groups {
        starts[i] += starts[i - 1];
    }
    let mut next = starts.clone();
    let mut order = vec![0u32; gids.len()];
    for (row, g) in gids.iter().enumerate() {
        order[next[*g as usize]] = row as u32;
        next[*g as usize] += 1;
    }
    (order, starts)
}

fn build(spec: &ListSpec, chunks: Vec<Chunk>, num_groups: usize) -> Result<ArrayRef> {
    let values_type = spec.elem.clone();
    if chunks.is_empty() {
        // no rows at all
        let nulls = spec.null_if_empty.then(|| NullBuffer::new_null(num_groups));
        let field = Arc::new(Field::new(ITEM, values_type.clone(), true));
        let offsets = OffsetBuffer::new(ScalarBuffer::from(vec![0i32; num_groups + 1]));
        return Ok(Arc::new(ListArray::try_new(field, offsets, new_empty_array(&values_type), nulls)?));
    }
    let gids: Vec<u32> = chunks.iter().flat_map(|c| c.gids.iter().copied()).collect();
    let values = concat_column(&chunks, 0)?;
    let nkeys = spec.keys.len();
    let seq = concat_column(&chunks, 1 + nkeys)?;
    let seq = seq.as_primitive::<arrow::datatypes::UInt64Type>();
    let key_rows = if nkeys == 0 {
        None
    } else {
        let fields = spec.keys.iter().map(|(t, o)| SortField::new_with_options(t.clone(), *o)).collect();
        let keys = (0..nkeys).map(|k| concat_column(&chunks, 1 + k)).collect::<Result<Vec<_>>>()?;
        Some(RowConverter::new(fields)?.convert_columns(&keys)?)
    };
    let value_rows = if spec.distinct {
        Some(RowConverter::new(vec![SortField::new(values_type)])?.convert_columns(std::slice::from_ref(&values))?)
    } else {
        None
    };
    drop(chunks);

    let (mut order, starts) = group_rows(&gids, num_groups);
    let (mut picked, mut offsets) = (Vec::with_capacity(order.len()), Vec::with_capacity(num_groups + 1));
    offsets.push(0i32);
    let mut seen: HashSet<arrow::row::Row<'_>> = HashSet::new();
    for g in 0..num_groups {
        let rows = &mut order[starts[g]..starts[g + 1]];
        match &key_rows {
            Some(k) => rows.sort_unstable_by(|a, b| {
                k.row(*a as usize).cmp(&k.row(*b as usize)).then(seq.value(*a as usize).cmp(&seq.value(*b as usize)))
            }),
            None => {
                if !rows.windows(2).all(|w| seq.value(w[0] as usize) <= seq.value(w[1] as usize)) {
                    rows.sort_unstable_by_key(|r| seq.value(*r as usize));
                }
            }
        }
        match &value_rows {
            Some(v) => {
                seen.clear();
                picked.extend(rows.iter().copied().filter(|r| seen.insert(v.row(*r as usize))));
            }
            None => picked.extend_from_slice(rows),
        }
        offsets.push(picked.len() as i32);
    }
    let valid: Vec<bool> = offsets.windows(2).map(|w| w[1] > w[0] || !spec.null_if_empty).collect();
    let values = take(values.as_ref(), &UInt32Array::from(picked), None)?;
    let field = Arc::new(Field::new(ITEM, values.data_type().clone(), true));
    let nulls = valid.iter().any(|v| !v).then(|| NullBuffer::from(valid));
    Ok(Arc::new(ListArray::try_new(field, OffsetBuffer::new(ScalarBuffer::from(offsets)), values, nulls)?))
}
