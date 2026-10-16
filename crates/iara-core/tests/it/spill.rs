//! Out-of-core execution: under a small memory limit results must equal the
//! in-memory ones, and data must actually go to disk.
//!
//! The memory pool is process-wide, so every case runs in one test.

use std::sync::Arc;

use arrow::array::{ArrayRef, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use arrow::util::pretty::pretty_format_batches;
use iara_core::SessionContext;
use iara_core::exec::join_spill::grace_joins;
use iara_core::exec::memory;
use iara_core::exec::spill::spilled_bytes;
use iara_core::exec::window::spilled_windows;

fn facts(rows: i64) -> (Arc<Schema>, Vec<RecordBatch>) {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("k", DataType::Int64, false),
        Field::new("few", DataType::Int64, false),
        Field::new("s", DataType::Utf8, false),
        Field::new("x", DataType::Float64, false),
    ]));
    let batches = (0..rows)
        .step_by(65_536)
        .map(|start| {
            let ids: Vec<i64> = (start..(start + 65_536).min(rows)).collect();
            let cols: Vec<ArrayRef> = vec![
                Arc::new(Int64Array::from(ids.clone())),
                Arc::new(Int64Array::from(ids.iter().map(|i| (i * 7919) % 400_000).collect::<Vec<_>>())),
                Arc::new(Int64Array::from(ids.iter().map(|i| i % 50_000).collect::<Vec<_>>())),
                Arc::new(StringArray::from(ids.iter().map(|i| format!("customer-{:07}", (i * 31) % 300_000)).collect::<Vec<_>>())),
                Arc::new(Float64Array::from(ids.iter().map(|i| (*i % 1000) as f64 * 0.25).collect::<Vec<_>>())),
            ];
            RecordBatch::try_new(schema.clone(), cols).unwrap()
        })
        .collect();
    (schema, batches)
}

const QUERIES: &[&str] = &[
    // many groups, few rows each: radix mode from the start
    "select k, count(*) as n, sum(x) as s, min(id) as lo, max(id) as hi, avg(x) as a from t group by k order by k",
    // strings as keys
    "select s, count(*) as n, sum(x) as total from t group by s order by s",
    // fewer groups, many rows each: the pre-aggregation table hits the limit
    "select few, count(*) as n, sum(x) as s, count(distinct k) as dk from t group by few order by few",
    // two keys
    "select few % 7 as a, k % 1000 as b, count(*) as n from t group by 1, 2 order by 1, 2",
    // joins whose build side does not fit: grace hash joins
    "select count(*) as n, sum(a.x + b.x) as s from t a join t b on a.id = b.id",
    "select count(*) as n, sum(b.x) as s from t a join t b on a.k = b.id where a.few < 40000",
    "select count(*) as n, count(b.id) as matched from t a left join (select id, x from t where id % 3 = 0) b on a.id = b.id",
    "select count(*) as n, count(a.id) as matched, sum(a.x) as s from (select id, x from t where id % 2 = 0) a right join t b on a.id = b.id",
    "select count(*) as n, count(a.id) as l, count(b.id) as r from (select id from t where id % 2 = 0) a full join (select id from t where id % 3 = 0) b on a.id = b.id",
    "select count(*) as n from t a where a.id in (select k from t)",
    "select count(*) as n from t a where not exists (select 1 from t b where b.k = a.id)",
    "select count(*) as n from t a join t b on a.id = b.id and a.x < b.few",
];

/// Full sorts (ties included: rows with equal keys keep their input order).
const SORTS: &[&str] = &[
    "select id, few, x from t order by few, x desc",
    "select s, id from t order by s desc",
    "select k, s from t where id % 3 = 0 order by k nulls last, s",
];

/// Window functions sharing their PARTITION BY keys: the input is
/// partitioned to disk and each partition evaluated on its own.
const WINDOWS: &[&str] = &[
    "select id, few, row_number() over (partition by few order by id) as rn, sum(x) over (partition by few) as sx, \
     lag(id) over (partition by few order by id) as prev from t order by id",
    "select id, rank() over (partition by k % 1000 order by x desc) as r, sum(x) over (partition by k % 1000 order by id) as run \
     from t where id % 2 = 0 order by id",
    // a window feeding an aggregation in the next pipeline
    "select rn % 5 as b, count(*) as n, sum(sx) as s from \
     (select row_number() over (partition by s order by id) as rn, sum(x) over (partition by s) as sx from t) group by 1 order by 1",
];

fn collect(ctx: &SessionContext, q: &str) -> RecordBatch {
    let (schema, batches) = ctx.sql(q).unwrap().collect().unwrap();
    arrow::compute::concat_batches(&schema, &batches).unwrap()
}

fn run(ctx: &SessionContext, q: &str) -> String {
    let (_, batches) = ctx.sql(q).unwrap().collect().unwrap();
    pretty_format_batches(&batches).unwrap().to_string()
}

#[test]
fn aggregations_joins_sorts_and_windows_spill_under_a_small_limit_and_match() {
    let (schema, batches) = facts(1_200_000);
    let ctx = SessionContext::new();
    ctx.register_batches("t", schema, batches);
    let pool = memory::pool();

    pool.set_limit(usize::MAX);
    let expected: Vec<String> = QUERIES.iter().map(|q| run(&ctx, q)).collect();
    let sorted: Vec<RecordBatch> = SORTS.iter().map(|q| collect(&ctx, q)).collect();
    let windowed: Vec<RecordBatch> = WINDOWS.iter().map(|q| collect(&ctx, q)).collect();

    pool.set_limit(4 << 20);
    let before = spilled_bytes();
    for (q, want) in QUERIES.iter().zip(&expected) {
        let joins = grace_joins();
        assert_eq!(&run(&ctx, q), want, "{q}");
        if q.contains(" join ") || q.contains(" in (") || q.contains("exists") {
            assert!(grace_joins() > joins, "the join did not spill: {q}");
        }
    }
    for (q, want) in SORTS.iter().zip(&sorted) {
        let spilled = spilled_bytes();
        assert_eq!(&collect(&ctx, q), want, "{q}");
        assert!(spilled_bytes() > spilled, "the sort did not spill: {q}");
    }
    for (q, want) in WINDOWS.iter().zip(&windowed) {
        let windows = spilled_windows();
        assert_eq!(&collect(&ctx, q), want, "{q}");
        assert!(spilled_windows() > windows, "the window did not spill: {q}");
    }
    assert!(spilled_bytes() > before, "nothing was spilled");
    pool.set_limit(usize::MAX);
    assert_eq!(pool.used(), 0, "reservations leaked");
}
