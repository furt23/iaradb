//! Building lists by gathering elements of a flat values array.
//!
//! Most list functions are an index computation: for every row the positions
//! (in the flattened values) of the elements the result keeps. [`Gather`]
//! collects them and builds the result list with one `take`.

use std::sync::Arc;

use arrow::array::*;
use arrow::buffer::{NullBuffer, OffsetBuffer, ScalarBuffer};
use arrow::compute::take;
use arrow::datatypes::Field;

use crate::error::{Result, WhError};
use crate::nested::ITEM;

pub struct Gather {
    idx: Vec<u32>,
    offsets: Vec<i32>,
    valid: Vec<bool>,
}

impl Gather {
    pub fn with_capacity(rows: usize, items: usize) -> Self {
        let mut offsets = Vec::with_capacity(rows + 1);
        offsets.push(0);
        Self { idx: Vec::with_capacity(items), offsets, valid: Vec::with_capacity(rows) }
    }

    pub fn null_row(&mut self) {
        self.valid.push(false);
        self.offsets.push(self.idx.len() as i32);
    }

    pub fn row(&mut self, items: impl IntoIterator<Item = u32>) {
        self.idx.extend(items);
        self.valid.push(true);
        self.offsets.push(self.idx.len() as i32);
    }

    /// The list array over `values[idx]`.
    pub fn finish(self, values: &ArrayRef) -> Result<ArrayRef> {
        let taken = take(values.as_ref(), &UInt32Array::from(self.idx), None)?;
        list_from_parts(taken, self.offsets, self.valid)
    }
}

/// `List<item>` over `values` with the given offsets and row validity.
pub fn list_from_parts(values: ArrayRef, offsets: Vec<i32>, valid: Vec<bool>) -> Result<ArrayRef> {
    let field = Arc::new(Field::new(ITEM, values.data_type().clone(), true));
    let nulls = valid.iter().any(|v| !v).then(|| NullBuffer::from(valid));
    let offsets = OffsetBuffer::new(ScalarBuffer::from(offsets));
    Ok(Arc::new(ListArray::try_new(field, offsets, values, nulls)?))
}

/// The list array behind an argument (the planner made it a canonical list).
pub fn as_list(a: &ArrayRef) -> Result<&ListArray> {
    a.as_list_opt::<i32>().ok_or_else(|| WhError::Execution(format!("expected a list, got {}", a.data_type())))
}

/// Element range of row `i` in the flattened values.
#[inline]
pub fn span(l: &ListArray, i: usize) -> (usize, usize) {
    let o = l.value_offsets();
    (o[i] as usize, o[i + 1] as usize)
}

/// Per-row element positions of the valid rows, flattened: `(elements, rows)`
/// where `rows[k]` is the row of element `elements[k]`.
pub fn element_rows(l: &ListArray) -> (Vec<u32>, Vec<u32>) {
    let (mut elems, mut rows) = (Vec::new(), Vec::new());
    for i in 0..l.len() {
        if l.is_null(i) {
            continue;
        }
        let (s, e) = span(l, i);
        elems.extend(s as u32..e as u32);
        rows.extend(std::iter::repeat_n(i as u32, e - s));
    }
    (elems, rows)
}

/// An `Int64` argument as values (the planner cast it).
pub fn int64(a: &ArrayRef) -> Result<&Int64Array> {
    a.as_primitive_opt::<arrow::datatypes::Int64Type>()
        .ok_or_else(|| WhError::Execution(format!("expected an integer, got {}", a.data_type())))
}
