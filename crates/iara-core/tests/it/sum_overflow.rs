//! Integer sums through SQL: a total past the range of the type is an error
//! (grouped, ungrouped, many batches and threads, spilled), and totals that
//! fit are exact. The memory pool is process-wide: the spilled case sets a
//! limit, which only makes the other test spill too.

use std::sync::Arc;

use arrow::array::{ArrayRef, Int64Array};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use arrow::util::pretty::pretty_format_batches;
use iara_core::SessionContext;
use iara_core::exec::memory;
use iara_core::exec::spill::spilled_bytes;

const MSG: &str = "integer overflow in sum(...): cast to DOUBLE or DECIMAL";

fn batches(rows: i64, value: impl Fn(i64) -> i64 + Copy, key: impl Fn(i64) -> i64 + Copy) -> (Arc<Schema>, Vec<RecordBatch>) {
    let schema = Arc::new(Schema::new(vec![Field::new("k", DataType::Int64, false), Field::new("v", DataType::Int64, false)]));
    let out = (0..rows)
        .step_by(65_536)
        .map(|start| {
            let ids: Vec<i64> = (start..(start + 65_536).min(rows)).collect();
            let cols: Vec<ArrayRef> = vec![
                Arc::new(Int64Array::from(ids.iter().map(|&i| key(i)).collect::<Vec<_>>())),
                Arc::new(Int64Array::from(ids.iter().map(|&i| value(i)).collect::<Vec<_>>())),
            ];
            RecordBatch::try_new(schema.clone(), cols).unwrap()
        })
        .collect();
    (schema, out)
}

fn ctx(rows: i64, value: impl Fn(i64) -> i64 + Copy, key: impl Fn(i64) -> i64 + Copy) -> SessionContext {
    let (schema, b) = batches(rows, value, key);
    let ctx = SessionContext::new();
    ctx.register_batches("t", schema, b);
    ctx
}

fn run(ctx: &SessionContext, q: &str) -> Result<String, String> {
    let (_, b) = ctx.sql(q).and_then(|f| f.collect()).map_err(|e| e.to_string())?;
    Ok(pretty_format_batches(&b).unwrap().to_string())
}

fn cell(ctx: &SessionContext, q: &str) -> String {
    let out = run(ctx, q).unwrap();
    out.lines().nth(3).unwrap().trim_matches(|c| c == '|' || c == ' ').to_string()
}

#[test]
fn overflow_is_an_error_and_fitting_totals_are_exact() {
    // 1M rows over 8 threads' worth of morsels: partial sums overflow only in the total
    let big = ctx(1_000_000, |_| i64::MAX / 100_000, |i| i % 3);
    let e = run(&big, "select sum(v) from t").unwrap_err();
    assert!(e.contains(MSG), "{e}");
    let e = run(&big, "select k, sum(v) from t group by k").unwrap_err();
    assert!(e.contains(MSG), "{e}");
    // all values equal: one distinct value, no overflow
    assert_eq!(cell(&big, "select sum(distinct v) from t"), (i64::MAX / 100_000).to_string());

    // fits: close to the range, exact
    let fits = ctx(1_000_000, |_| i64::MAX / 1_000_000, |i| i % 3);
    assert_eq!(cell(&fits, "select sum(v) from t"), (i64::MAX / 1_000_000 * 1_000_000).to_string());

    // mixed signs: partial sums leave the range, the total does not
    let mixed = ctx(1_000_000, |i| if i % 2 == 0 { i64::MAX } else { i64::MIN }, |_| 0);
    assert_eq!(cell(&mixed, "select sum(v) from t"), "-500000");
    assert_eq!(cell(&mixed, "select sum(v) from t group by k"), "-500000");
}

#[test]
fn spilled_sums() {
    // 200k groups of 5 rows: group 0 overflows, group 1 stays close to the limit
    let value = |i: i64| match i % 200_000 {
        0 => i64::MAX / 2 + 1,
        1 => i64::MAX / 6,
        _ => 1,
    };
    let c = ctx(1_000_000, value, |i| i % 200_000);
    let pool = memory::pool();
    pool.set_limit(4 << 20);
    let before = spilled_bytes();
    let ok = run(&c, "select count(*), sum(s) from (select k, sum(v) as s from t where k <> 0 group by k) x");
    let e = run(&c, "select k, sum(v) from t group by k");
    let near = run(&c, "select sum(v) from t where k = 1");
    let spilled = spilled_bytes() > before;
    pool.set_limit(usize::MAX);
    assert!(spilled, "nothing was spilled");
    assert!(ok.is_ok(), "{ok:?}");
    assert!(e.unwrap_err().contains(MSG));
    assert_eq!(near.unwrap().lines().nth(3).unwrap().trim_matches(|c| c == '|' || c == ' '), (i64::MAX / 6 * 5).to_string());
}
