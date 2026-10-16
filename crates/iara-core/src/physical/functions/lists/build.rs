//! Constructing lists: `[a, b, c]`, concatenation, reversal.

use arrow::array::*;
use arrow::compute::interleave;

use super::gather::{Gather, as_list, list_from_parts, span};
use crate::error::Result;

/// `list_value(a, b, ..)`: one list per row holding the arguments.
pub fn list_value(args: &[ArrayRef], rows: usize) -> Result<ArrayRef> {
    let k = args.len();
    let Some(first) = args.first() else {
        return list_from_parts(new_empty_array(&arrow::datatypes::DataType::Null), vec![0; rows + 1], vec![true; rows]);
    };
    let sources: Vec<&dyn Array> = args.iter().map(|a| a.as_ref()).collect();
    let picks: Vec<(usize, usize)> = (0..rows).flat_map(|r| (0..k).map(move |a| (a, r))).collect();
    let values = if rows == 0 { new_empty_array(first.data_type()) } else { interleave(&sources, &picks)? };
    let offsets = (0..=rows).map(|r| (r * k) as i32).collect();
    list_from_parts(values, offsets, vec![true; rows])
}

/// `list_concat(l1, l2, ..)`: NULL lists are skipped (all NULL gives `[]`, as DuckDB).
pub fn concat(lists: &[ArrayRef]) -> Result<ArrayRef> {
    let lists: Vec<&ListArray> = lists.iter().map(as_list).collect::<Result<_>>()?;
    let rows = lists.first().map_or(0, |l| l.len());
    let sources: Vec<&dyn Array> = lists.iter().map(|l| l.values().as_ref()).collect();
    let (mut picks, mut offsets, mut valid) = (Vec::new(), Vec::with_capacity(rows + 1), Vec::with_capacity(rows));
    offsets.push(0);
    for r in 0..rows {
        for (a, l) in lists.iter().enumerate() {
            if l.is_valid(r) {
                let (s, e) = span(l, r);
                picks.extend((s..e).map(|j| (a, j)));
            }
        }
        valid.push(true);
        offsets.push(picks.len() as i32);
    }
    let values = if picks.is_empty() { new_empty_array(sources[0].data_type()) } else { interleave(&sources, &picks)? };
    list_from_parts(values, offsets, valid)
}

pub fn reverse(l: &ArrayRef) -> Result<ArrayRef> {
    let list = as_list(l)?;
    let mut g = Gather::with_capacity(list.len(), list.values().len());
    for r in 0..list.len() {
        if list.is_null(r) {
            g.null_row();
        } else {
            let (s, e) = span(list, r);
            g.row((s as u32..e as u32).rev());
        }
    }
    g.finish(list.values())
}
