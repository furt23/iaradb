//! `GROUP BY` a key whose values each lie in one row group (a file sorted by
//! it): the aggregation emits every row group's groups as it finishes it.
//! A key that crosses a row group boundary must still come out as one group.

use std::sync::Arc;

use arrow::array::{ArrayRef, AsArray, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Int64Type, Schema};
use arrow::record_batch::RecordBatch;
use iara_core::SessionContext;
use parquet::arrow::ArrowWriter;
use parquet::file::properties::WriterProperties;

use crate::support::dir::TempDir;

const ROWS: i64 = 1_200_000;
const GROUP_ROWS: usize = 20_000;

/// 60 row groups sorted by `k` (`per_key` rows each), with a string `s` that
/// depends on `k`, a key `g` spread over all row groups, and `v` = the row.
fn write(path: &str, per_key: i64) {
    let schema = Arc::new(Schema::new(vec![
        Field::new("k", DataType::Int64, false),
        Field::new("s", DataType::Utf8, false),
        Field::new("g", DataType::Int64, false),
        Field::new("v", DataType::Int64, false),
    ]));
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from_iter_values((0..ROWS).map(|i| i / per_key))),
        Arc::new(StringArray::from_iter_values((0..ROWS).map(|i| format!("name {}", i / per_key % 977)))),
        Arc::new(Int64Array::from_iter_values((0..ROWS).map(|i| i % 1000))),
        Arc::new(Int64Array::from_iter_values(0..ROWS)),
    ];
    let batch = RecordBatch::try_new(schema.clone(), cols).unwrap();
    let props = WriterProperties::builder().set_max_row_group_row_count(Some(GROUP_ROWS)).build();
    let mut w = ArrowWriter::try_new(std::fs::File::create(path).unwrap(), schema, Some(props)).unwrap();
    w.write(&batch).unwrap();
    w.close().unwrap();
}

/// (k, count, sum(v)) of every group, sorted.
fn groups(ctx: &SessionContext, sql: &str) -> Vec<(i64, i64, i64)> {
    let (_, batches) = ctx.sql(sql).unwrap().collect().unwrap();
    let mut out = vec![];
    for b in &batches {
        let col = |i: usize| b.column(i).as_primitive::<Int64Type>().clone();
        let (k, n, v) = (col(0), col(1), col(2));
        out.extend((0..b.num_rows()).map(|i| (k.value(i), n.value(i), v.value(i))));
    }
    out.sort_unstable();
    out
}

fn check(per_key: i64) {
    let d = TempDir::new("agg_confined");
    let path = d.join("t.parquet");
    write(&path, per_key);
    let ctx = SessionContext::new();
    ctx.register_parquet("t", &path).unwrap();
    // rows i of key k: k * per_key ..= k * per_key + per_key - 1
    let want: Vec<(i64, i64, i64)> = (0..ROWS / per_key).map(|k| (k, per_key, per_key * k * per_key + per_key * (per_key - 1) / 2)).collect();
    assert_eq!(groups(&ctx, "select k, count(*), sum(v) from t group by k"), want);
    assert_eq!(groups(&ctx, "select k, count(*), sum(v) from t group by k, s"), want);
    // a filter and a projection between the scan and the aggregation
    let odd: Vec<_> = want.iter().filter(|g| g.0 % 2 == 1).copied().collect();
    assert_eq!(groups(&ctx, "select k, count(*), sum(v) from (select v, k from t where k % 2 = 1) group by k"), odd);
    assert_eq!(groups(&ctx, "select k, count(*), sum(v) from t group by k having count(*) > 100"), vec![]);
    // an inner join probed by the scan keeps each of its rows' matches in the row's morsel
    let schema = Arc::new(Schema::new(vec![Field::new("g", DataType::Int64, false), Field::new("w", DataType::Int64, false)]));
    let cols: Vec<ArrayRef> = vec![Arc::new(Int64Array::from_iter_values(0..1000)), Arc::new(Int64Array::from_iter_values((0..1000).map(|g| g * 2)))];
    ctx.register_batches("d", schema.clone(), vec![RecordBatch::try_new(schema, cols).unwrap()]).unwrap();
    assert_eq!(groups(&ctx, "select k, count(*), sum(v) from t join d on t.g = d.g group by k"), want);
    let halves: Vec<_> = (0..ROWS / per_key).map(|k| (k, per_key, (0..per_key).map(|j| (k * per_key + j) % 1000 * 2).sum::<i64>())).collect();
    assert_eq!(groups(&ctx, "select k, count(*), sum(w) from t join d on t.g = d.g group by k"), halves);
    // a key spread over the row groups takes the usual path
    let by_g = groups(&ctx, "select g, count(*), sum(v) from t group by g");
    assert_eq!(by_g.len(), 1000);
    assert!(by_g.iter().all(|g| g.1 == ROWS / 1000));
}

#[test]
fn keys_that_stay_inside_their_row_group() {
    check(4); // 5000 keys per row group, none crossing
}

#[test]
fn keys_that_cross_row_groups_are_one_group() {
    check(3); // 20000 rows per row group: a key in three starts in one, ends in the next
}
