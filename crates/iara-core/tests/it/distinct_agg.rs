//! Aggregations with DISTINCT aggregates that the optimizer splits in two
//! (the distinct values are grouped first). Each query is compared with the
//! same query whose aggregates carry a FILTER, which keeps the single
//! aggregation with its hash sets; a few results are also computed by hand.

use std::sync::Arc;

use arrow::array::{ArrayRef, Decimal128Array, Float64Array, Int32Array, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use arrow::util::display::array_value_to_string;
use iara_core::SessionContext;

fn rand(seed: &mut u64) -> u64 {
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    *seed >> 33
}

/// `t`: 3000 rows in 10 batches. Key `k` has NULLs; group 6 has no `x`, group 7
/// no `y`. Floats are halves: exact in f64 whatever the order of the additions.
/// `u` names the keys 0..8 (8 has no rows in `t`).
fn ctx() -> SessionContext {
    let ctx = SessionContext::new();
    let mut s = 7u64;
    let n = 3000;
    let (mut k, mut k2, mut x, mut xs, mut xd, mut xf) = (vec![], vec![], vec![], vec![], vec![], vec![]);
    let (mut y, mut y32, mut yf, mut ys, mut yd) = (vec![], vec![], vec![], vec![], vec![]);
    for _ in 0..n {
        let key = (rand(&mut s) % 12 != 0).then(|| (rand(&mut s) % 8) as i64);
        k.push(key);
        k2.push((rand(&mut s) % 9 != 0).then(|| ["a", "b", "c"][(rand(&mut s) % 3) as usize]));
        x.push((key != Some(6) && rand(&mut s) % 8 != 0).then(|| (rand(&mut s) % 200) as i64 - 50));
        // short strings and strings past 12 bytes
        xs.push((rand(&mut s) % 10 != 0).then(|| match rand(&mut s) % 60 {
            v if v % 2 == 0 => format!("v{v}"),
            v => format!("a-long-string-value-{v}"),
        }));
        xd.push((rand(&mut s) % 10 != 0).then(|| (rand(&mut s) % 300) as i128));
        xf.push((rand(&mut s) % 10 != 0).then(|| (rand(&mut s) % 100) as f64 * 0.5 - 10.0));
        let no_y = key == Some(7);
        let v = |s: &mut u64| (!no_y && rand(s) % 10 != 0).then(|| (rand(s) % 1000) as i64 - 300);
        y.push(v(&mut s));
        y32.push(v(&mut s).map(|v| v as i32));
        yf.push(v(&mut s).map(|v| v as f64 * 0.5));
        ys.push((!no_y && rand(&mut s) % 7 != 0).then(|| format!("m{}", rand(&mut s) % 50)));
        yd.push(v(&mut s).map(|v| v as i128));
    }
    let schema = Arc::new(Schema::new(vec![
        Field::new("k", DataType::Int64, true),
        Field::new("k2", DataType::Utf8, true),
        Field::new("x", DataType::Int64, true),
        Field::new("xs", DataType::Utf8, true),
        Field::new("xd", DataType::Decimal128(15, 2), true),
        Field::new("xf", DataType::Float64, true),
        Field::new("y", DataType::Int64, true),
        Field::new("y32", DataType::Int32, true),
        Field::new("yf", DataType::Float64, true),
        Field::new("ys", DataType::Utf8, true),
        Field::new("yd", DataType::Decimal128(15, 2), true),
    ]));
    let dec = |v: Vec<Option<i128>>| -> ArrayRef { Arc::new(Decimal128Array::from(v).with_precision_and_scale(15, 2).unwrap()) };
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(k)),
        Arc::new(StringArray::from(k2)),
        Arc::new(Int64Array::from(x)),
        Arc::new(StringArray::from(xs)),
        dec(xd),
        Arc::new(Float64Array::from(xf)),
        Arc::new(Int64Array::from(y)),
        Arc::new(Int32Array::from(y32)),
        Arc::new(Float64Array::from(yf)),
        Arc::new(StringArray::from(ys)),
        dec(yd),
    ];
    // several batches: several partial tables to merge
    let batch = RecordBatch::try_new(schema.clone(), cols).unwrap();
    let batches = (0..n).step_by(300).map(|i| batch.slice(i, 300.min(n - i))).collect();
    ctx.register_batches("t", schema, batches).unwrap();

    let schema = Arc::new(Schema::new(vec![Field::new("k", DataType::Int64, true), Field::new("name", DataType::Utf8, true)]));
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from((0..9).collect::<Vec<i64>>())),
        Arc::new(StringArray::from((0..9).map(|k| format!("n{}", k % 4)).collect::<Vec<_>>())),
    ];
    ctx.register_batches("u", schema.clone(), vec![RecordBatch::try_new(schema, cols).unwrap()]).unwrap();

    // by hand
    let schema = Arc::new(Schema::new(vec![
        Field::new("g", DataType::Int64, true),
        Field::new("v", DataType::Int64, true),
        Field::new("w", DataType::Int64, true),
    ]));
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(vec![1, 1, 1, 2, 2, 3])),
        Arc::new(Int64Array::from(vec![Some(10), Some(10), None, Some(5), None, None])),
        Arc::new(Int64Array::from(vec![Some(1), Some(2), Some(3), None, None, None])),
    ];
    ctx.register_batches("h", schema.clone(), vec![RecordBatch::try_new(schema, cols).unwrap()]).unwrap();
    ctx
}

