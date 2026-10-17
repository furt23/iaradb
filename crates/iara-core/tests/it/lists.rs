//! List columns: plumbing through the operators, the list functions, the list
//! aggregates and UNNEST. Expected values are what DuckDB returns (the Python
//! tests check them against DuckDB itself).


use std::sync::Arc;

use arrow::array::*;
use arrow::datatypes::{DataType, Field, Int64Type, Schema};
use arrow::record_batch::RecordBatch;
use crate::support::*;
use iara_core::SessionContext;

type Row = (i64, Option<Vec<Option<i64>>>);

fn sample() -> Vec<Row> {
    vec![
        (1, Some(vec![Some(1), Some(2), Some(3)])),
        (2, None),
        (3, Some(vec![])),
        (4, Some(vec![Some(4), None])),
        (5, Some(vec![Some(5)])),
    ]
}

fn ctx() -> SessionContext {
    let ctx = SessionContext::new();
    lists_table(&ctx, "t", sample());
    ctx
}

fn q(sql: &str) -> String {
    rows_in(&ctx(), sql)
}

/// Same SQL, no table: constants only.
fn k(sql: &str) -> String {
    rows_in(&SessionContext::new(), sql)
}

fn parquet_ctx(name: &str) -> (SessionContext, std::path::PathBuf) {
    let dir = std::env::temp_dir().join(format!("wh-lists-{}-{name}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("t.parquet");
    // the element field is called "element", as Spark and pyarrow write it
    let strings = ListArray::new(
        Arc::new(Field::new("element", DataType::Utf8, true)),
        arrow::buffer::OffsetBuffer::from_lengths([2, 0, 0, 2, 1]),
        Arc::new(StringArray::from(vec![Some("a"), Some("b"), Some("c"), None, Some("é")])),
        Some(arrow::buffer::NullBuffer::from(vec![true, false, true, true, true])),
    );
    let ints = ListArray::from_iter_primitive::<Int64Type, _, _>(sample().into_iter().map(|(_, l)| l));
    let schema = Arc::new(Schema::new(vec![
        Field::new("g", DataType::Int64, true),
        Field::new("l", ints.data_type().clone(), true),
        Field::new("s", strings.data_type().clone(), true),
    ]));
    let g: Int64Array = sample().iter().map(|(g, _)| Some(*g)).collect();
    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(g), Arc::new(ints), Arc::new(strings)]).unwrap();
    iara_core::io::parquet::write_parquet(path.to_str().unwrap(), schema, &[batch], "zstd", None).unwrap();
    let ctx = SessionContext::new();
    ctx.register_parquet("p", path.to_str().unwrap()).unwrap();
    (ctx, dir)
}

// ---------------------------------------------------------------------------
// type plumbing
// ---------------------------------------------------------------------------

