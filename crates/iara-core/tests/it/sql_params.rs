//! Bound SQL parameters: `$1`, `?`, `:name`, `$name`.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use arrow::util::pretty::pretty_format_batches;
use iara_core::{Params, Scalar, SessionContext};

use super::support::dir::TempDir;

fn ctx() -> SessionContext {
    let ctx = SessionContext::new();
    let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, false), Field::new("name", DataType::Utf8, false)]));
    let batch = RecordBatch::try_new(
        schema.clone(),
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3, 4])),
            Arc::new(StringArray::from(vec!["a:b", "bob", "carol", "dave"])),
        ],
    )
    .unwrap();
    ctx.register_batches("t", schema, vec![batch]).unwrap();
    ctx
}

fn positional(values: Vec<Scalar>) -> Params {
    Params::Positional(values)
}

fn named(values: Vec<(&str, Scalar)>) -> Params {
    Params::Named(values.into_iter().map(|(k, v)| (k.to_string(), v)).collect::<HashMap<_, _>>())
}

fn run(ctx: &SessionContext, q: &str, params: &Params) -> String {
    let (_, batches) = ctx.sql_with(q, params).unwrap().collect().unwrap();
    pretty_format_batches(&batches).unwrap().to_string()
}

fn first(ctx: &SessionContext, q: &str, params: &Params) -> String {
    let (_, batches) = ctx.sql_with(q, params).unwrap().collect().unwrap();
    arrow::util::display::array_value_to_string(batches[0].column(0), 0).unwrap()
}

fn error(ctx: &SessionContext, q: &str, params: &Params) -> String {
    match ctx.sql_with(q, params) {
        Ok(_) => panic!("{q} should fail"),
        Err(e) => e.to_string(),
    }
}

fn ids(ctx: &SessionContext, q: &str, params: &Params) -> Vec<i64> {
    let (_, batches) = ctx.sql_with(q, params).unwrap().collect().unwrap();
    let mut out = vec![];
    for b in batches {
        let col = b.column(0).as_any().downcast_ref::<Int64Array>().unwrap();
        out.extend(col.iter().flatten());
    }
    out
}

#[test]
fn dollar_numbers() {
    let ctx = ctx();
    let p = positional(vec![Scalar::int64(2), Scalar::int64(4)]);
    assert_eq!(ids(&ctx, "select id from t where id >= $1 and id <= $2 order by id", &p), vec![2, 3, 4]);
    // used out of order and more than once
    assert_eq!(ids(&ctx, "select id from t where id = $2 or id = $1 or id = $2 order by id", &p), vec![2, 4]);
}

#[test]
fn question_marks_take_values_in_order() {
    let ctx = ctx();
    let p = positional(vec![Scalar::int64(2), Scalar::utf8("dave")]);
    assert_eq!(ids(&ctx, "select id from t where id >= ? or name = ? order by id", &p), vec![2, 3, 4]);
    // the order is the text's, not the planner's: the CTE comes first in the text
    let q = "with c as (select id from t where id > ?) select id from c where id < ? order by id";
    assert_eq!(ids(&ctx, q, &positional(vec![Scalar::int64(1), Scalar::int64(4)])), vec![2, 3]);
}

#[test]
fn colon_and_dollar_names() {
    let ctx = ctx();
    let p = named(vec![("lo", Scalar::int64(2)), ("hi", Scalar::int64(3))]);
    assert_eq!(ids(&ctx, "select id from t where id between :lo and :hi order by id", &p), vec![2, 3]);
    assert_eq!(ids(&ctx, "select id from t where id between $lo and $hi order by id", &p), vec![2, 3]);
    assert_eq!(ids(&ctx, "select id from t where id = :lo or id = $hi order by id", &p), vec![2, 3]);
    // keys written with their prefix are the same name
    let p = named(vec![(":lo", Scalar::int64(1)), ("$hi", Scalar::int64(1))]);
    assert_eq!(ids(&ctx, "select id from t where id between :lo and :hi", &p), vec![1]);
}

#[test]
fn everywhere_an_expression_goes() {
    let ctx = ctx();
    let p = named(vec![("n", Scalar::int64(2)), ("k", Scalar::int64(10))]);
    // select list, arithmetic
    assert_eq!(first(&ctx, "select :k + id from t where id = 1", &p), "11");
    // LIMIT and OFFSET
    assert_eq!(ids(&ctx, "select id from t order by id limit :n offset :n", &p), vec![3, 4]);
    // subquery and CTE
    assert_eq!(first(&ctx, "select count(*) from (select id from t where id > :n) s", &p), "2");
    assert_eq!(first(&ctx, "with c as (select id + :k as v from t) select max(v) from c", &p), "14");
    // function argument, CASE, IN list
    assert_eq!(first(&ctx, "select upper(:n_text)", &named(vec![("n_text", Scalar::utf8("ab"))])), "AB");
    assert_eq!(first(&ctx, "select case when id > :n then 'big' else 'small' end from t where id = 3", &p), "big");
    assert_eq!(first(&ctx, "select count(*) from t where id in (:n, :k, 4)", &p), "2");
    // INTERVAL
    assert_eq!(first(&ctx, "select cast(date '2024-01-01' + interval :n day as varchar)", &p), "2024-01-03");
}