fn rows(ctx: &SessionContext, sql: &str) -> Vec<String> {
    let (_, batches) = ctx.sql(sql).unwrap().collect().unwrap();
    let mut out = vec![];
    for b in &batches {
        for i in 0..b.num_rows() {
            let cells: Vec<String> = (0..b.num_columns())
                .map(|c| if b.column(c).is_null(i) { "null".into() } else { array_value_to_string(b.column(c), i).unwrap() })
                .collect();
            out.push(cells.join(","));
        }
    }
    out
}

/// The aggregations of the optimized logical plan.
fn aggregations(ctx: &SessionContext, sql: &str) -> usize {
    let plan = ctx.sql(sql).unwrap().explain(true).unwrap();
    let logical = plan.split("== Physical plan ==").next().unwrap();
    logical.matches("Aggregate:").count()
}

fn split(ctx: &SessionContext, sql: &str) -> bool {
    ctx.sql(sql).unwrap().explain(true).unwrap().split("== Physical plan ==").next().unwrap().contains("__dx")
}

/// `{f}` in `sql` is the FILTER of every aggregate: none, or one that always holds.
fn check(sql: &str, expect_split: bool) {
    check_n(sql, expect_split, 2);
}

/// `check`, for a plan of `n` aggregations (two per split grouping set).
fn check_n(sql: &str, expect_split: bool, n: usize) {
    let ctx = ctx();
    let plain = sql.replace("{f}", "");
    let blocked = sql.replace("{f}", " filter (where true)");
    assert_eq!(split(&ctx, &plain), expect_split, "{plain}\n{}", ctx.sql(&plain).unwrap().explain(true).unwrap());
    assert!(!split(&ctx, &blocked), "{blocked}");
    if expect_split {
        assert_eq!(aggregations(&ctx, &plain), n, "{plain}");
    }
    let got = rows(&ctx, &plain);
    assert!(!got.is_empty(), "{plain}");
    assert_eq!(got, rows(&ctx, &blocked), "{plain}");
}

#[test]
fn count_distinct() {
    check("select k, count(distinct x){f} from t group by k order by k", false);
    check("select count(distinct x){f} from t", true);
    check("select k, k2, count(distinct x){f}, count(*){f} from t group by k, k2 order by k, k2", false);
    // a group whose values are all NULL counts none
    check("select k, count(distinct x){f}, count(x){f} from t where k = 6 group by k", false);
}

