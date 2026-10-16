//! Reducing every list to one value: `list_aggr` through the group
//! accumulators, and `array_to_string`.

use std::sync::Arc;

use arrow::array::*;
use arrow::compute::{cast, nullif, take};
use arrow::datatypes::DataType;

use super::gather::{as_list, element_rows, span};
use crate::error::Result;
use crate::exec::accumulators::create_accumulator;
use crate::expr::AggFunc;

/// `list_sum(l)`, `list_aggr(l, 'avg')`, ...: each list is one group of the aggregate.
pub fn aggregate(l: &ArrayRef, agg: AggFunc) -> Result<ArrayRef> {
    let list = as_list(l)?;
    let (elems, rows) = element_rows(list);
    let mut values = take(list.values().as_ref(), &UInt32Array::from(elems), None)?;
    if values.data_type() == &DataType::Null {
        // only empty lists (`[]`): any type gives the same NULLs
        values = cast(&values, &DataType::Int64)?;
    }
    // `true`: a sum of nothing is NULL, as in a filtered aggregate
    let mut acc = create_accumulator(agg, Some(values.data_type()), false)?;
    acc.update(&[values], &rows, list.len())?;
    let out = acc.finish(list.len())?;
    let null_lists = BooleanArray::from_iter((0..list.len()).map(|r| Some(list.is_null(r))));
    Ok(nullif(&out, &null_lists)?)
}

/// `array_to_string(l, sep[, null_str])`: NULL elements are skipped, or
/// written as `null_str`.
pub fn join(l: &ArrayRef, sep: &ArrayRef, null_str: Option<&ArrayRef>) -> Result<ArrayRef> {
    let list = as_list(l)?;
    let text = cast(list.values(), &DataType::Utf8)?;
    let (text, sep) = (text.as_string::<i32>(), sep.as_string::<i32>());
    let nulls = null_str.map(|n| n.as_string::<i32>());
    let mut b = StringBuilder::with_capacity(list.len(), text.value_data().len());
    let mut buf = String::new();
    for r in 0..list.len() {
        if list.is_null(r) || sep.is_null(r) {
            b.append_null();
            continue;
        }
        buf.clear();
        let mut first = true;
        let (s, e) = span(list, r);
        let mut any = false;
        for k in s..e {
            let piece = if text.is_valid(k) {
                Some(text.value(k))
            } else {
                nulls.and_then(|n| n.is_valid(r).then(|| n.value(r)))
            };
            if let Some(p) = piece {
                any = true;
                if !first {
                    buf.push_str(sep.value(r));
                }
                buf.push_str(p);
                first = false;
            }
        }
        // a list of only NULLs is NULL (DuckDB), an empty one is ''
        if any || e == s {
            b.append_value(&buf);
        } else {
            b.append_null();
        }
    }
    Ok(Arc::new(b.finish()))
}