#[test]
fn values_and_types() {
    let ctx = ctx();
    let p = positional(vec![
        Scalar::int64(7),
        Scalar::float64(1.5),
        Scalar::utf8("it's"),
        Scalar::boolean(true),
        Scalar::null(),
    ]);
    let (_, batches) = ctx.sql_with("select $1 as i, $2 as f, $3 as s, $4 as b, $5 as n", &p).unwrap().collect().unwrap();
    let types: Vec<DataType> = batches[0].schema().fields().iter().map(|f| f.data_type().clone()).collect();
    assert_eq!(types, vec![DataType::Int64, DataType::Float64, DataType::Utf8, DataType::Boolean, DataType::Null]);
    let text = pretty_format_batches(&batches).unwrap().to_string();
    assert!(text.contains("it's") && text.contains("1.5") && text.contains("true"), "{text}");

    // null is a null, not the text 'null'
    assert_eq!(first(&ctx, "select count(*) from t where $1 is null", &positional(vec![Scalar::null()])), "4");

    // a date, a timestamp, a decimal
    let date = Scalar::date32(19723); // 2024-01-01
    assert_eq!(first(&ctx, "select cast($1 as varchar)", &positional(vec![date.clone()])), "2024-01-01");
    assert_eq!(first(&ctx, "select $1 + interval 1 day", &positional(vec![date])), "2024-01-02");
    let ts = Scalar::timestamp_us(1_704_067_200_000_000 + 3_600_000_000, None); // 2024-01-01 01:00:00
    assert_eq!(first(&ctx, "select cast($1 as varchar)", &positional(vec![ts.clone()])), "2024-01-01T01:00:00");
    assert_eq!(first(&ctx, "select $1 > timestamp '2024-01-01 00:30:00'", &positional(vec![ts])), "true");
    let dec = Scalar::decimal128(12345, 5, 2).unwrap(); // 123.45
    assert_eq!(first(&ctx, "select $1", &positional(vec![dec.clone()])), "123.45");
    assert_eq!(first(&ctx, "select $1 + 1", &positional(vec![dec])), "124.45");
}

#[test]
fn text_is_a_value_not_sql() {
    let ctx = ctx();
    let evil = "x'; drop table t; --";
    let p = positional(vec![Scalar::utf8(evil)]);
    assert_eq!(first(&ctx, "select $1", &p), evil);
    assert_eq!(first(&ctx, "select count(*) from t where name = $1", &p), "0");
    assert_eq!(first(&ctx, "select count(*) from t", &Params::None), "4");
}

#[test]
fn placeholders_in_literals_comments_and_casts_are_untouched() {
    let ctx = ctx();
    let p = Params::None;
    assert_eq!(first(&ctx, "select '? $1 :name $name'", &p), "? $1 :name $name");
    assert_eq!(first(&ctx, "select 1 -- ? :x $1\n", &p), "1");
    assert_eq!(first(&ctx, "select /* :x ? */ 2", &p), "2");
    assert_eq!(first(&ctx, "select cast(id as varchar)::varchar from t where id = 1", &p), "1");
    assert_eq!(first(&ctx, "select id::bigint from t where id = 1", &p), "1");
    // a name that is also in a literal is still a placeholder outside it
    let p = named(vec![("x", Scalar::int64(5))]);
    assert_eq!(first(&ctx, "select ':x' || cast(:x as varchar)", &p), ":x5");
    // a struct key and a slice are not placeholders
    assert_eq!(first(&ctx, "select {'a':id}['a'] from t where id = 2", &Params::None), "2");
    assert_eq!(first(&ctx, "select len(l[1:2]) from (select [10, 20, 30] as l) x", &Params::None), "2");
    // a colon inside a value with the placeholder after it
    assert_eq!(first(&ctx, "select count(*) from t where name = 'a:b' and id = :x - 4", &p), "1");
}