#[test]
fn clickbench_q9_shape() {
    check(
        "select k, sum(y){f}, count(*){f} as c, avg(y32){f}, count(distinct x){f} from t group by k order by c desc, k",
        false,
    );
    check("select sum(y){f}, count(*){f}, count(y){f}, avg(y32){f}, avg(y){f}, avg(yf){f}, count(distinct x){f} from t", true);
}

#[test]
fn combinable_aggregates() {
    check(
        "select k, count(*){f}, count(y){f}, sum(y){f}, sum(y32){f}, sum(yf){f}, sum(yd){f}, min(y){f}, max(y){f}, min(ys){f}, max(ys){f}, \
         min(yd){f}, max(yf){f}, avg(y){f}, avg(y32){f}, avg(yf){f}, count(distinct x){f} \
         from t group by k order by k",
        false,
    );
    // a group of NULLs: sums, minimums and means are NULL, counts 0
    check("select k, sum(y){f}, min(ys){f}, avg(yf){f}, count(y){f}, count(distinct x){f} from t where k = 7 group by k", false);
}

#[test]
fn sum_min_max_distinct() {
    check("select k, sum(distinct x){f}, count(distinct x){f} from t group by k order by k", false);
    check("select k, min(distinct x){f}, max(distinct x){f}, count(distinct x){f} from t group by k order by k", false);
    check("select sum(distinct x){f}, min(distinct x){f}, max(distinct x){f}, count(distinct x){f} from t", true);
    check("select k, sum(distinct xf){f}, max(distinct xf){f}, count(distinct xf){f} from t group by k order by k", false);
    // the minimum of distinct values of another column is its plain minimum
    check("select k, min(distinct y){f}, count(distinct x){f} from t group by k order by k", false);
}

#[test]
fn string_and_decimal_values() {
    check("select k, count(distinct xs){f}, min(distinct xs){f}, max(distinct xs){f}, count(*){f} from t group by k order by k", false);
    check("select count(distinct xs){f}, count(*){f} from t", true);
    check("select k, count(distinct xd){f}, min(distinct xd){f}, max(distinct xd){f} from t group by k order by k", false);
}

#[test]
fn value_types() {
    for x in [
        "x > 10",
        "cast(x as smallint)",
        "cast(x % 100 as tinyint)",
        "cast(x as real)",
        "cast(x as double)",
        "cast(x as date)",
        "cast(x as timestamp)",
        "cast(x as varchar)",
        "xf",
        "k2",
    ] {
        check(&format!("select k, count(distinct {x}){{f}}, count(*){{f}} from t group by k order by k"), false);
        check(&format!("select count(distinct {x}){{f}}, max(y){{f}} from t"), true);
    }
}

#[test]
fn expressions_and_joins() {
    check("select k2, count(distinct x + 1){f}, sum(y){f} from t group by k2 order by k2", false);
    check("select k2, count(distinct k){f}, sum(y){f} from t group by k2 order by k2", false);
    check(
        "select u.name, count(distinct t.x){f}, sum(t.y){f}, count(*){f}, avg(t.y32){f} \
         from t join u on t.k = u.k group by u.name order by u.name",
        false,
    );
    check(
        "select s.k, count(distinct s.x){f}, max(s.y){f} from (select k, x, y from t where y > 0) s group by s.k order by s.k",
        false,
    );
}

#[test]
fn grouping_sets() {
    // the global set is split, the grouped ones keep their distinct sets
    check_n("select k, count(distinct x){f}, count(*){f} from t group by rollup(k) order by k", true, 3);
    check_n("select k, k2, sum(distinct x){f}, sum(y){f} from t group by cube(k, k2) order by k, k2", true, 5);
}

#[test]
fn grouped_splits_only_what_no_distinct_set_supports() {
    let ctx = ctx();
    for sql in [
        "select k, avg(distinct x), count(*), sum(y), avg(y32) from t group by k order by k",
        "select k, sum(distinct xd), min(y) from t group by k order by k",
    ] {
        assert!(split(&ctx, sql), "{sql}");
        assert_eq!(aggregations(&ctx, sql), 2, "{sql}");
    }
}

