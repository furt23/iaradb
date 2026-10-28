//! Joins on one string column (keys compared as they are) against the same
//! joins on that column plus a constant one (keys in row format).

use std::sync::Arc;

use arrow::array::{ArrayRef, Int64Array, StringArray, StringViewArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use iara_core::SessionContext;

use crate::support::rows_in;

/// Short (inline) and long keys, duplicates on both sides, NULLs; `l` has
/// `Utf8` keys, `r` `Utf8View` ones.
fn ctx() -> SessionContext {
    let ctx = SessionContext::new();
    let key = |i: i64| match i % 7 {
        0 => None,
        1 => Some(format!("k{}", i % 5)),
        _ => Some(format!("a rather long key that is not inline {}", i % 11)),
    };
    let ls: Vec<Option<String>> = (0..300).map(key).collect();
    let rs: Vec<Option<String>> = (100..260).map(|i| key(i * 3)).collect();
    let schema = |t: DataType| Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, false), Field::new("k", t, true)]));
    let (sl, sr) = (schema(DataType::Utf8), schema(DataType::Utf8View));
    let l: Vec<ArrayRef> = vec![Arc::new(Int64Array::from((0..300).collect::<Vec<i64>>())), Arc::new(StringArray::from(ls))];
    let r: Vec<ArrayRef> = vec![Arc::new(Int64Array::from((100..260).collect::<Vec<i64>>())), Arc::new(StringViewArray::from(rs))];
    let l = RecordBatch::try_new(sl.clone(), l).unwrap();
    let r = RecordBatch::try_new(sr.clone(), r).unwrap();
    ctx.register_batches("l", sl, (0..300).step_by(64).map(|i| l.slice(i, 64.min(300 - i))).collect()).unwrap();
    ctx.register_batches("r", sr, vec![r]).unwrap();
    ctx
}

#[test]
fn string_keys_match_the_row_format() {
    let ctx = ctx();
    for join in ["join", "left join", "right join", "full join"] {
        let one = format!("select l.id, r.id, l.k from l {join} r on l.k = r.k order by 1, 2");
        let rows = format!("select l.id, r.id, l.k from l {join} r on l.k = r.k and l.id * 0 = r.id * 0 order by 1, 2");
        let got = rows_in(&ctx, &one);
        assert!(!got.is_empty(), "{join}");
        assert_eq!(got, rows_in(&ctx, &rows), "{join}");
    }
    for semi in ["", "not "] {
        let one = format!("select id from l where {semi}exists (select 1 from r where r.k = l.k) order by 1");
        let rows = format!("select id from l where {semi}exists (select 1 from r where r.k = l.k and r.id * 0 = l.id * 0) order by 1");
        assert_eq!(rows_in(&ctx, &one), rows_in(&ctx, &rows), "{semi}exists");
    }
}
