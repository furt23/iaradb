//! Struct kernels: building structs and reading a field.

use std::sync::Arc;

use arrow::array::*;
use arrow::buffer::NullBuffer;
use arrow::datatypes::DataType;

use super::names::find_field;
use crate::error::{Result, WhError};
use crate::nested::struct_fields;

fn as_struct(s: &ArrayRef) -> Result<&StructArray> {
    s.as_struct_opt().ok_or_else(|| WhError::Execution(format!("expected a struct, got {}", s.data_type())))
}

/// `struct_pack(..)`: one struct per row, never NULL; `dt` names the fields.
pub fn pack(dt: &DataType, values: Vec<ArrayRef>, rows: usize) -> Result<ArrayRef> {
    let fields = struct_fields(dt).ok_or_else(|| WhError::Execution("struct_pack: result is not a struct".into()))?;
    if values.is_empty() {
        return Ok(Arc::new(StructArray::new_empty_fields(rows, None)));
    }
    Ok(Arc::new(StructArray::try_new(fields.clone(), values, None)?))
}

/// The field `name` of each struct; NULL where the struct is NULL.
pub fn extract(s: &ArrayRef, name: &str) -> Result<ArrayRef> {
    let st = as_struct(s)?;
    Ok(under_parent(st.column(find_field(s.data_type(), name)?), st.nulls()))
}

/// `child` with NULL wherever the struct holding it is NULL.
fn under_parent(child: &ArrayRef, parent: Option<&NullBuffer>) -> ArrayRef {
    let Some(parent) = parent.filter(|n| n.null_count() > 0) else { return child.clone() };
    let merged = NullBuffer::union(Some(parent), child.nulls());
    // same length and buffers as the child: only its validity changes, so the data needs no re-validation
    let data = child.to_data().into_builder().nulls(merged);
    make_array(unsafe { data.build_unchecked() })
}

/// `struct_insert(s, name, v, ..)`: `dt` is the result type. A NULL struct is
/// a struct of NULL fields here (DuckDB), so the result is never NULL.
pub fn insert(s: &ArrayRef, dt: &DataType, added: Vec<ArrayRef>) -> Result<ArrayRef> {
    let st = as_struct(s)?;
    let fields = struct_fields(dt).ok_or_else(|| WhError::Execution("struct_insert: result is not a struct".into()))?;
    let mut columns: Vec<ArrayRef> = st.columns().iter().map(|c| under_parent(c, st.nulls())).collect();
    columns.extend(added);
    Ok(Arc::new(StructArray::try_new(fields.clone(), columns, None)?))
}

/// `struct_rename`: the same columns and NULLs under the field names of `dt`.
pub fn rename(s: &ArrayRef, dt: &DataType) -> Result<ArrayRef> {
    let st = as_struct(s)?;
    let fields = struct_fields(dt).ok_or_else(|| WhError::Execution("struct_rename: result is not a struct".into()))?;
    Ok(Arc::new(StructArray::try_new(fields.clone(), st.columns().to_vec(), st.nulls().cloned())?))
}