#[test]
fn avg_and_sum_distinct_by_hand() {
    let ctx = ctx();
    let sql = "select g, count(distinct v), sum(distinct v), avg(distinct v), min(distinct v), max(distinct v), count(*), sum(w), avg(w) \
               from h group by g order by g";
    assert!(split(&ctx, sql));
    assert_eq!(rows(&ctx, sql), ["1,1,10,10.0,10,10,3,6,2.0", "2,1,5,5.0,5,5,2,null,null", "3,0,null,null,null,null,1,null,null"]);
}

#[test]
fn mean_and_sum_of_distinct_values_against_a_subquery() {
    let ctx = ctx();
    for (agg, col) in [("avg", "x"), ("sum", "x"), ("sum", "xd"), ("avg", "xd"), ("avg", "xf")] {
        let sql = format!("select k, {agg}(distinct {col}), count(*) from t group by k order by k");
        let reference = format!("select k, {agg}({col}) from (select distinct k, {col} from t) group by k order by k");
        let got = rows(&ctx, &sql);
        let want = rows(&ctx, &reference);
        assert_eq!(got.len(), want.len(), "{sql}");
        for (g, w) in got.iter().zip(&want) {
            assert!(g.starts_with(&format!("{w},")), "{sql}: {g} vs {w}");
        }
    }
}

#[test]
fn empty_input() {
    let ctx = ctx();
    // a global aggregation of no rows is one row: counts are 0, the rest NULL
    let sql = "select count(distinct v), count(*), count(w), sum(w), avg(w), min(w), sum(distinct v) from h where g > 100";
    assert!(split(&ctx, sql));
    assert_eq!(rows(&ctx, sql), ["0,0,0,null,null,null,null"]);
    // a grouped one has no rows
    let sql = "select g, avg(distinct v), count(*), avg(w) from h where g > 100 group by g";
    assert!(split(&ctx, sql));
    assert!(rows(&ctx, sql).is_empty());
    // all values NULL
    let sql = "select count(distinct w), sum(distinct w), count(*), sum(v) from h where g = 3";
    assert!(split(&ctx, sql));
    assert_eq!(rows(&ctx, sql), ["0,null,1,null"]);
}

#[test]
fn not_split() {
    let ctx = ctx();
    let k = |sql: &str| rows(&ctx, sql);
    let count_x = k("select k, count(distinct x) from t group by k order by k");
    let count_xs = k("select k, count(distinct xs) from t group by k order by k");
    for sql in [
        // distinct aggregates over different arguments
        "select k, count(distinct x), count(distinct xs) from t group by k order by k",
        // a FILTER on a distinct aggregate, or on another
        "select k, count(distinct x) filter (where y > 0) from t group by k order by k",
        "select k, count(distinct x), sum(y) filter (where y > 0) from t group by k order by k",
        // aggregates that do not combine
        "select k, count(distinct x), stddev(y) from t group by k order by k",
        "select k, count(distinct x), median(y) from t group by k order by k",
        "select k, count(distinct x), avg(yd) from t group by k order by k",
        "select k, count(distinct x), array_agg(y order by y) from t group by k order by k",
        "select k, count(distinct x), count_if(y > 0) from t group by k order by k",
        // distinct values of the grouping key itself
        "select x, count(distinct x), sum(y) from t group by x order by x",
        // a constant
        "select k, count(distinct 1) from t group by k order by k",
        // no distinct aggregate
        "select k, count(*), sum(y), avg(y) from t group by k order by k",
    ] {
        assert!(!split(&ctx, sql), "{sql}");
        assert!(!k(sql).is_empty(), "{sql}");
    }
    let both = k("select k, count(distinct x), count(distinct xs) from t group by k order by k");
    assert_eq!(both.len(), count_x.len());
    for ((b, x), xs) in both.iter().zip(&count_x).zip(&count_xs) {
        let (key, cx) = x.split_once(',').unwrap();
        assert_eq!(b, &format!("{key},{cx},{}", xs.split_once(',').unwrap().1));
    }
}
