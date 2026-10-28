//! Aggregations over inner joins that the optimizer pre-aggregates below the
//! join (eager aggregation). Each query is compared with the same query whose
//! aggregates also read the other side through a FILTER that always holds
//! there, which keeps the aggregation above the join.

use std::sync::Arc;

use arrow::array::{ArrayRef, BooleanArray, Decimal128Array, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use arrow::util::display::array_value_to_string;
use iara_core::SessionContext;

fn rand(seed: &mut u64) -> u64 {
    *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
    *seed >> 33
}

/// `cust` (50 customers, 7 twice with the same attributes, 8 twice with
/// different ones), `nat` and `ord` (2000 orders, some for unknown customers,
/// some keys and values NULL).
fn ctx() -> SessionContext {
    let ctx = SessionContext::new();
    let mut ck: Vec<i64> = (0..50).collect();
    ck.extend([7, 8]);
    let name: Vec<String> = ck.iter().map(|k| format!("c{k}")).collect();
    let mut seg: Vec<String> = ck.iter().map(|k| ["A", "B", "C"][(*k % 3) as usize].to_string()).collect();
    *seg.last_mut().unwrap() = "Z".into();
    let nk: Vec<i64> = ck.iter().map(|k| k % 5).collect();
    let schema = Arc::new(Schema::new(vec![
        Field::new("ck", DataType::Int64, true),
        Field::new("name", DataType::Utf8, true),
        Field::new("seg", DataType::Utf8, true),
        Field::new("nk", DataType::Int64, true),
    ]));
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(ck)),
        Arc::new(StringArray::from(name)),
        Arc::new(StringArray::from(seg)),
        Arc::new(Int64Array::from(nk)),
    ];
    ctx.register_batches("cust", schema.clone(), vec![RecordBatch::try_new(schema, cols).unwrap()]).unwrap();

    let schema = Arc::new(Schema::new(vec![Field::new("nk", DataType::Int64, true), Field::new("nname", DataType::Utf8, true)]));
    let cols: Vec<ArrayRef> =
        vec![Arc::new(Int64Array::from((0..5).collect::<Vec<i64>>())), Arc::new(StringArray::from(vec!["n0", "n1", "n2", "n3", "n4"]))];
    ctx.register_batches("nat", schema.clone(), vec![RecordBatch::try_new(schema, cols).unwrap()]).unwrap();

    let mut s = 42u64;
    let n = 2000;
    let mut ok = vec![];
    let mut ov = vec![];
    let mut op = vec![];
    let mut od = vec![];
    let mut flag = vec![];
    for _ in 0..n {
        ok.push((rand(&mut s) % 30 != 0).then(|| (rand(&mut s) % 60) as i64));
        ov.push((rand(&mut s) % 10 != 0).then(|| (rand(&mut s) % 1000) as i64 - 300));
        // halves: exact in f64 whatever the order of the additions
        op.push((rand(&mut s) % 10 != 0).then(|| (rand(&mut s) % 400) as f64 * 0.5));
        od.push((rand(&mut s) % 10 != 0).then(|| (rand(&mut s) % 100_000) as i128));
        flag.push((rand(&mut s) % 10 != 0).then(|| rand(&mut s) % 2 == 0));
    }
    let schema = Arc::new(Schema::new(vec![
        Field::new("ok", DataType::Int64, true),
        Field::new("ov", DataType::Int64, true),
        Field::new("op", DataType::Float64, true),
        Field::new("od", DataType::Decimal128(15, 2), true),
        Field::new("flag", DataType::Boolean, true),
    ]));
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(ok)),
        Arc::new(Int64Array::from(ov)),
        Arc::new(Float64Array::from(op)),
        Arc::new(Decimal128Array::from(od).with_precision_and_scale(15, 2).unwrap()),
        Arc::new(BooleanArray::from(flag)),
    ];
    // several batches: several partial tables to merge
    let batch = RecordBatch::try_new(schema.clone(), cols).unwrap();
    let batches = (0..n).step_by(300).map(|i| batch.slice(i, 300.min(n - i))).collect();
    ctx.register_batches("ord", schema, batches).unwrap();
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