#[test]
fn parquet_nested_columns_are_read() {
    let (ctx, dir) = parquet_ctx("scan");
    let all = rows_in(&ctx, "select g, l, s from p order by g");
    assert_eq!(all, "1,[1,2,3],['a','b']|2,null,null|3,[],[]|4,[4,null],['c',null]|5,[5],['é']");
    // a filter on a flat column prunes nothing but must keep nested columns aligned
    assert_eq!(rows_in(&ctx, "select l from p where g >= 4 order by g"), "[4,null]|[5]");
    assert_eq!(rows_in(&ctx, "select count(*), count(l), count(s) from p"), "5,4,4");
    // schema: canonical List<item>, shown as List<..>
    let df = ctx.sql("select l, s from p").unwrap();
    let schema = df.schema();
    assert_eq!(schema.to_string(), "[p.l: List<Int64>, p.s: List<Utf8>]");
    assert_eq!(schema.field(1).data_type(), &iara_core::nested::list_of(DataType::Utf8));
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn lists_flow_as_payload() {
    let c = ctx();
    // projection / filter / sort (payload) / limit
    assert_eq!(rows_in(&c, "select l from t where g > 3 order by g desc"), "[5]|[4,null]");
    assert_eq!(rows_in(&c, "select g, l from t order by g desc limit 2"), "5,[5]|4,[4,null]");
    assert_eq!(rows_in(&c, "select l from t limit 1 offset 3"), "[4,null]");
    // union
    assert_eq!(rows_in(&c, "select g, l from t where g = 1 union all select g, l from t where g = 5 order by g"), "1,[1,2,3]|5,[5]");
    // join with the list as payload on either side
    let ctx2 = SessionContext::new();
    lists_table(&ctx2, "a", sample());
    lists_table(&ctx2, "b", vec![(1, Some(vec![Some(9)])), (4, None), (5, Some(vec![None]))]);
    assert_eq!(
        rows_in(&ctx2, "select a.g, a.l, b.l from a join b on a.g = b.g order by a.g"),
        "1,[1,2,3],[9]|4,[4,null],null|5,[5],[null]"
    );
    assert_eq!(
        rows_in(&ctx2, "select a.g, b.l from a left join b on a.g = b.g order by a.g"),
        "1,[9]|2,null|3,null|4,null|5,[null]"
    );
    // aggregate with a list column carried by first(), group by flat key
    assert_eq!(rows_in(&c, "select g % 2 as k, count(*), count(l) from t group by 1 order by 1"), "0,2,1|1,3,3");
}

#[test]
fn lists_cannot_be_keys_yet() {
    let c = ctx();
    for sql in [
        "select l, count(*) from t group by l",
        "select distinct l from t",
        "select * from t order by l",
        "select a.g from t a join t b on a.l = b.l",
        "select g, row_number() over (partition by l order by g) from t",
    ] {
        let err = c.sql(sql).and_then(|df| df.collect()).err().unwrap_or_else(|| panic!("{sql} should fail")).to_string();
        assert!(err.contains("List<Int64>") && err.contains("yet"), "{sql}: {err}");
    }
}

// ---------------------------------------------------------------------------
// constructors and access
// ---------------------------------------------------------------------------

#[test]
fn constructors_and_subscripts() {
    assert_eq!(k("select [1,2,3], list_value(4,5), array[6]"), "[1,2,3],[4,5],[6]");
    assert_eq!(k("select [1,NULL], [], ['a','é']"), "[1,null],[],['a','é']");
    assert_eq!(k("select [1, 2.5]"), "[1.0,2.5]");
    assert_eq!(k("select ([1,2,3])[2], ([1,2,3])[-1], ([1,2,3])[4], ([1,2,3])[0], list_extract([1,2,3], 3), array_extract([1,2,3], 1)"), "2,3,null,null,3,1");
    assert_eq!(q("select g, l[1], l[2], l[-1] from t order by g"), "1,1,2,3|2,null,null,null|3,null,null,null|4,4,null,null|5,5,null,5");
    assert_eq!(k("select ([1,2,3,4])[2:3], ([1,2,3,4])[:2], ([1,2,3,4])[3:], ([1,2,3,4])[-2:]"), "[2,3],[1,2],[3,4],[3,4]");
    assert_eq!(k("select list_slice([1,2,3,4],-2,4), list_slice([1,2,3,4],0,2), list_slice([1,2,3,4],3,2), list_slice([1,2,3,4],2,10), list_slice([1,2,3,4],1,-1), list_slice([1,2,3,4],1,0)"), "[3,4],[1,2],[],[2,3,4],[1,2,3,4],[]");
    assert_eq!(q("select l[2:] from t order by g"), "[2,3]|null|[]|[null]|[]");
    assert_eq!(k("select [[1,2],[3]], ([[1,2],[3]])[1][2]"), "[[1,2],[3]],2");
}

#[test]
fn lengths_and_search() {
    assert_eq!(q("select len(l) a, array_length(l) b, cardinality(l) c from t order by g"), "3,3,3|null,null,null|0,0,0|2,2,2|1,1,1");
    assert_eq!(k("select len('héllo'), length('abc')"), "5,3");
    assert_eq!(q("select list_contains(l, 2) a, array_contains(l, 4) b, list_has(l, 5) c from t order by g"), "true,false,false|null,null,null|false,false,false|false,true,false|false,false,true");
    assert_eq!(q("select contains(l, 3) from t order by g"), "true|null|false|false|false");
    assert_eq!(k("select list_contains([1,NULL], 5), list_contains([1,NULL], NULL), list_contains(NULL::int[], 1), list_contains(['a','b'], 'b')"), "false,null,null,true");
    assert_eq!(q("select list_position(l, 3) a, list_position(l, NULL) b from t order by g"), "3,null|null,null|null,null|null,2|null,null");
    assert_eq!(k("select list_position([1,2,3], 4), list_position(['x','y'], 'y'), list_contains([1,2], 2.0)"), "null,2,true");
}

#[test]
fn building_and_ordering() {
    assert_eq!(q("select list_concat(l, [9]) from t order by g"), "[1,2,3,9]|[9]|[9]|[4,null,9]|[5,9]");
    assert_eq!(q("select l || [9] from t order by g"), "[1,2,3,9]|null|[9]|[4,null,9]|[5,9]");
    assert_eq!(k("select [1,2] || [3], list_concat([1], [2], [3]), list_concat(NULL::int[], NULL::int[])"), "[1,2,3],[1,2,3],[]");
    assert_eq!(k("select list_sort([3,NULL,1,2]), list_sort([3,NULL,1],'DESC'), list_sort([3,NULL,1],'ASC','NULLS FIRST'), array_sort(['b',NULL,'a'])"), "[1,2,3,null],[3,1,null],[null,1,3],['a','b',null]");
    assert_eq!(k("select list_reverse([1,NULL,3]), reverse([1,2]), reverse('abc')"), "[3,null,1],[2,1],cba");
    assert_eq!(k("select list_distinct([1,NULL,1,2]), list_unique([1,NULL,1,2]), array_distinct(['b','a','b'])"), "[1,2],2,['b','a']");
    assert_eq!(q("select list_sort(l, 'DESC') from t order by g"), "[3,2,1]|null|[]|[4,null]|[5]");
}

#[test]
fn reductions_and_splits() {
    assert_eq!(k("select array_to_string([1,NULL,3],'-'), array_to_string(['a','b'], ', '), array_to_string([], ','), array_to_string(NULL::int[], ',')"), "1-3,a, b,,null");
    assert_eq!(k("select coalesce(NULL::int[], []), coalesce([1], [])"), "[],[1]");
    assert_eq!(k("select array_to_string([NULL,NULL]::int[], ','), array_to_string([NULL,'a'], ',')"), "null,a");
    assert_eq!(k("select list_aggr([1,2,NULL],'sum'), list_sum([]), list_sum(NULL::int[]), list_avg([1,2]), list_min([3,1]), list_max(['b','a']), list_count([1,NULL])"), "3,null,null,1.5,1,b,1");
    assert_eq!(q("select list_sum(l), list_max(l), list_aggr(l, 'avg'), list_count(l) from t order by g"), "6,3,2.0,3|null,null,null,null|null,null,null,0|4,4,4.0,1|5,5,5.0,1");
    assert_eq!(k("select string_split('a,b,,c', ','), string_split('abc', ''), string_split('', ''), string_split(NULL, ','), string_split('', ','), str_split('é;ü', ';'), split('x-y', '-')"), "['a','b','','c'],['a','b','c'],[''],null,[''],['é','ü'],['x','y']");
    assert_eq!(k("select regexp_split_to_array('a1b22c', '[0-9]+'), regexp_split_to_array('a, b,c', ', ?')"), "['a','b','c'],['a','b','c']");
    assert_eq!(k("select array_to_string(string_split('a b c', ' '), '+')"), "a+b+c");
}

#[test]
fn list_functions_report_clear_errors() {
    let err = |sql: &str| SessionContext::new().sql(sql).and_then(|d| d.collect()).err().unwrap_or_else(|| panic!("{sql}")).to_string();
    assert!(err("select list_extract(1, 1)").contains("list"));
    assert!(err("select [1] || ['a']").contains("incompatible"));
    assert!(err("select list_sort([1], 'sideways')").contains("unknown order"));
    assert!(err("select list_aggr([1], 'nope')").contains("unknown aggregate"));
    assert!(err("select unnest(1)").contains("list"));
}

// ---------------------------------------------------------------------------
// aggregates
// ---------------------------------------------------------------------------

fn agg_ctx() -> SessionContext {
    let ctx = SessionContext::new();
    let schema = Arc::new(Schema::new(vec![
        Field::new("g", DataType::Int64, true),
        Field::new("x", DataType::Int64, true),
        Field::new("y", DataType::Int64, true),
        Field::new("s", DataType::Utf8, true),
    ]));
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(vec![1, 1, 1, 2, 2, 3])),
        Arc::new(Int64Array::from(vec![Some(1), None, Some(3), Some(5), Some(5), None])),
        Arc::new(Int64Array::from(vec![3, 2, 1, 1, 2, 9])),
        Arc::new(StringArray::from(vec![Some("b"), None, Some("a"), Some("é"), Some("é"), None])),
    ];
    ctx.register_batches("a", schema.clone(), vec![RecordBatch::try_new(schema, cols).unwrap()]).unwrap();
    ctx
}

