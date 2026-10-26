//! `GROUP BY ... LIMIT n` with no ORDER BY: any n groups, each one complete.
//! Under many groups the aggregation finishes only enough of its partitions;
//! every group it returns still has all of its rows.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, ArrayRef, AsArray, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Int64Type, Schema};
use arrow::record_batch::RecordBatch;
use iara_core::SessionContext;

/// 2M rows: `k` has 400k values (5 rows each, spread over the batches), `s`
/// a string next to it, `v` = the row number.
fn ctx() -> SessionContext {
    let n = 2_000_000i64;
    let schema = Arc::new(Schema::new(vec![
        Field::new("k", DataType::Int64, false),
        Field::new("s", DataType::Utf8, false),
        Field::new("v", DataType::Int64, false),
    ]));
    let batches = (0..n)
        .step_by(65_536)
        .map(|start| {
            let ids: Vec<i64> = (start..(start + 65_536).min(n)).collect();
            let cols: Vec<ArrayRef> = vec![
                Arc::new(Int64Array::from(ids.iter().map(|i| i % 400_000).collect::<Vec<_>>())),
                Arc::new(StringArray::from(ids.iter().map(|i| format!("name {}", i % 400_000 % 977)).collect::<Vec<_>>())),
                Arc::new(Int64Array::from(ids.clone())),
            ];
            RecordBatch::try_new(schema.clone(), cols).unwrap()
        })
        .collect();
    let ctx = SessionContext::new();
    ctx.register_batches("t", schema, batches).unwrap();
    ctx
}

fn rows(ctx: &SessionContext, sql: &str) -> Vec<(i64, i64, i64)> {
    let (_, batches) = ctx.sql(sql).unwrap().collect().unwrap();
    let mut out = vec![];
    for b in &batches {
        let (k, c, s) = (b.column(0).as_primitive::<Int64Type>(), b.column(1).as_primitive::<Int64Type>(), b.column(2).as_primitive::<Int64Type>());
        for i in 0..b.num_rows() {
            out.push((k.value(i), c.value(i), s.value(i)));
        }
    }
    out
}

#[test]
fn limited_groupings_return_complete_groups() {
    let ctx = ctx();
    // the true count and sum of every group
    let all: HashMap<i64, (i64, i64)> = rows(&ctx, "select k, count(*), sum(v) from t group by k").into_iter().map(|(k, c, s)| (k, (c, s))).collect();
    assert_eq!(all.len(), 400_000);
    for (sql, n) in [
        ("select k, count(*), sum(v) from t group by k limit 10", 10),
        ("select k, count(*) as c, sum(v) as s from t group by k limit 7 offset 3", 7),
        ("select k, n, total from (select k, count(*) as n, sum(v) as total from t group by k) limit 1000", 1000),
        // two keys: a string next to the integer
        ("select k, count(*), sum(v) from (select k, s, v from t) group by k, s limit 25", 25),
    ] {
        let got = rows(&ctx, sql);
        assert_eq!(got.len(), n, "{sql}");
        let mut seen = std::collections::HashSet::new();
        for (k, c, s) in got {
            assert!(seen.insert(k), "{sql}: group {k} twice");
            assert_eq!(all[&k], (c, s), "{sql}: group {k} incomplete");
        }
    }
    // a limit past the groups returns them all
    assert_eq!(rows(&ctx, "select k, count(*), sum(v) from t group by k limit 500000").len(), 400_000);
    // a filter on the groups is not a grouping under a limit
    let having = rows(&ctx, "select k, count(*) as c, sum(v) from t group by k having sum(v) % 2 = 0 limit 5");
    assert_eq!(having.len(), 5);
    assert!(having.iter().all(|(k, c, s)| all[k] == (*c, *s) && s % 2 == 0));
}

#[test]
fn limited_groupings_explain_the_limit() {
    let ctx = ctx();
    let plan = ctx.sql("select k, count(*) from t group by k limit 3").unwrap().explain(true).unwrap();
    assert!(plan.contains("HashAggregate"), "{plan}");
    // the column of the schema is still the key
    let (_, b) = ctx.sql("select k, count(*) from t group by k limit 3").unwrap().collect().unwrap();
    assert_eq!(b.iter().map(|b| b.num_rows()).sum::<usize>(), 3);
    assert!(b[0].column(0).as_primitive::<Int64Type>().null_count() == 0);
}