#[test]
fn missing_parameters_are_all_listed() {
    let ctx = ctx();
    let e = error(&ctx, "select id from t where id = $1 or id = $3 or id = $4", &positional(vec![Scalar::int64(1), Scalar::int64(2)]));
    assert!(e.contains("$3") && e.contains("$4") && !e.contains("$1"), "{e}");
    let e = error(&ctx, "select ? + ? + ?", &positional(vec![Scalar::int64(1)]));
    assert!(e.contains("$2") && e.contains("$3"), "{e}");
    let e = error(&ctx, "select :a + :b + $c + :a", &named(vec![("b", Scalar::int64(1))]));
    assert!(e.contains(":a") && e.contains("$c") && !e.contains(":b"), "{e}");
    // no parameters at all
    let e = error(&ctx, "select id from t where id = $1", &Params::None);
    assert!(e.contains("$1"), "{e}");
    let e = error(&ctx, "select :x", &Params::None);
    assert!(e.contains(":x"), "{e}");
    // in a statement that writes, before it does anything
    let e = error(&ctx, "create table u as select * from t where id = :id", &Params::None);
    assert!(e.contains(":id"), "{e}");
}

#[test]
fn extra_parameters_are_fine() {
    let ctx = ctx();
    let p = positional(vec![Scalar::int64(1), Scalar::int64(2), Scalar::int64(3)]);
    assert_eq!(first(&ctx, "select $1", &p), "1");
    let p = named(vec![("a", Scalar::int64(1)), ("unused", Scalar::int64(2))]);
    assert_eq!(first(&ctx, "select :a", &p), "1");
    // a statement without placeholders ignores them all
    assert_eq!(first(&ctx, "select 3", &p), "3");
}

#[test]
fn mixing_styles_is_an_error() {
    let ctx = ctx();
    let p = positional(vec![Scalar::int64(1), Scalar::int64(2)]);
    let e = error(&ctx, "select ? + $2", &p);
    assert!(e.contains("mix"), "{e}");
    let e = error(&ctx, "select $1 + :a", &p);
    assert!(e.contains("mix"), "{e}");
    let e = error(&ctx, "select :a + ?", &named(vec![("a", Scalar::int64(1))]));
    assert!(e.contains("mix"), "{e}");
    // the kind of value given must match the statement
    let e = error(&ctx, "select :a", &p);
    assert!(e.contains("positional") && e.contains("named"), "{e}");
    let e = error(&ctx, "select $1", &named(vec![("a", Scalar::int64(1))]));
    assert!(e.contains("positional") && e.contains("named"), "{e}");
    // `$0` does not exist
    let e = error(&ctx, "select $0", &p);
    assert!(e.contains("$1"), "{e}");
    // `:a` and `$a` are one name, so they mix fine
    assert_eq!(first(&ctx, "select :a + $a", &named(vec![("a", Scalar::int64(2))])), "4");
}

#[test]
fn sql_without_params_still_runs() {
    let ctx = ctx();
    let (_, batches) = ctx.sql("select count(*) from t where id > 1").unwrap().collect().unwrap();
    assert_eq!(arrow::util::display::array_value_to_string(batches[0].column(0), 0).unwrap(), "3");
}

#[test]
fn params_reach_statements_that_write() {
    let ctx = ctx();
    let dir = TempDir::new("sql-params");

    // CREATE TABLE AS
    let p = named(vec![("min", Scalar::int64(3))]);
    ctx.sql_with("create table big as select id, name from t where id >= :min", &p).unwrap();
    assert_eq!(first(&ctx, "select count(*) from big", &Params::None), "2");

    // INSERT .. SELECT with `?`, and INSERT .. VALUES
    ctx.sql_with("insert into big select id, name from t where id = ?", &positional(vec![Scalar::int64(1)])).unwrap();
    assert_eq!(first(&ctx, "select count(*) from big", &Params::None), "3");
    ctx.sql_with("insert into big values ($1, $2)", &positional(vec![Scalar::int64(9), Scalar::utf8("zed")])).unwrap();
    assert!(run(&ctx, "select name from big where id = 9", &Params::None).contains("zed"));
    ctx.sql_with("insert into big (id, name) values (:i, :n)", &named(vec![("i", Scalar::int64(10)), ("n", Scalar::null())])).unwrap();
    assert_eq!(first(&ctx, "select count(*) from big where name is null", &Params::None), "1");

    // COPY
    let out = dir.join("out.csv");
    ctx.sql_with(&format!("copy (select id from t where id > $1) to '{out}' (format csv)"), &positional(vec![Scalar::int64(2)])).unwrap();
    let written = std::fs::read_to_string(&out).unwrap();
    assert_eq!(written.lines().collect::<Vec<_>>(), vec!["id", "3", "4"]);

    // a missing value stops the statement before it writes
    let before = first(&ctx, "select count(*) from big", &Params::None);
    let e = error(&ctx, "insert into big select id, name from t where id = $2", &positional(vec![Scalar::int64(1)]));
    assert!(e.contains("$2"), "{e}");
    assert_eq!(first(&ctx, "select count(*) from big", &Params::None), before);
}