fn a(sql: &str) -> String {
    rows_in(&agg_ctx(), sql)
}

#[test]
fn array_agg_keeps_nulls_and_scan_order() {
    assert_eq!(a("select g, array_agg(x) from a group by g order by g"), "1,[1,null,3]|2,[5,5]|3,[null]");
    assert_eq!(a("select g, list(s) from a group by g order by g"), "1,['b',null,'a']|2,['é','é']|3,[null]");
    assert_eq!(a("select array_agg(x) from a"), "[1,null,3,5,5,null]");
    assert_eq!(a("select array_agg(x) from a where false"), "null");
    assert_eq!(a("select array_agg(x) filter (where x > 100) from a"), "null");
    assert_eq!(a("select g, array_agg(x) filter (where y > 1) from a group by g order by g"), "1,[1,null]|2,[5]|3,[null]");
    assert_eq!(
        a("select g, array_agg(x), sum(y), array_agg(y) from a group by g order by g"),
        "1,[1,null,3],6,[3,2,1]|2,[5,5],3,[1,2]|3,[null],9,[9]"
    );
}

#[test]
fn array_agg_order_by() {
    assert_eq!(a("select g, list(x order by y) from a group by g order by g"), "1,[3,null,1]|2,[5,5]|3,[null]");
    assert_eq!(a("select g, array_agg(x order by x desc) from a group by g order by g"), "1,[3,1,null]|2,[5,5]|3,[null]");
    assert_eq!(a("select array_agg(x order by x nulls first) from a"), "[null,null,1,3,5,5]");
    assert_eq!(a("select array_agg(y order by g desc, y) from a"), "[9,1,2,1,2,3]");
    assert_eq!(a("select array_agg(s order by s) from a"), "['a','b','é','é',null,null]");
}

