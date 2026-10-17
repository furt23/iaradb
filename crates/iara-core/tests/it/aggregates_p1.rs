//! P1 aggregates through SQL. Expected values are what DuckDB returns (the
//! Python test file checks them against DuckDB itself). The spill case runs
//! the same group-bys with and without a memory limit and compares.
//!
//! The memory pool is process-wide, so everything that sets a limit lives in
//! one test.

use std::sync::Arc;

use arrow::array::{ArrayRef, Int64Array};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use arrow::util::display::array_value_to_string;
use arrow::util::pretty::pretty_format_batches;
use iara_core::SessionContext;
use iara_core::exec::memory;
use iara_core::exec::spill::spilled_bytes;

fn ctx() -> SessionContext {
    let ctx = SessionContext::new();
    let schema = Arc::new(Schema::new(vec![
        Field::new("x", DataType::Int64, true),
        Field::new("y", DataType::Int64, true),
        Field::new("g", DataType::Int64, true),
    ]));
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(vec![Some(1), Some(2), Some(3), Some(4), None])),
        Arc::new(Int64Array::from(vec![Some(3), Some(2), Some(1), None, Some(9)])),
        Arc::new(Int64Array::from(vec![Some(1), Some(1), Some(2), Some(2), Some(3)])),
    ];
    ctx.register_batches("t", schema.clone(), vec![RecordBatch::try_new(schema, cols).unwrap()]).unwrap();
    ctx
}

/// Every row of the result, `|`-joined (NULL as "null"), columns joined by `,`.
fn rows(sql: &str) -> String {
    let (_, batches) = ctx().sql(sql).unwrap().collect().unwrap();
    let mut out = vec![];
    for b in &batches {
        for i in 0..b.num_rows() {
            let cells: Vec<String> = (0..b.num_columns())
                .map(|c| if b.column(c).is_null(i) { "null".into() } else { array_value_to_string(b.column(c), i).unwrap() })
                .collect();
            out.push(cells.join(","));
        }
    }
    out.join("|")
}

#[test]
fn quantiles() {
    assert_eq!(rows("select quantile_disc(x, 0.5), quantile_disc(x, 0.25), quantile_disc(x, 0), quantile_disc(x, 1) from t"), "2,1,1,4");
    assert_eq!(rows("select quantile_cont(x, 0.3), approx_quantile(x, 0.5), median(x) from t"), "1.9,2,2.5");
    assert_eq!(rows("select percentile_cont(0.5) within group (order by x) from t"), "2.5");
    assert_eq!(rows("select percentile_cont(0.25) within group (order by x desc) from t"), "3.25");
    assert_eq!(rows("select quantile_cont(x, 0.5) from t where false"), "null");
    assert_eq!(rows("select g, quantile_disc(y, 0.5) from t group by g order by g"), "1,2|2,1|3,9");
    assert!(ctx().sql("select quantile_cont(x, 1.5) from t").unwrap().collect().is_err());
}

#[test]
fn arg_bool_and_misc() {
    assert_eq!(rows("select max_by(x, y), min_by(x, y), arg_max(x, y) from t"), "1,3,1");
    assert_eq!(rows("select g, max_by(x, y) from t group by g order by g"), "1,1|2,3|3,null");
    assert_eq!(rows("select product(x), count_if(x > 1), bool_and(x > 1), bool_or(x > 3), every(x > 0) from t"), "24.0,3,false,true,true");
    assert_eq!(rows("select g, bool_and(x > 1), count_if(y > 1) from t group by g order by g"), "1,false,2|2,true,0|3,null,1");
    assert_eq!(rows("select sum(distinct x), sum(distinct g) from t"), "10,6");
    assert_eq!(rows("select product(x), bool_and(x > 1), count_if(x > 1), max_by(x, x), sum(distinct x) from t where false"), "null,null,null,null,null");
}

#[test]
fn pair_statistics() {
    assert_eq!(rows("select corr(x, y), covar_samp(x, y), covar_pop(x, y), regr_slope(y, x) from t"), "-1.0,-1.0,-0.6666666666666666,-1.0");
    assert_eq!(rows("select covar_samp(x, y), covar_pop(x, y) from t where x = 1"), "null,0.0");
    assert_eq!(rows("select corr(x, y) from t where x = 1"), "NaN");
    assert_eq!(rows("select corr(x, y), regr_slope(y, x) from t where false"), "null,null");
}

#[test]
fn window_aggregates() {
    assert_eq!(
        rows("select g, quantile_disc(x, 0.5) over (partition by g), count_if(x > 1) over (partition by g) from t order by g, x"),
        "1,1,1|1,1,1|2,3,2|2,3,2|3,null,null"
    );
}

const SPILL_QUERIES: &[&str] = &[
    "select k, quantile_cont(x, 0.5) as q, quantile_disc(id, 0.3) as d, count_if(x > 100) as c, bool_and(x >= 0) as b, \
     max_by(id, x) as mb, min_by(id, id) as mi, round(corr(x, id), 6) as r, round(covar_pop(x, id), 3) as cv, sum(distinct few) as sd \
     from t group by k order by k",
    "select few, quantile_cont(x, 0.9) as q, product(case when id % 1000 = 0 then 2.0 else 1.0 end) as p, \
     round(regr_slope(x, id), 9) as sl from t group by few order by few",
];

