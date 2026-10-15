//! Nested types. Lists are first-class: every list column in the engine has
//! the canonical type `List<item: T>` (nullable elements), so two lists of
//! the same element type always compare equal as Arrow types. Sources
//! normalize what they read (`LargeList`, `FixedSizeList`, other element
//! names, string views inside lists) with [`canonical_array`].
//!
//! Structs follow the same scheme: every struct column has all its fields
//! nullable and canonical (`Struct<a: Int64, b: List<Utf8>>`), recursively.
//! `canonical_type` is the one place that knows both.

mod parse;

pub use parse::parse_nested_type;

use std::sync::Arc;

use arrow::array::ArrayRef;
use arrow::compute::{CastOptions, cast_with_options};
use arrow::datatypes::{DataType, Field, Fields, Schema, SchemaRef};
use arrow::record_batch::{RecordBatch, RecordBatchOptions};

use crate::error::{Result, WhError};

pub const ITEM: &str = "item";

/// `List<item: elem>`.
pub fn list_of(elem: DataType) -> DataType {
    DataType::List(Arc::new(Field::new(ITEM, elem, true)))
}

pub fn is_list(dt: &DataType) -> bool {
    matches!(dt, DataType::List(_) | DataType::LargeList(_) | DataType::FixedSizeList(..))
}

/// The element type of a list type.
pub fn element_type(dt: &DataType) -> Option<&DataType> {
    match dt {
        DataType::List(f) | DataType::LargeList(f) | DataType::FixedSizeList(f, _) => Some(f.data_type()),
        _ => None,
    }
}

pub fn is_struct(dt: &DataType) -> bool {
    matches!(dt, DataType::Struct(_))
}

/// The fields of a struct type.
pub fn struct_fields(dt: &DataType) -> Option<&Fields> {
    match dt {
        DataType::Struct(f) => Some(f),
        _ => None,
    }
}

/// `Struct<name: type, ..>` with nullable fields, in canonical form.
pub fn struct_of(fields: impl IntoIterator<Item = (String, DataType)>) -> DataType {
    DataType::Struct(fields.into_iter().map(|(n, t)| Field::new(n, canonical_element(&t), true)).collect())
}

/// Whether a type is a nested (list or struct) type.
pub fn is_nested(dt: &DataType) -> bool {
    is_list(dt) || is_struct(dt)
}

pub fn canonical_element(dt: &DataType) -> DataType {
    match dt {
        // lists hold plain strings and binaries: no views to compact when they spill
        DataType::Utf8View | DataType::LargeUtf8 => DataType::Utf8,
        DataType::BinaryView | DataType::LargeBinary => DataType::Binary,
        other => canonical_type(other),
    }
}

/// The engine's form of a type (see the module docs).
pub fn canonical_type(dt: &DataType) -> DataType {
    if let Some(elem) = element_type(dt) {
        return list_of(canonical_element(elem));
    }
    match dt {
        DataType::Struct(fields) => struct_of(fields.iter().map(|f| (f.name().clone(), f.data_type().clone()))),
        other => other.clone(),
    }
}

/// The array in canonical form (the array itself when it already is).
pub fn canonical_array(a: &ArrayRef) -> Result<ArrayRef> {
    if !is_nested(a.data_type()) {
        return Ok(a.clone());
    }
    let to = canonical_type(a.data_type());
    if &to == a.data_type() {
        return Ok(a.clone());
    }
    Ok(cast_with_options(a, &to, &CastOptions { safe: false, ..Default::default() })?)
}

/// The schema in canonical form, if it differs from `schema`.
pub fn canonical_schema(schema: &Schema) -> Option<SchemaRef> {
    if !schema.fields().iter().any(|f| is_nested(f.data_type())) {
        return None;
    }
    let fields: Vec<Field> =
        schema.fields().iter().map(|f| f.as_ref().clone().with_data_type(canonical_type(f.data_type()))).collect();
    let canonical = Schema::new_with_metadata(fields, schema.metadata().clone());
    (canonical.fields() != schema.fields()).then(|| Arc::new(canonical))
}

/// The batch in canonical form, labelled with `schema` when the types differ.
pub fn canonical_batch(batch: RecordBatch, schema: &SchemaRef) -> Result<RecordBatch> {
    if !batch.columns().iter().any(|c| is_nested(c.data_type())) {
        return Ok(batch);
    }
    let cols = batch.columns().iter().map(canonical_array).collect::<Result<Vec<_>>>()?;
    let opts = RecordBatchOptions::new().with_row_count(Some(batch.num_rows()));
    Ok(RecordBatch::try_new_with_options(schema.clone(), cols, &opts)?)
}

/// Lists and structs are payload for now: they cannot be grouping, join,
/// sort or partition keys.
pub fn reject_nested_key(dt: &DataType, what: &str) -> Result<()> {
    if is_nested(dt) {
        let hint = if is_struct(dt) {
            "extract its fields (s.field) to use them"
        } else {
            "use list functions (e.g. list_sort, array_to_string) to turn it into a flat value"
        };
        return Err(WhError::NotSupported(format!("{} cannot be used as {what} yet; {hint}", type_name(dt))));
    }
    Ok(())
}

/// A type as users read it: `Int64`, `List<Utf8>`, `Struct<a: Int64, b: List<Utf8>>`.
pub fn type_name(dt: &DataType) -> String {
    if let Some(elem) = element_type(dt) {
        return format!("List<{}>", type_name(elem));
    }
    match dt {
        DataType::Struct(fields) => {
            let inner: Vec<String> = fields.iter().map(|f| format!("{}: {}", f.name(), type_name(f.data_type()))).collect();
            format!("Struct<{}>", inner.join(", "))
        }
        other => other.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use arrow::array::{Array, LargeListArray, ListArray};
    use arrow::datatypes::Int64Type;

    use super::*;

    #[test]
    fn large_lists_and_other_names_become_the_canonical_list() {
        let large = LargeListArray::from_iter_primitive::<Int64Type, _, _>(vec![Some(vec![Some(1), None]), None]);
        let a: ArrayRef = Arc::new(large);
        let c = canonical_array(&a).unwrap();
        assert_eq!(c.data_type(), &list_of(DataType::Int64));
        assert_eq!(c.len(), 2);
        assert!(c.is_null(1));

        let renamed = DataType::List(Arc::new(Field::new("element", DataType::Int64, false)));
        let plain: ArrayRef = Arc::new(ListArray::from_iter_primitive::<Int64Type, _, _>(vec![Some(vec![Some(7)])]));
        let r = cast_with_options(&plain, &renamed, &CastOptions::default()).unwrap();
        assert_eq!(canonical_array(&r).unwrap().data_type(), &list_of(DataType::Int64));
    }

    #[test]
    fn names_read_naturally() {
        assert_eq!(type_name(&list_of(DataType::Utf8)), "List<Utf8>");
        assert_eq!(type_name(&list_of(list_of(DataType::Int64))), "List<List<Int64>>");
        assert_eq!(type_name(&DataType::Int64), "Int64");
    }
}
