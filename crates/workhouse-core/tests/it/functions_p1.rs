//! P1 scalar functions through SQL. Expected values are what DuckDB returns
//! (the Python test file checks them against DuckDB itself).

use std::sync::Arc;

use arrow::array::{ArrayRef, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use arrow::util::display::array_value_to_string;
use workhouse_core::SessionContext;

fn ctx() -> SessionContext {
    let ctx = SessionContext::new();
    let schema = Arc::new(Schema::new(vec![
        Field::new("s", DataType::Utf8, true),
        Field::new("n", DataType::Int64, true),
        Field::new("f", DataType::Float64, true),
    ]));
    let cols: Vec<ArrayRef> = vec![
        Arc::new(StringArray::from(vec![Some("abc"), None, Some("héllo wörld"), Some(""), Some("a1b22")])),
        Arc::new(Int64Array::from(vec![Some(5), None, Some(-3), Some(0), Some(5)])),
        Arc::new(Float64Array::from(vec![Some(1.5), None, Some(f64::NAN), Some(-2.0), Some(0.0)])),
    ];
    ctx.register_batches("t", schema.clone(), vec![RecordBatch::try_new(schema, cols).unwrap()]);
    ctx
}

/// First column of every row, `|`-joined, NULL as "null".
fn col(sql: &str) -> String {
    let (_, batches) = ctx().sql(sql).unwrap().collect().unwrap();
    let mut out = vec![];
    for b in &batches {
        for i in 0..b.num_rows() {
            out.push(if b.column(0).is_null(i) { "null".into() } else { array_value_to_string(b.column(0), i).unwrap() });
        }
    }
    out.join("|")
}

fn one(expr: &str) -> String {
    col(&format!("SELECT {expr}"))
}

#[test]
fn math() {
    assert_eq!(col("SELECT sign(n) FROM t"), "1|null|-1|0|1");
    assert_eq!(col("SELECT sign(f) FROM t"), "1.0|null|NaN|-1.0|0.0");
    assert_eq!(col("SELECT isnan(f) FROM t"), "false|null|true|false|false");
    assert_eq!(col("SELECT mod(n, 3) FROM t"), "2|null|0|0|2");
    assert_eq!(col("SELECT n % 3 FROM t"), "2|null|0|0|2");
    assert_eq!(col("SELECT clip(n, -1, 3) FROM t"), "3|null|-1|0|3");
    assert_eq!(one("sign(0)"), "0");
}

#[test]
fn null_safe_equality() {
    assert_eq!(col("SELECT n IS NOT DISTINCT FROM 5 FROM t"), "true|false|false|false|true");
    assert_eq!(col("SELECT n <=> NULL FROM t"), "false|true|false|false|false");
    assert_eq!(col("SELECT n IS DISTINCT FROM 5 FROM t"), "false|true|true|true|false");
    assert_eq!(one("equal_null(NULL, NULL)"), "true");
    assert_eq!(one("NULL IS NOT DISTINCT FROM 1"), "false");
}

#[test]
fn dates() {
    assert_eq!(one("date_add(DATE '2024-02-28', 2)"), "2024-03-01");
    assert_eq!(one("date_sub(DATE '2024-03-01', 1)"), "2024-02-29");
    assert_eq!(one("datediff(DATE '2024-03-01', DATE '2024-02-01')"), "29");
    assert_eq!(one("datediff('month', DATE '2024-01-31', DATE '2024-03-01')"), "2");
    assert_eq!(one("add_months(DATE '2024-01-31', 1)"), "2024-02-29");
    assert_eq!(one("add_months(DATE '2024-03-31', -1)"), "2024-02-29");
    assert_eq!(one("last_day(DATE '2023-02-10')"), "2023-02-28");
    assert_eq!(one("last_day(DATE '2024-02-10')"), "2024-02-29");
    assert_eq!(one("make_date(2024, 2, 29)"), "2024-02-29");
    assert_eq!(one("make_date(2023, 2, 29)"), "null");
    assert_eq!(one("date_add(NULL, 1)"), "null");
}

#[test]
fn parse_and_format() {
    assert_eq!(one("to_date('2024-03-05', '%Y-%m-%d')"), "2024-03-05");
    assert_eq!(one("to_date('05/03/2024', 'dd/MM/yyyy')"), "2024-03-05");
    assert_eq!(one("to_date('nope', '%Y-%m-%d')"), "null");
    assert_eq!(one("to_timestamp('2024-03-05 10:20:30', '%Y-%m-%d %H:%M:%S')"), "2024-03-05T10:20:30");
    assert_eq!(one("strftime(TIMESTAMP '2024-03-05 10:20:30', '%Y/%m/%d %H-%M')"), "2024/03/05 10-20");
    assert_eq!(one("date_format(DATE '2024-02-29', 'yyyy-MM')"), "2024-02");
}

#[test]
fn strings() {
    assert_eq!(col("SELECT lpad(s, 6, '*') FROM t"), "***abc|null|héllo |******|a1b22*".replace("a1b22*", "*a1b22"));
    assert_eq!(col("SELECT rpad(s, 6, 'xy') FROM t"), "abcxyx|null|héllo |xyxyxy|a1b22x");
    assert_eq!(one("zfill('-42', 6)"), "-00042");
    assert_eq!(one("split_part('a,b,c', ',', 2)"), "b");
    assert_eq!(one("split_part('a,b,c', ',', -1)"), "c");
    assert_eq!(one("split_part('a,b,c', ',', 9)"), "");
    assert_eq!(one("concat_ws('-', 'a', NULL, 'c')"), "a-c");
    assert_eq!(one("concat_ws(NULL, 'a')"), "null");
    assert_eq!(col("SELECT initcap(s) FROM t"), "Abc|null|Héllo Wörld||A1b22");
    assert_eq!(one("repeat('ab', 3)"), "ababab");
    assert_eq!(one("repeat('ab', 0)"), "");
}

#[test]
fn regex() {
    assert_eq!(col("SELECT regexp_like(s, '^a') FROM t"), "true|null|false|false|true");
    assert_eq!(col("SELECT regexp_count(s, '[0-9]+') FROM t"), "0|null|0|0|2");
    assert_eq!(one("regexp_replace('a1b22', '[0-9]+', '#')"), "a#b22");
    assert_eq!(one("regexp_replace('a1b22', '[0-9]+', '#', 'g')"), "a#b#");
    assert_eq!(one(r"regexp_replace('ab', '(a)(b)', '\2\1')"), "ba");
    assert_eq!(one("regexp_extract('a1b22', '([a-z])([0-9]+)', 2)"), "1");
    assert_eq!(one("regexp_extract('xyz', '[0-9]+')"), "");
    assert_eq!(col("SELECT s RLIKE 'o w' FROM t"), "false|null|true|false|false");
    assert!(ctx().sql("SELECT regexp_like(s, '(') FROM t").and_then(|l| l.collect()).is_err());
}
