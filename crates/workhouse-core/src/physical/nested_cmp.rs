//! Comparing lists and structs (`s = t`, `l < m`, `s IN (..)`): element by
//! element, a NULL inside compares as the largest value and equal to another
//! NULL (DuckDB). Both sides are encoded with the row format, whose byte
//! order is that ordering; a NULL on either side gives NULL.

use arrow::array::{Array, ArrayRef, BooleanArray};
use arrow::buffer::BooleanBuffer;
use arrow::compute::SortOptions;
use arrow::row::{RowConverter, SortField};

use crate::error::Result;
use crate::expr::Operator;

pub fn compare(op: Operator, left: &ArrayRef, right: &ArrayRef) -> Result<BooleanArray> {
    let order = SortOptions { descending: false, nulls_first: false };
    let conv = RowConverter::new(vec![SortField::new_with_options(left.data_type().clone(), order)])?;
    let (l, r) = (conv.convert_columns(std::slice::from_ref(left))?, conv.convert_columns(std::slice::from_ref(right))?);
    let holds = |i: usize| {
        let ord = l.row(i).cmp(&r.row(i));
        match op {
            Operator::Eq => ord.is_eq(),
            Operator::NotEq => ord.is_ne(),
            Operator::Lt => ord.is_lt(),
            Operator::LtEq => ord.is_le(),
            Operator::Gt => ord.is_gt(),
            _ => ord.is_ge(),
        }
    };
    let values = BooleanBuffer::collect_bool(left.len(), holds);
    let nulls = arrow::buffer::NullBuffer::union(left.logical_nulls().as_ref(), right.logical_nulls().as_ref());
    Ok(BooleanArray::new(values, nulls))
}