fn facts(rows: i64) -> (Arc<Schema>, Vec<RecordBatch>) {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("k", DataType::Int64, false),
        Field::new("few", DataType::Int64, false),
        Field::new("x", DataType::Int64, false),
    ]));
    let batches = (0..rows)
        .step_by(65_536)
        .map(|start| {
            let ids: Vec<i64> = (start..(start + 65_536).min(rows)).collect();
            let cols: Vec<ArrayRef> = vec![
                Arc::new(Int64Array::from(ids.clone())),
                Arc::new(Int64Array::from(ids.iter().map(|i| (i * 7919) % 300_000).collect::<Vec<_>>())),
                Arc::new(Int64Array::from(ids.iter().map(|i| i % 50_000).collect::<Vec<_>>())),
                Arc::new(Int64Array::from(ids.iter().map(|i| (i * 31) % 1009).collect::<Vec<_>>())),
            ];
            RecordBatch::try_new(schema.clone(), cols).unwrap()
        })
        .collect();
    (schema, batches)
}

fn run(ctx: &SessionContext, q: &str) -> String {
    let (_, batches) = ctx.sql(q).unwrap().collect().unwrap();
    pretty_format_batches(&batches).unwrap().to_string()
}

#[test]
fn aggregates_match_under_a_small_memory_limit() {
    let (schema, batches) = facts(1_000_000);
    let ctx = SessionContext::new();
    ctx.register_batches("t", schema, batches).unwrap();
    let pool = memory::pool();
    pool.set_limit(usize::MAX);
    let expected: Vec<String> = SPILL_QUERIES.iter().map(|q| run(&ctx, q)).collect();
    pool.set_limit(4 << 20);
    let before = spilled_bytes();
    for (q, want) in SPILL_QUERIES.iter().zip(&expected) {
        assert_eq!(&run(&ctx, q), want, "{q}");
    }
    assert!(spilled_bytes() > before, "nothing was spilled");
    pool.set_limit(usize::MAX);
}

#[test]
fn trig_and_constants() {
    assert_eq!(rows("select pi(), sin(0), cos(0), atan2(1, 1), degrees(pi()), radians(180)"), "3.141592653589793,0.0,1.0,0.7853981633974483,180.0,3.141592653589793");
    assert_eq!(rows("select atan(1), tan(0), asin(1), acos(1), sin(x) from t where x = 1"), "0.7853981633974483,0.0,1.5707963267948966,0.0,0.8414709848078965");
    assert_eq!(rows("select sin(x), atan2(x, y) from t where x is null"), "null,null");
    assert_eq!(rows("select asin(2)"), "NaN");
}

#[test]
fn now_is_one_instant_per_query() {
    assert_eq!(rows("select count(distinct now()) from t"), "1");
    assert_eq!(rows("select now() = current_timestamp, current_date <= date(now()) from t limit 1"), "true,true");
    assert_eq!(rows("select year(now()) >= 2026, year(current_date) >= 2026"), "true,true");
}

#[test]
fn random_is_per_row_and_reproducible_with_a_seed() {
    assert_eq!(rows("select count(distinct random()), min(random()) >= 0, max(random()) < 1 from t"), "5,true,true");
    // two columns of the same row differ
    assert_eq!(rows("select count(*) from t where random() = random()"), "0");
    let a = rows("select random(42) from t");
    let b = rows("select random(42) from t");
    assert_eq!(a, b);
    assert_eq!(a.split('|').collect::<std::collections::HashSet<_>>().len(), 5);
    assert_ne!(a, rows("select random(43) from t"));
    assert_eq!(rows("select random(7, x) from t"), rows("select random(7, x) from t"));
    assert_eq!(rows("select random(7, x) from t where x = 2"), rows("select random(7, x) from t where x = 2 or x = 3").split('|').next().unwrap());
}

#[test]
fn rollup_cube_and_grouping_sets() {
    assert_eq!(
        rows("select g, x > 2 as b, sum(y), grouping(g), grouping(g, x > 2) from t group by rollup(g, x > 2) order by 1 nulls last, 2 nulls last, 5"),
        "1,false,5,0,0|1,null,5,0,1|2,true,1,0,0|2,null,1,0,1|3,null,9,0,0|3,null,9,0,1|null,null,15,1,3"
    );
    assert_eq!(rows("select g, sum(y), grouping(g) from t group by cube(g) having sum(y) > 2 order by 1 nulls last"), "1,5,0|3,9,0|null,15,1");
    assert_eq!(
        rows("select g, x, count(*) from t group by grouping sets ((g), (x), ()) order by 1 nulls last, 2 nulls last, 3"),
        "1,null,2|2,null,2|3,null,1|null,1,1|null,2,1|null,3,1|null,4,1|null,null,1|null,null,5"
    );
    assert_eq!(
        rows("select g, x, count(*) from t group by g, rollup(x) order by 1, 2 nulls last"),
        "1,1,1|1,2,1|1,null,2|2,3,1|2,4,1|2,null,2|3,null,1|3,null,1"
    );
    assert_eq!(rows("select g, sum(y) from t where false group by rollup(g)"), "null,null");
    assert_eq!(rows("select coalesce(cast(g as varchar), 'ALL') as k, sum(y) as s from t group by rollup(g) order by 1"), "1,5|2,1|3,9|ALL,15");
    assert!(ctx().sql("select grouping(g) from t group by g").unwrap().collect().is_err());
}

#[test]
fn sum_of_nothing_is_null() {
    assert_eq!(rows("select sum(case when x > 100 then x end), sum(x) filter (where x > 100), avg(x) from t where false"), "null,null,null");
}
