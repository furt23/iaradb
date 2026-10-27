//! Join ordering of comma-separated FROM items and of INNER JOIN chains,
//! past the exhaustive search too (more than 12 relations): results equal
//! those of the same joins written as LEFT JOINs that drop the unmatched
//! rows (planned in the order written), `SELECT *` lists the columns in
//! FROM order, and planning a hundred relations stays fast.

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

/// The same query with comma-separated FROM items, with INNER JOIN ... ON,
/// and with LEFT JOIN ... ON plus `a<i> IS NOT NULL` (not reordered).
fn forms(n: usize, edges: &[(usize, usize)], filter: &str) -> [String; 3] {
    let select = format!("select count(*), sum({}) from ", (0..n).map(|i| format!("v{i}")).collect::<Vec<_>>().join(" + "));
    let on = |&(x, y): &(usize, usize)| format!("b{x} = a{y}");
    let comma = format!(
        "{select}{} where {} and {filter}",
        (0..n).map(|i| format!("t{i}")).collect::<Vec<_>>().join(", "),
        edges.iter().map(on).collect::<Vec<_>>().join(" and ")
    );
    // each edge's predicate on the JOIN of its later table
    let chain = |kind: &str| {
        let mut joined = "t0".to_string();
        for i in 1..n {
            let preds: Vec<String> = edges.iter().filter(|&&(x, y)| x.max(y) == i).map(on).collect();
            joined += &format!(" {kind} join t{i} on {}", if preds.is_empty() { "true".into() } else { preds.join(" and ") });
        }
        joined
    };
    let matched = (1..n).map(|i| format!("a{i} is not null")).collect::<Vec<_>>().join(" and ");
    [comma, format!("{select}{} where {filter}", chain("inner")), format!("{select}{} where {matched} and {filter}", chain("left"))]
}

fn assert_same(ctx: &SessionContext, n: usize, edges: &[(usize, usize)], filter: &str) {
    let [comma, inner, written] = forms(n, edges, filter);
    let got = rows_in(ctx, &comma);
    assert_eq!(got, rows_in(ctx, &written), "{comma}");
    assert_eq!(got, rows_in(ctx, &inner), "{inner}");
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
fn a_small_chain_in_any_written_order() {
    let ctx = tables(6);
    let edges: Vec<(usize, usize)> = (0..5).map(|i| (i, i + 1)).collect();
    assert_same(&ctx, 6, &edges, "v4 = 3");
}

#[test]
fn inner_joins_are_planned_like_the_from_list() {
    let ctx = tables(5);
    let explain = |sql: &str| ctx.sql(sql).unwrap().explain(true).unwrap();
    // written with the biggest table first and the selective one last
    let inner = "select v0, v3 from t3 join t2 on b2 = a3 join t1 on b1 = a2 join t0 on b0 = a1 where v0 = 4";
    let comma = "select v0, v3 from t3, t2, t1, t0 where b2 = a3 and b1 = a2 and b0 = a1 and v0 = 4";
    assert_eq!(explain(inner), explain(comma));
    assert_eq!(rows_in(&ctx, &format!("{inner} order by 1, 2")), rows_in(&ctx, &format!("{comma} order by 1, 2")));
}

#[test]
fn inner_joins_around_an_outer_join() {
    let ctx = tables(4);
    // the LEFT JOIN takes t0 JOIN t1 as its left side; t3 joins the result
    let sql = "select count(*), count(a2), sum(v3) from t0 join t1 on b0 = a1 left join t2 on b1 = a2 and v2 > 4 \
               join t3 on a3 = b0 where v0 < 7";
    let reference = "select count(*), count(a2), sum(v3) from (select * from t0 left join t1 on b0 = a1 where a1 is not null) x \
                     left join t2 on b1 = a2 and v2 > 4 left join t3 on a3 = b0 where a3 is not null and v0 < 7";
    assert_eq!(rows_in(&ctx, sql), rows_in(&ctx, reference));
}

#[test]
fn a_selective_in_subquery_reaches_its_table_through_a_reordered_nested_join() {
    let ctx = tables(4);
    let sql = "select count(*) from (t2 join t0 on true join t1 on b0 = a1 and b1 = a2), t3                where b2 = a3 and a0 in (select a0 from t0 where v0 = 1)";
    let plan = ctx.sql(sql).unwrap().explain(true).unwrap();
    let optimized = plan.split("== Physical plan ==").next().unwrap();
    let at = |s: &str| optimized.find(s).unwrap_or_else(|| panic!("no {s} in
{plan}"));
    assert!(at("Semi Join") > at("Scan: t2"), "the semi join stays above the joins:
{plan}");
}

#[test]
fn select_star_lists_the_from_order() {
    let ctx = tables(3);
    let columns = |sql: &str| {
        let (schema, _) = ctx.sql(sql).unwrap().collect().unwrap();
        schema.fields().iter().map(|f| f.name().clone()).collect::<Vec<_>>().join(",")
    };
    let expected = "a2,b2,v2,a0,b0,v0,a1,b1,v1";
    assert_eq!(columns("select * from t2, t0, t1 where b0 = a1 and b1 = a2 and v0 = 1"), expected);
    assert_eq!(columns("select * from t2 join t0 on true join t1 on b0 = a1 and b1 = a2 where v0 = 1"), expected);
}

#[test]
fn a_hundred_relations_plan_quickly() {
    // the planner recurses per join and per AND: a debug build needs more than a test thread's 2 MB
    let planned = std::thread::Builder::new().stack_size(8 << 20).spawn(|| {
        let n = 100;
        let ctx = tables(n);
        let mut edges: Vec<(usize, usize)> = (0..n - 1).map(|i| (i, i + 1)).collect();
        edges.extend((10..n).step_by(10).map(|i| (i, 0)));
        let [comma, inner, _] = forms(n, &edges, "v1 < 9");
        let start = Instant::now();
        ctx.sql(&comma).unwrap().explain(true).unwrap();
        ctx.sql(&inner).unwrap().explain(true).unwrap();
        start.elapsed()
    });
    let took = planned.unwrap().join().unwrap();
    assert!(took < Duration::from_secs(20), "planning took {took:?}");
}
