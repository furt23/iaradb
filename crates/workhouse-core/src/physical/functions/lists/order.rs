//! Ordering and de-duplication inside every list, in the row format.

use std::sync::Arc;

use arrow::array::*;
use arrow::compute::SortOptions;
use arrow::row::{RowConverter, Rows, SortField};
use hashbrown::HashSet;

use super::gather::{Gather, as_list, span};
use crate::error::{Result, WhError};

fn rows_of(list: &ListArray, options: SortOptions) -> Result<Rows> {
    let conv = RowConverter::new(vec![SortField::new_with_options(list.values().data_type().clone(), options)])?;
    Ok(conv.convert_columns(std::slice::from_ref(list.values()))?)
}

/// `list_sort(l, 'ASC'|'DESC', 'NULLS FIRST'|'NULLS LAST')`: ascending, NULLs last by default (DuckDB).
pub fn sort(l: &ArrayRef, order: Option<&str>, nulls: Option<&str>) -> Result<ArrayRef> {
    let list = as_list(l)?;
    let descending = match order.map(str::to_ascii_uppercase).as_deref() {
        None | Some("ASC") | Some("ASCENDING") => false,
        Some("DESC") | Some("DESCENDING") => true,
        Some(o) => return Err(WhError::Plan(format!("list_sort: unknown order '{o}' (use 'ASC' or 'DESC')"))),
    };
    let nulls_first = match nulls.map(str::to_ascii_uppercase).as_deref() {
        None | Some("NULLS LAST") => false,
        Some("NULLS FIRST") => true,
        Some(o) => return Err(WhError::Plan(format!("list_sort: unknown null order '{o}' (use 'NULLS FIRST' or 'NULLS LAST')"))),
    };
    let rows = rows_of(list, SortOptions { descending, nulls_first })?;
    let mut g = Gather::with_capacity(list.len(), list.values().len());
    for r in 0..list.len() {
        if list.is_null(r) {
            g.null_row();
            continue;
        }
        let (s, e) = span(list, r);
        let mut idx: Vec<u32> = (s as u32..e as u32).collect();
        idx.sort_by(|a, b| rows.row(*a as usize).cmp(&rows.row(*b as usize)));
        g.row(idx);
    }
    g.finish(list.values())
}

/// First occurrences of every distinct element of row `r`, in order.
fn distinct_in_row(list: &ListArray, rows: &Rows, r: usize, keep_nulls: bool, out: &mut Vec<u32>) {
    let (s, e) = span(list, r);
    let mut seen: HashSet<arrow::row::Row<'_>> = HashSet::new();
    let values = list.values();
    for k in s..e {
        if values.is_null(k) && !keep_nulls {
            continue;
        }
        if seen.insert(rows.row(k)) {
            out.push(k as u32);
        }
    }
}

/// `list_distinct(l)`: first occurrences in order. NULL elements are dropped
/// (DuckDB) unless `keep_nulls` (Polars).
pub fn distinct(l: &ArrayRef, keep_nulls: bool) -> Result<ArrayRef> {
    let list = as_list(l)?;
    let rows = rows_of(list, SortOptions::default())?;
    let mut g = Gather::with_capacity(list.len(), list.values().len());
    let mut keep = Vec::new();
    for r in 0..list.len() {
        if list.is_null(r) {
            g.null_row();
            continue;
        }
        keep.clear();
        distinct_in_row(list, &rows, r, keep_nulls, &mut keep);
        g.row(keep.iter().copied());
    }
    g.finish(list.values())
}

/// `list_unique(l)`: the number of distinct non-NULL elements.
pub fn unique(l: &ArrayRef) -> Result<ArrayRef> {
    let list = as_list(l)?;
    let rows = rows_of(list, SortOptions::default())?;
    let mut keep = Vec::new();
    let counts: Int64Array = (0..list.len())
        .map(|r| {
            if list.is_null(r) {
                return None;
            }
            keep.clear();
            distinct_in_row(list, &rows, r, false, &mut keep);
            Some(keep.len() as i64)
        })
        .collect();
    Ok(Arc::new(counts))
}
