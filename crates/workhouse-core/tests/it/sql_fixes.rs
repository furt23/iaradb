//! `SELECT * REPLACE / RENAME`, `TABLESAMPLE`, `AS OF` and `DISTINCT ON`: each used to be
//! accepted and ignored, or rejected, instead of doing what it says.

use std::sync::Arc;

use arrow::array::{Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use crate::support::*;
use workhouse_core::SessionContext;

/// `small(a, b, c)`: five rows; `big(id, g)`: 10 000 rows.
fn ctx() -> SessionContext {
    let ctx = SessionContext::new();
    let schema = Arc::new(Schema::new(vec![
        Field::new("a", DataType::Int64, false),
        Field::new("b", DataType::Utf8, false),
        Field::new("c", DataType::Int64, false),
    ]));
    let a = Int64Array::from(vec![1, 2, 3, 4, 5]);
    let b = StringArray::from(vec!["x", "x", "y", "y", "z"]);
    let c = Int64Array::from(vec![10, 20, 5, 30, 1]);
    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(a), Arc::new(b), Arc::new(c)]).unwrap();
    ctx.register_batches("small", schema, vec![batch]);

    let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, false), Field::new("g", DataType::Int64, false)]));
    let id = Int64Array::from_iter_values(0..10_000);
    let g = Int64Array::from_iter_values((0..10_000).map(|i| i % 10));
    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(id), Arc::new(g)]).unwrap();
    ctx.register_batches("big", schema, vec![batch]);
    ctx
}

fn q(sql: &str) -> String {
    rows_in(&ctx(), sql)
}

fn columns(sql: &str) -> Vec<String> {
    let (schema, _) = ctx().sql(sql).unwrap().collect().unwrap();
    schema.fields().iter().map(|f| f.name().clone()).collect()
}

fn err(sql: &str) -> String {
    match ctx().sql(sql) {
        Ok(f) => match f.collect() {
            Ok(_) => panic!("expected an error: {sql}"),
            Err(e) => e.to_string(),
        },
        Err(e) => e.to_string(),
    }
}

fn count(sql: &str) -> i64 {
    q(sql).parse().unwrap()
}

// ---- * REPLACE / RENAME ----------------------------------------------------

#[test]
fn replace_substitutes_in_place() {
    assert_eq!(q("select * replace (a * 10 as a) from small order by c"), "50,z,1|30,y,5|10,x,10|20,x,20|40,y,30");
    assert_eq!(columns("select * replace (a * 10 as a) from small"), ["a", "b", "c"]);
}

#[test]
fn replace_can_use_the_other_columns() {
    assert_eq!(q("select * replace (upper(b) || a as b) from small where a <= 2 order by a"), "1,X1,10|2,X2,20");
}

#[test]
fn rename_aliases_the_column() {
    assert_eq!(columns("select * rename (a as id, b as grp) from small"), ["id", "grp", "c"]);
    assert_eq!(columns("select * rename a as id from small"), ["id", "b", "c"]);
    assert_eq!(q("select * rename (a as id) from small order by id desc limit 2"), "5,z,1|4,y,30");
}

#[test]
fn exclude_with_replace_and_rename() {
    assert_eq!(q("select * exclude (b) replace (c + 1 as c) from small order by a"), "1,11|2,21|3,6|4,31|5,2");
    assert_eq!(columns("select * exclude (b) replace (c + 1 as c) rename (a as k) from small"), ["k", "c"]);
}

#[test]
fn qualified_wildcard_with_options() {
    let sql = "select s.* exclude (c) replace (s.a * 2 as a), o.k from small s join (select 2 as a, 'k2' as k) o on s.a = o.a";
    assert_eq!(q(sql), "4,x,k2");
    assert_eq!(q("select s.* replace (a * 2 as a) from small s where s.a = 3"), "6,y,5");
    assert_eq!(columns("select s.* rename (c as cc) from small s"), ["a", "b", "cc"]);
}

#[test]
fn wildcard_options_name_existing_columns() {
    for sql in [
        "select * replace (1 as zz) from small",
        "select * rename (zz as y) from small",
        "select * exclude (zz) from small",
        "select s.* replace (1 as zz) from small s",
    ] {
        assert!(err(sql).contains("zz"), "{sql}");
    }
}

#[test]
fn wildcard_ilike_is_rejected() {
    assert!(ctx().sql("select * ilike 'a%' from small").is_err());
}

// ---- TABLESAMPLE -----------------------------------------------------------

