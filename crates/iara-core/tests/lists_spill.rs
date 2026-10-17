//! Lists under a small memory limit: aggregations that collect lists, and
//! sorts, joins and windows that carry list columns, must spill and give the
//! results of an unlimited run.
//!
//! The memory pool is process-wide, so every case runs in one test.

use std::sync::Arc;

use arrow::array::*;
use arrow::datatypes::{DataType, Field, Int64Type, Schema};
use arrow::record_batch::RecordBatch;
use arrow::util::pretty::pretty_format_batches;
use iara_core::SessionContext;
use iara_core::exec::join_spill::grace_joins;
use iara_core::exec::memory;
use iara_core::exec::spill::spilled_bytes;
use iara_core::exec::window::spilled_windows;

const ROWS: i64 = 600_000;

/// id, k (many groups), few (fewer groups), s (string), l (List<Int64>), w (List<Utf8>)
fn facts() -> (Arc<Schema>, Vec<RecordBatch>) {
    let list_type = DataType::List(Arc::new(Field::new("item", DataType::Int64, true)));
    let words_type = DataType::List(Arc::new(Field::new("item", DataType::Utf8, true)));
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("k", DataType::Int64, false),
        Field::new("few", DataType::Int64, false),
        Field::new("s", DataType::Utf8, false),
        Field::new("l", list_type, true),
        Field::new("w", words_type, true),
    ]));
    let batches = (0..ROWS)
        .step_by(65_536)
        .map(|start| {
            let ids: Vec<i64> = (start..(start + 65_536).min(ROWS)).collect();
            let l = ListArray::from_iter_primitive::<Int64Type, _, _>(
                ids.iter().map(|i| (i % 7 != 0).then(|| (0..(i % 4) + 1).map(|j| (j % 3 != 2).then_some(i + j)).collect::<Vec<_>>())),
            );
            let mut w = ListBuilder::new(StringBuilder::new());
            for i in &ids {
                w.append_value([Some(format!("w{}", i % 11)), (i % 5 != 0).then(|| format!("é{i}"))]);
            }
            let cols: Vec<ArrayRef> = vec![
                Arc::new(Int64Array::from(ids.clone())),
                Arc::new(Int64Array::from(ids.iter().map(|i| (i * 7919) % 300_000).collect::<Vec<_>>())),
                Arc::new(Int64Array::from(ids.iter().map(|i| i % 5_000).collect::<Vec<_>>())),
                Arc::new(StringArray::from(ids.iter().map(|i| format!("customer-{:07}", (i * 31) % 200_000)).collect::<Vec<_>>())),
                Arc::new(l),
                Arc::new(w.finish()),
            ];
            RecordBatch::try_new(schema.clone(), cols).unwrap()
        })
        .collect();
    (schema, batches)
}

/// Aggregations: results are reduced to a few numbers, so the comparison
/// does not depend on the order lists are listed in across groups.
const AGGREGATES: &[&str] = &[
    // many groups, two rows each: radix mode, partitions spill
    "select count(*), sum(f), sum(e), sum(n) from (select k, list_extract(a, 1) f, list_extract(a, -1) e, len(a) n \
     from (select k, array_agg(id order by id) a from t group by k))",
    // fewer groups with many rows: the pre-aggregation tables hit the limit
    "select count(*), sum(len(a)), sum(list_sum(a)) from (select few, array_agg(id) a from t group by few)",
    "select count(*), sum(len(a)) from (select few, collect_set(k) a from t group by few)",
    // lists as the collected values
    "select count(*), sum(len(a)) from (select few, array_agg(l) a from t group by few)",
];

/// One group holds the whole list: the result itself is in memory, nothing to spill.
const GLOBAL: &str = "select len(array_agg(id order by k, id)), list_extract(array_agg(id order by k, id), 1) from t";

/// Sorts, joins and windows carrying list columns.
const PAYLOAD: &[&str] = &[
    "select id, l, w from t order by s desc, id",
    "select id, l from t where id % 3 = 0 order by k, id",
    "select count(*) as n, sum(len(a.l) + len(b.w)) as s from t a join t b on a.id = b.id",
    "select count(*) as n, sum(len(b.l)) as s from t a left join (select id, l from t where id % 3 = 0) b on a.id = b.id",
    "select id, w, row_number() over (partition by few order by id) as rn from t order by id",
];

fn run(ctx: &SessionContext, q: &str) -> String {
    let (_, batches) = ctx.sql(q).unwrap().collect().unwrap();
    pretty_format_batches(&batches).unwrap().to_string()
}

fn collect(ctx: &SessionContext, q: &str) -> RecordBatch {
    let (schema, batches) = ctx.sql(q).unwrap().collect().unwrap();
    arrow::compute::concat_batches(&schema, &batches).unwrap()
}

#[test]
fn list_aggregations_and_payload_columns_spill_and_match() {
    let (schema, batches) = facts();
    let ctx = SessionContext::new();
    ctx.register_batches("t", schema, batches).unwrap();
    let pool = memory::pool();

    pool.set_limit(usize::MAX);
    let aggregates: Vec<String> = AGGREGATES.iter().map(|q| run(&ctx, q)).collect();
    let global = run(&ctx, GLOBAL);
    let payload: Vec<RecordBatch> = PAYLOAD.iter().map(|q| collect(&ctx, q)).collect();

    pool.set_limit(6 << 20);
    let before = spilled_bytes();
    for (q, want) in AGGREGATES.iter().zip(&aggregates) {
        let spilled = spilled_bytes();
        assert_eq!(&run(&ctx, q), want, "{q}");
        assert!(spilled_bytes() > spilled, "the aggregation did not spill: {q}");
    }
    assert_eq!(run(&ctx, GLOBAL), global);
    for (q, want) in PAYLOAD.iter().zip(&payload) {
        let (spilled, joins, windows) = (spilled_bytes(), grace_joins(), spilled_windows());
        assert_eq!(&collect(&ctx, q), want, "{q}");
        let went_to_disk = spilled_bytes() > spilled || grace_joins() > joins || spilled_windows() > windows;
        assert!(went_to_disk, "nothing spilled: {q}");
    }
    assert!(spilled_bytes() > before);
    pool.set_limit(usize::MAX);
    assert_eq!(pool.used(), 0, "reservations leaked");
}
