//! Join ordering of comma-separated FROM items past the exhaustive search
//! (more than 12 relations): results equal those of the same joins written
//! with JOIN ... ON, which are planned in the order written, and planning a
//! hundred relations stays fast.

use std::sync::Arc;
use std::time::{Duration, Instant};

use arrow::array::Int64Array;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use iara_core::SessionContext;

use crate::support::rows_in;

/// Tables t0..t<n>: `t<i>(a<i>, b<i>, v<i>)` with `a<i>` unique and `b<i>`
/// a key of t<i+1> (every row matches one row of the next table).
fn tables(n: usize) -> SessionContext {
    let ctx = SessionContext::new();
    let rows = |i: usize| 20 + (i * 7) % 30;
    for i in 0..n {
        let schema = Arc::new(Schema::new(vec![
            Field::new(format!("a{i}"), DataType::Int64, false),
            Field::new(format!("b{i}"), DataType::Int64, false),
            Field::new(format!("v{i}"), DataType::Int64, false),
        ]));
        let (r, next) = (rows(i) as i64, rows(i + 1) as i64);
        let cols = vec![
            Arc::new(Int64Array::from_iter_values(0..r)) as _,
            Arc::new(Int64Array::from_iter_values((0..r).map(|j| (j * 3) % next))) as _,
            Arc::new(Int64Array::from_iter_values((0..r).map(|j| (j * 13 + i as i64) % 10))) as _,
        ];
        ctx.register_batches(&format!("t{i}"), schema.clone(), vec![RecordBatch::try_new(schema, cols).unwrap()]).unwrap();
    }
    ctx
}

/// The same query with comma-separated FROM items and with JOIN ... ON.
fn both(n: usize, edges: &[(usize, usize)], filter: &str) -> (String, String) {
    let select = format!("select count(*), sum({}) from ", (0..n).map(|i| format!("v{i}")).collect::<Vec<_>>().join(" + "));
    let on = |&(x, y): &(usize, usize)| format!("b{x} = a{y}");
    let comma = format!(
        "{select}{} where {} and {filter}",
        (0..n).map(|i| format!("t{i}")).collect::<Vec<_>>().join(", "),
        edges.iter().map(on).collect::<Vec<_>>().join(" and ")
    );
    // each edge's predicate on the JOIN of its later table
    let mut joined = "t0".to_string();
    for i in 1..n {
        let preds: Vec<String> = edges.iter().filter(|&&(x, y)| x.max(y) == i).map(on).collect();
        joined += &format!(" join t{i} on {}", if preds.is_empty() { "true".into() } else { preds.join(" and ") });
    }
    (comma, format!("{select}{joined} where {filter}"))
}

fn assert_same(ctx: &SessionContext, n: usize, edges: &[(usize, usize)], filter: &str) {
    let (comma, written) = both(n, edges, filter);
    let got = rows_in(ctx, &comma);
    assert_eq!(got, rows_in(ctx, &written), "{comma}");
    assert_ne!(got.split(',').next(), Some("0"), "the joins should match rows: {comma}");
}

#[test]
fn a_chain_of_twenty() {
    let ctx = tables(20);
    let edges: Vec<(usize, usize)> = (0..19).map(|i| (i, i + 1)).collect();
    assert_same(&ctx, 20, &edges, "v3 < 8 and v11 > 1");
}

#[test]
fn a_star_of_sixteen_with_a_cycle() {
    let ctx = tables(16);
    // t0 references t1; every other table references t0's key space through
    // its own b, and the chain t5 - t6 - t7 - t5 closes a cycle
    let mut edges: Vec<(usize, usize)> = vec![(0, 1)];
    edges.extend((2..16).map(|i| (i, 0)));
    edges.extend([(5, 6), (6, 7), (7, 5)]);
    assert_same(&ctx, 16, &edges, "v2 < 9");
}

#[test]
fn disconnected_relations_still_join() {
    let ctx = tables(14);
    // two chains with no predicate between them: a cross join of the two
    let edges: Vec<(usize, usize)> = (0..13).filter(|&i| i != 6).map(|i| (i, i + 1)).collect();
    assert_same(&ctx, 14, &edges, "v0 = 1 and v7 = 2");
}

#[test]
fn a_hundred_relations_plan_quickly() {
    // the planner recurses per join and per AND: a debug build needs more than a test thread's 2 MB
    let planned = std::thread::Builder::new().stack_size(8 << 20).spawn(|| {
        let n = 100;
        let ctx = tables(n);
        let mut edges: Vec<(usize, usize)> = (0..n - 1).map(|i| (i, i + 1)).collect();
        edges.extend((10..n).step_by(10).map(|i| (i, 0)));
        let (comma, _) = both(n, &edges, "v1 < 9");
        let start = Instant::now();
        ctx.sql(&comma).unwrap().explain(true).unwrap();
        start.elapsed()
    });
    let took = planned.unwrap().join().unwrap();
    assert!(took < Duration::from_secs(10), "planning took {took:?}");
}