#[test]
fn sample_percent_keeps_about_that_share() {
    for sql in [
        "select count(*) from big tablesample bernoulli (10 percent)",
        "select count(*) from big tablesample system (10 percent)",
        "select count(*) from big tablesample (10)",
        "select count(*) from big b tablesample (10 percent)",
    ] {
        let n = count(sql);
        assert!((800..=1200).contains(&n), "{sql}: {n}");
    }
    assert_eq!(count("select count(*) from big tablesample (0 percent)"), 0);
    assert_eq!(count("select count(*) from big tablesample (100 percent)"), 10_000);
}

#[test]
fn sample_keeps_the_columns_and_the_alias() {
    assert_eq!(columns("select * from big b tablesample (50 percent)"), ["id", "g"]);
    assert!(count("select count(b.id) from big b tablesample (50 percent) where b.g = 3") > 0);
}

#[test]
fn sample_repeatable_is_deterministic() {
    let sql = |seed: u32| format!("select id from big tablesample bernoulli (10 percent) repeatable ({seed}) order by id");
    let first = q(&sql(7));
    assert_eq!(first, q(&sql(7)));
    assert_ne!(first, q(&sql(8)));
    let n = first.split('|').count();
    assert!((800..=1200).contains(&n), "{n}");
    assert_eq!(columns(&sql(7)), ["id"]);
}

#[test]
fn sample_rows_is_exact() {
    assert_eq!(count("select count(*) from big tablesample (25 rows)"), 25);
    assert_eq!(count("select count(*) from small tablesample (100 rows)"), 5);
    assert_eq!(count("select count(*) from small tablesample (0 rows)"), 0);
    let sql = "select id from big tablesample (25 rows) repeatable (3) order by id";
    assert_eq!(q(sql).split('|').count(), 25);
    assert_eq!(q(sql), q(sql));
    assert_eq!(columns(sql), ["id"]);
}

#[test]
fn sample_applies_to_subqueries() {
    let n = count("select count(*) from (select * from big where g = 1) tablesample (50 percent)");
    assert!((400..=600).contains(&n), "{n}");
}

#[test]
fn unsupported_samples_are_errors() {
    assert!(err("select * from big tablesample block (10 percent)").contains("table sample"));
    assert!(err("select * from big tablesample bernoulli (10 rows)").contains("table sample"));
    assert!(err("select * from big tablesample (bucket 1 out of 4)").contains("table sample"));
    assert!(err("select * from big tablesample (-1 rows)").contains("table sample"));
    assert!(err("select * from big tablesample (150 percent)").contains("percentage"));
}

// ---- AS OF -----------------------------------------------------------------

#[test]
fn time_travel_needs_a_delta_table() {
    for sql in [
        "select * from small version as of 3",
        "select * from small timestamp as of '2024-01-01'",
        "select * from small version as of 0 as s",
    ] {
        assert!(err(sql).contains("Delta"), "{sql}");
    }
}

// ---- DISTINCT ON -----------------------------------------------------------

#[test]
fn distinct_on_takes_the_first_by_order_by() {
    assert_eq!(q("select distinct on (b) b, a from small order by b, a desc"), "x,2|y,4|z,5");
    assert_eq!(q("select distinct on (b) b, a from small order by b, a"), "x,1|y,3|z,5");
    assert_eq!(q("select distinct on (b) b, c from small order by b, c desc"), "x,20|y,30|z,1");
}

#[test]
fn distinct_on_without_order_by_gives_one_row_per_key() {
    assert_eq!(q("select distinct on (b) b from small order by b"), "x|y|z");
    assert_eq!(count("select count(*) from (select distinct on (b) * from small)"), 3);
    assert_eq!(count("select count(*) from (select distinct on (g) * from big)"), 10);
}

#[test]
fn distinct_on_with_expression_keys() {
    assert_eq!(q("select distinct on (a % 2) a % 2 as p, a from small order by a % 2, a desc"), "0,4|1,5");
    // the key is not in the select list
    assert_eq!(q("select distinct on (a % 2) a from small order by a % 2, a desc"), "4|5");
    let sql = "select distinct on (upper(b), a > 3) b, a from small order by upper(b), a > 3, a";
    assert_eq!(q(sql), "x,1|y,3|y,4|z,5");
}

#[test]
fn distinct_on_then_a_different_final_order() {
    let sql = "select distinct on (b) b, a from small order by b, a desc";
    assert_eq!(q(&format!("select * from ({sql}) order by a desc")), "z,5|y,4|x,2");
    // ordinals and several keys
    assert_eq!(q("select distinct on (1) b, a from small order by 1 desc, a"), "z,5|y,3|x,1");
    assert_eq!(count("select count(*) from (select distinct on (g, id % 2) * from big)"), 10);
}

#[test]
fn distinct_on_after_grouping() {
    let sql = "select distinct on (b) b, sum(c) as s from small group by b order by b, s desc";
    assert_eq!(q(sql), "x,30|y,35|z,1");
}
