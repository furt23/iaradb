//! `list_contains` and `list_position`: the element of every row is compared
//! with that row's search value in one vectorized `not_distinct`.

use std::sync::Arc;

use arrow::array::*;
use arrow::compute::{kernels::cmp, take};
use arrow::datatypes::DataType;

use super::gather::{as_list, element_rows};
use crate::error::{Result, WhError};

/// Per element of the valid rows: does it equal its row's needle (NULL equals NULL)?
fn matches(list: &ListArray, needle: &ArrayRef) -> Result<(Vec<u32>, BooleanArray)> {
    let (elems, rows) = element_rows(list);
    if matches!(list.values().data_type(), DataType::List(_)) {
        return Err(WhError::NotSupported("searching lists of lists".into()));
    }
    let values = take(list.values().as_ref(), &UInt32Array::from(elems), None)?;
    let needles = take(needle.as_ref(), &UInt32Array::from(rows.clone()), None)?;
    Ok((rows, cmp::not_distinct(&values, &needles)?))
}

/// `list_contains(l, x)`: NULL for a NULL list or a NULL `x`.
pub fn contains(l: &ArrayRef, x: &ArrayRef) -> Result<ArrayRef> {
    let list = as_list(l)?;
    let (rows, hit) = matches(list, x)?;
    let mut found = vec![false; list.len()];
    for (k, r) in rows.iter().enumerate() {
        if hit.value(k) {
            found[*r as usize] = true;
        }
    }
    let valid: Vec<bool> = (0..list.len()).map(|r| list.is_valid(r) && x.is_valid(r)).collect();
    Ok(Arc::new(BooleanArray::new(found.into(), Some(valid.into()))))
}

/// `list_position(l, x)`: 1-based index of the first match, NULL when absent.
pub fn position(l: &ArrayRef, x: &ArrayRef) -> Result<ArrayRef> {
    let list = as_list(l)?;
    let (rows, hit) = matches(list, x)?;
    let mut first: Vec<Option<i64>> = vec![None; list.len()];
    let (mut seen_row, mut within) = (u32::MAX, 0i64);
    for (k, r) in rows.iter().enumerate() {
        if *r != seen_row {
            seen_row = *r;
            within = 0;
        }
        within += 1;
        if hit.value(k) && first[*r as usize].is_none() {
            first[*r as usize] = Some(within);
        }
    }
    Ok(Arc::new(first.into_iter().collect::<Int64Array>()))
}