fn pushed(ctx: &SessionContext, sql: &str) -> bool {
    ctx.sql(sql).unwrap().explain(true).unwrap().contains("__pa0")
}

/// `{f}` in `sql` is the FILTER of every aggregate: none, or one that reads `c`.
fn check(sql: &str, expect_pushed: bool) {
    let ctx = ctx();
    let plain = sql.replace("{f}", "");
    let blocked = sql.replace("{f}", " filter (where c.ck is not null)");
    assert_eq!(pushed(&ctx, &plain), expect_pushed, "{plain}\n{}", ctx.sql(&plain).unwrap().explain(true).unwrap());
    assert!(!pushed(&ctx, &blocked), "{blocked}");
    let got = rows(&ctx, &plain);
    assert!(!got.is_empty());
    assert_eq!(got, rows(&ctx, &blocked), "{plain}");
}

#[test]
fn combinable_aggregates() {
    check(
        "select c.ck, c.name, c.seg, count(*){f}, count(o.ov){f}, sum(o.ov){f}, min(o.ov){f}, max(o.op){f}, \
         avg(o.ov){f}, avg(o.op){f}, avg(o.od){f}, sum(o.od){f}, min(o.od){f}, bool_and(o.flag){f}, bool_or(o.flag){f}, \
         count_if(o.flag){f} \
         from cust c join ord o on c.ck = o.ok group by c.ck, c.name, c.seg order by c.ck, c.seg",
        true,
    );
}

#[test]
fn aggregate_filters_and_expressions() {
    check(
        "select c.seg, sum(o.ov * 2 + 1){f}, count(*) filter (where o.flag{f2}), sum(o.od) filter (where o.ov > 0{f2}) \
         from cust c join ord o on o.ok = c.ck group by c.seg order by c.seg"
            .replace("{f2}", "")
            .as_str(),
        true,
    );
}

#[test]
fn three_tables_like_the_lazyframe_report() {
    check(
        "select c.name, n.nname, c.seg, count(*){f}, sum(o.od){f} \
         from cust c join nat n on c.nk = n.nk join ord o on c.ck = o.ok \
         group by c.ck, c.name, n.nname, c.seg order by c.ck, c.seg",
        true,
    );
}

#[test]
fn pushed_side_on_the_left() {
    check("select c.name, sum(o.ov){f}, count(*){f} from ord o join cust c on o.ok = c.ck group by c.name order by c.name", true);
}

#[test]
fn grouping_by_a_column_of_the_pushed_side() {
    // the orders' own column multiplies the groups: no estimate of it, no pushdown
    check("select c.seg, o.flag, sum(o.ov){f} from cust c join ord o on c.ck = o.ok group by c.seg, o.flag order by c.seg, o.flag", false);
    // the join key itself adds nothing
    check("select o.ok, sum(o.ov){f} from cust c join ord o on c.ck = o.ok group by o.ok order by o.ok", true);
}

#[test]
fn few_final_groups() {
    // 5 nations: pre-aggregating 2000 orders into 50 customers is not worth it (50 > 8 x 5)
    check("select c.nk, sum(o.ov){f}, count(*){f} from cust c join ord o on c.ck = o.ok group by c.nk order by c.nk", false);
}

#[test]
fn not_pushed() {
    let ctx = ctx();
    for sql in [
        // reads both sides
        "select c.seg, sum(o.ov + c.ck) from cust c join ord o on c.ck = o.ok group by c.seg",
        // not combinable
        "select c.seg, count(distinct o.ov) from cust c join ord o on c.ck = o.ok group by c.seg",
        "select c.seg, median(o.ov) from cust c join ord o on c.ck = o.ok group by c.seg",
        // outer joins keep unmatched rows
        "select c.seg, count(o.ov) from cust c left join ord o on c.ck = o.ok group by c.seg",
        // a global count over an empty join is 0
        "select count(*), sum(o.ov) from cust c join ord o on c.ck = o.ok",
        // the join drops most orders
        "select c.seg, sum(o.ov) from cust c join ord o on c.ck = o.ok where c.seg = 'A' and c.ck < 3 group by c.seg",
    ] {
        assert!(!pushed(&ctx, sql), "{sql}");
        assert!(!rows(&ctx, sql).is_empty(), "{sql}");
    }
}