#[test]
fn collect_and_distinct() {
    assert_eq!(a("select g, collect_list(x) from a group by g order by g"), "1,[1,3]|2,[5,5]|3,[]");
    assert_eq!(a("select g, collect_set(x) from a group by g order by g"), "1,[1,3]|2,[5]|3,[]");
    assert_eq!(a("select array_agg(distinct x) from a"), "[1,null,3,5]");
    assert_eq!(a("select array_agg(distinct x order by x desc) from a"), "[5,3,1,null]");
    assert_eq!(a("select collect_set(s) from a"), "['b','a','é']");
    assert_eq!(a("select collect_list(x) from a where false"), "[]");
}

#[test]
fn array_agg_of_lists_and_windows() {
    assert_eq!(rows_in(&ctx(), "select array_agg(l order by g) from t"), "[[1,2,3],null,[],[4,null],[5]]");
    assert_eq!(
        rows_in(&ctx(), "select g % 2 k, array_agg(l order by g) from t group by 1 order by 1"),
        "0,[null,[4,null]]|1,[[1,2,3],[],[5]]"
    );
    let err = agg_ctx().sql("select array_agg(x) over (partition by g) from a").and_then(|d| d.collect()).err().unwrap().to_string();
    assert!(err.contains("array_agg"), "{err}");
}

