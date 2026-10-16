//! Analyzed runs under a small memory limit: the operators that spill report
//! the bytes they wrote and the memory they held, and still count their rows.
//!
//! The memory pool is process-wide, so every case runs in one test.

use std::sync::Arc;

use arrow::array::{ArrayRef, Float64Array, Int64Array};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use iara_core::SessionContext;
use iara_core::exec::memory;
use iara_core::physical::analyze::{AnalyzedNode, analyze};

const ROWS: i64 = 600_000;

fn context() -> SessionContext {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("k", DataType::Int64, false),
        Field::new("few", DataType::Int64, false),
        Field::new("x", DataType::Float64, false),
    ]));
    let batches = (0..ROWS)
        .step_by(65_536)
        .map(|start| {
            let ids: Vec<i64> = (start..(start + 65_536).min(ROWS)).collect();
            let cols: Vec<ArrayRef> = vec![
                Arc::new(Int64Array::from(ids.clone())),
                Arc::new(Int64Array::from(ids.iter().map(|i| (i * 7919) % 400_000).collect::<Vec<_>>())),
                Arc::new(Int64Array::from(ids.iter().map(|i| i % 5_000).collect::<Vec<_>>())),
                Arc::new(Float64Array::from(ids.iter().map(|i| (*i % 1000) as f64 * 0.25).collect::<Vec<_>>())),
            ];
            RecordBatch::try_new(schema.clone(), cols).unwrap()
        })
        .collect();
    let ctx = SessionContext::new();
    ctx.register_batches("t", schema, batches);
    ctx
}

fn find<'a>(n: &'a AnalyzedNode, name: &str) -> Option<&'a AnalyzedNode> {
    if n.name == name {
        return Some(n);
    }
    n.children.iter().find_map(|c| find(c, name))
}

fn check(ctx: &SessionContext, query: &str, node: &str, rows: u64) {
    let a = analyze(&ctx.sql(query).unwrap().plan).unwrap_or_else(|e| panic!("{query}: {e}"));
    assert_eq!(a.rows, rows, "{query}");
    let n = find(&a.plan, node).unwrap_or_else(|| panic!("{query}: no {node} node"));
    let m = n.metrics.as_ref().unwrap();
    assert!(m.spilled_bytes.unwrap_or(0) > 0, "{query}: {node} did not report spilling: {m:?}");
    assert!(m.memory_peak.unwrap_or(0) > 0, "{query}: {node} did not report its memory: {m:?}");
    assert!(m.spilled_bytes.unwrap() <= a.stats.spilled_bytes, "{query}: more than the query spilled");
    // the scans below only read
    let scan = find(&a.plan, "MemoryScan").unwrap().metrics.as_ref().unwrap();
    assert_eq!(scan.spilled_bytes, None, "{query}");
    assert!(scan.rows_out > 0);
}

#[test]
fn operators_that_spill_report_it() {
    let ctx = context();
    let pool = memory::pool();
    pool.set_limit(4 << 20);
    // an aggregation with 400k groups, a grace hash join, a full sort, partitioned windows
    check(&ctx, "select k, count(*) as n, sum(x) as s from t group by k", "HashAggregate", 400_000);
    check(&ctx, "select count(*) as n, sum(a.x + b.x) as s from t a join t b on a.id = b.id", "HashJoin", 1);
    check(&ctx, "select id, k, x from t order by few, x desc, id", "Sort", ROWS as u64);
    check(&ctx, "select id, row_number() over (partition by few order by id) as rn from t", "Window", ROWS as u64);
    pool.set_limit(usize::MAX);
    assert_eq!(pool.used(), 0, "reservations leaked");
}
