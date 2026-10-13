//! Helpers shared by the list tests: a list-aware row formatter and table builders.
#![allow(dead_code)]

pub mod dir;

use std::sync::Arc;

use arrow::array::*;
use arrow::datatypes::{DataType, Field, Int64Type, Schema};
use arrow::record_batch::RecordBatch;
use arrow::util::display::array_value_to_string;
use workhouse_core::SessionContext;

/// One cell: `null`, a scalar as displayed, `[a,b,null]` for lists and
/// `{a:1,b:'x'}` for structs.
pub fn cell(a: &ArrayRef, i: usize) -> String {
    if a.is_null(i) || a.data_type() == &DataType::Null {
        return "null".into();
    }
    match a.data_type() {
        DataType::List(_) => {
            let l = a.as_list::<i32>();
            let v = l.value(i);
            let items: Vec<String> = (0..v.len()).map(|j| inner_cell(&v, j)).collect();
            format!("[{}]", items.join(","))
        }
        DataType::Struct(fields) => {
            let s = a.as_struct();
            let items: Vec<String> =
                fields.iter().zip(s.columns()).map(|(f, c)| format!("{}:{}", f.name(), inner_cell(c, i))).collect();
            format!("{{{}}}", items.join(","))
        }
        _ => array_value_to_string(a, i).unwrap(),
    }
}

/// A cell inside a list or struct: strings are quoted, so '' and null differ.
fn inner_cell(a: &ArrayRef, i: usize) -> String {
    if matches!(a.data_type(), DataType::Utf8) && a.is_valid(i) {
        format!("'{}'", cell(a, i))
    } else {
        cell(a, i)
    }
}

/// Every row, cells joined by `,` and rows by `|`.
pub fn render(batches: &[RecordBatch]) -> String {
    let mut out = vec![];
    for b in batches {
        for i in 0..b.num_rows() {
            out.push((0..b.num_columns()).map(|c| cell(b.column(c), i)).collect::<Vec<_>>().join(","));
        }
    }
    out.join("|")
}

pub fn rows_in(ctx: &SessionContext, sql: &str) -> String {
    let (_, batches) = ctx.sql(sql).unwrap().collect().unwrap();
    render(&batches)
}

/// `l` is a list column: g, l
pub fn lists_table(ctx: &SessionContext, name: &str, data: Vec<(i64, Option<Vec<Option<i64>>>)>) {
    let g: Int64Array = data.iter().map(|(g, _)| Some(*g)).collect();
    let l = ListArray::from_iter_primitive::<Int64Type, _, _>(data.into_iter().map(|(_, l)| l));
    let schema = Arc::new(Schema::new(vec![
        Field::new("g", DataType::Int64, true),
        Field::new("l", l.data_type().clone(), true),
    ]));
    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(g), Arc::new(l)]).unwrap();
    ctx.register_batches(name, schema, vec![batch]);
}

/// `s` is a struct column: id, s{a: Int64, b: Utf8}. `None` is a NULL struct.
pub type StructRow = (i64, Option<(Option<i64>, Option<&'static str>)>);

pub fn structs_batch(data: &[StructRow]) -> (Arc<Schema>, RecordBatch) {
    let id: Int64Array = data.iter().map(|(i, _)| Some(*i)).collect();
    let a: Int64Array = data.iter().map(|(_, s)| s.and_then(|s| s.0)).collect();
    let b: StringArray = data.iter().map(|(_, s)| s.and_then(|s| s.1)).collect();
    let fields = arrow::datatypes::Fields::from(vec![
        Field::new("a", DataType::Int64, true),
        Field::new("b", DataType::Utf8, true),
    ]);
    let nulls = arrow::buffer::NullBuffer::from(data.iter().map(|(_, s)| s.is_some()).collect::<Vec<_>>());
    let s = StructArray::new(fields, vec![Arc::new(a), Arc::new(b)], Some(nulls));
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, true),
        Field::new("s", s.data_type().clone(), true),
    ]));
    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(id), Arc::new(s)]).unwrap();
    (schema, batch)
}

pub fn structs_table(ctx: &SessionContext, name: &str, data: &[StructRow]) {
    let (schema, batch) = structs_batch(data);
    ctx.register_batches(name, schema, vec![batch]);
}