#[test]
fn array_agg_over_many_groups_uses_the_radix_path() {
    // 400k rows in 200k groups of 2: workers switch to radix mode, scatter raw rows and aggregate by partition
    let ctx = SessionContext::new();
    let n = 400_000i64;
    let schema = Arc::new(Schema::new(vec![Field::new("k", DataType::Int64, false), Field::new("i", DataType::Int64, false)]));
    let batches: Vec<RecordBatch> = (0..n)
        .step_by(40_000)
        .map(|s| {
            let ids: Vec<i64> = (s..s + 40_000).collect();
            let keys = Int64Array::from_iter_values(ids.iter().map(|i| i % 200_000));
            let cols: Vec<ArrayRef> = vec![Arc::new(keys), Arc::new(Int64Array::from(ids))];
            RecordBatch::try_new(schema.clone(), cols).unwrap()
        })
        .collect();
    ctx.register_batches("big", schema, batches).unwrap();
    let sql = "select k, array_agg(i) a, array_agg(i order by i desc) d from big group by k order by k";
    let (_, out) = ctx.sql(sql).unwrap().collect().unwrap();
    let mut seen = 0;
    for b in &out {
        let (k, a, d) = (b.column(0).as_primitive::<Int64Type>(), b.column(1).as_list::<i32>(), b.column(2).as_list::<i32>());
        for r in 0..b.num_rows() {
            let key = k.value(r);
            let (av, dv) = (a.value(r), d.value(r));
            let (av, dv) = (av.as_primitive::<Int64Type>(), dv.as_primitive::<Int64Type>());
            assert_eq!((av.value(0), av.value(1)), (key, key + 200_000), "scan order of k={key}");
            assert_eq!((dv.value(0), dv.value(1)), (key + 200_000, key));
            seen += 1;
        }
    }
    assert_eq!(seen, 200_000);
}

// ---------------------------------------------------------------------------
// unnest
// ---------------------------------------------------------------------------

#[test]
fn unnest_in_the_select_list() {
    assert_eq!(q("select unnest(l) from t"), "1|2|3|4|null|5");
    assert_eq!(q("select g, unnest(l) as e from t order by g"), "1,1|1,2|1,3|4,4|4,null|5,5");
    assert_eq!(k("select unnest([1,2,3]) a, unnest([7]) b"), "1,7|2,null|3,null");
    assert_eq!(k("select 1 as a, unnest([1,2]) as b, unnest([10,20,30]) as c"), "1,1,10|1,2,20|1,null,30");
    assert_eq!(q("select g, unnest(l) + 1 from t order by g"), "1,2|1,3|1,4|4,5|4,null|5,6");
    assert_eq!(k("select unnest([]::int[]), unnest(NULL::int[])"), "");
    assert_eq!(q("select count(*) from (select unnest(l) from t)"), "6");
    assert_eq!(q("select e from (select g, unnest(l) as e from t) where e > 1 order by e"), "2|3|4|5");
    assert_eq!(q("select * from (select g, l, unnest(l) as e from t where g = 1)"), "1,[1,2,3],1|1,[1,2,3],2|1,[1,2,3],3");
}

#[test]
fn unnest_as_a_table_function() {
    assert_eq!(q("select g, x from t, unnest(t.l) as u(x) order by g"), "1,1|1,2|1,3|4,4|4,null|5,5");
    assert_eq!(
        q("select t.g, u.x from t cross join unnest(t.l) as u(x) where u.x is not null order by t.g, u.x"),
        "1,1|1,2|1,3|4,4|5,5"
    );
    assert_eq!(k("select * from unnest([1,2,3]) t(x)"), "1|2|3");
    assert_eq!(k("select sum(x) from unnest([1,2,3]) as t(x)"), "6");
    assert_eq!(q("select sum(x), count(*) from t, unnest(t.l) as u(x)"), "15,6");
    assert_eq!(q("select g, sum(x) from t, unnest(t.l) as u(x) group by g order by g"), "1,6|4,4|5,5");
    assert_eq!(q("select * from t, unnest(t.l) order by g limit 1"), "1,[1,2,3],1");
}

#[test]
fn unnest_streams_large_expansions() {
    // 2000 rows x 1000 elements: emitted in many batches
    let ctx = SessionContext::new();
    let rows: Vec<Row> = (0..2000).map(|g| (g, Some((0..1000).map(Some).collect()))).collect();
    lists_table(&ctx, "wide", rows);
    assert_eq!(rows_in(&ctx, "select count(*), sum(e), min(e), max(e) from (select unnest(l) as e from wide)"), "2000000,999000000,0,999");
}
