//! Groupings by keys of many columns, kept as encoded rows: every group's
//! count and sums match a reference counted apart, whether the groups are
//! few or almost one per row, the input is one batch or many, in memory or
//! from Parquet, and whatever the threads' tables merge into.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::*;
use arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use arrow::record_batch::RecordBatch;
use iara_core::SessionContext;
use iara_core::io::parquet::write_parquet;

use crate::support::dir::TempDir;

/// 3 strings, 4 64-bit integers, a float, a date and a short string: too wide for the
/// packed words. `spread` sets how many groups there are.
fn schema() -> SchemaRef {
    Arc::new(Schema::new(vec![
        Field::new("s1", DataType::Utf8, true),
        Field::new("i1", DataType::Int64, true),
        Field::new("s2", DataType::Utf8, true),
        Field::new("i2", DataType::Int64, false),
        Field::new("f", DataType::Float64, true),
        Field::new("i3", DataType::Int64, true),
        Field::new("s3", DataType::Utf8, true),
        Field::new("d", DataType::Date32, true),
        Field::new("i4", DataType::Int64, true),
        Field::new("v", DataType::Int64, false),
    ]))
}

/// A small generator of the same numbers on every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self, below: u64) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) % below
    }
}

fn data(rows: usize, spread: u64) -> RecordBatch {
    let mut r = Rng(11);
    let mut col = |below: u64| -> Vec<u64> { (0..rows).map(|_| r.next(below)).collect() };
    let (a, b, c, d, e, f, g, h, k, v) = (col(spread), col(7), col(spread), col(5), col(6), col(3), col(spread), col(4), col(9), col(1000));
    let text = |vals: &[u64], tag: &str, nulls: u64| -> ArrayRef {
        Arc::new(StringArray::from_iter(vals.iter().map(|&x| (x % nulls != 1).then(|| if x % 5 == 0 { String::new() } else { format!("{tag}{x}") }))))
    };
    let int = |vals: &[u64], nulls: u64| -> ArrayRef { Arc::new(Int64Array::from_iter(vals.iter().map(|&x| (x % nulls != 2).then_some(x as i64 - 3)))) };
    let floats: Float64Array = e.iter().map(|&x| match x {
        0 => Some(-0.0),
        1 => Some(0.0),
        2 => Some(f64::NAN),
        3 => None,
        x => Some(x as f64 * 0.25),
    }).collect();
    let columns: Vec<ArrayRef> = vec![
        text(&a, "a long enough value ", 13),
        int(&b, 6),
        text(&c, "c", 17),
        Arc::new(Int64Array::from_iter_values(d.iter().map(|&x| x as i64))),
        Arc::new(floats),
        int(&f, 7),
        text(&g, "g", 19),
        Arc::new(Date32Array::from_iter(h.iter().map(|&x| (x != 3).then_some(19_000 + x as i32)))),
        int(&k, 10),
        Arc::new(Int64Array::from_iter_values(v.iter().map(|&x| x as i64))),
    ];
    RecordBatch::try_new(schema(), columns).unwrap()
}

/// The key of row `i`, as the grouping compares keys: `-0.0` is `0.0`, NaN one value,
/// NULL apart from every value (the empty string included).
fn key(batch: &RecordBatch, i: usize) -> String {
    (0..9)
        .map(|c| {
            let a = batch.column(c);
            if a.is_null(i) {
                return "<null>".to_string();
            }
            match a.data_type() {
                DataType::Float64 => {
                    let x = a.as_primitive::<arrow::datatypes::Float64Type>().value(i);
                    if x.is_nan() { "NaN".into() } else { format!("{}", if x == 0.0 { 0.0 } else { x }) }
                }
                _ => arrow::util::display::array_value_to_string(a, i).unwrap(),
            }
        })
        .collect::<Vec<_>>()
        .join("|")
}

const KEYS: &str = "s1, i1, s2, i2, f, i3, s3, d, i4";

/// (count, sum of v, max of v) of each key, by the engine.
fn grouped(ctx: &SessionContext, table: &str, filter: &str) -> HashMap<String, (i64, i64, i64)> {
    let sql = format!("select {KEYS}, count(*) as n, sum(v) as sv, max(v) as mv from {table} {filter} group by {KEYS}");
    let (_, batches) = ctx.sql(&sql).unwrap().collect().unwrap();
    let mut out = HashMap::new();
    for b in &batches {
        let n = |c: usize, i: usize| b.column(c).as_primitive::<arrow::datatypes::Int64Type>().value(i);
        for i in 0..b.num_rows() {
            let previous = out.insert(key(b, i), (n(9, i), n(10, i), n(11, i)));
            assert!(previous.is_none(), "a key in two groups: {}", key(b, i));
        }
    }
    out
}

/// The same, counted row by row (`keep`: the rows the filter passes).
fn reference(batch: &RecordBatch, keep: impl Fn(i64) -> bool) -> HashMap<String, (i64, i64, i64)> {
    let v = batch.column(9).as_primitive::<arrow::datatypes::Int64Type>();
    let mut out: HashMap<String, (i64, i64, i64)> = HashMap::new();
    for i in 0..batch.num_rows() {
        if !keep(v.value(i)) {
            continue;
        }
        let e = out.entry(key(batch, i)).or_insert((0, 0, i64::MIN));
        e.0 += 1;
        e.1 += v.value(i);
        e.2 = e.2.max(v.value(i));
    }
    out
}

fn check(rows: usize, spread: u64) {
    let batch = data(rows, spread);
    let want = reference(&batch, |_| true);
    let want_filtered = reference(&batch, |v| v >= 300);
    let dir = TempDir::new("group-rows");
    let file = dir.join("t.parquet");
    write_parquet(&file, schema(), std::slice::from_ref(&batch), "zstd", Some(16_384)).unwrap();
    let ctx = SessionContext::new();
    // one batch, and many small ones
    ctx.register_batches("one", schema(), vec![batch.clone()]).unwrap();
    let pieces: Vec<RecordBatch> = (0..rows).step_by(3_000).map(|s| batch.slice(s, 3_000.min(rows - s))).collect();
    ctx.register_batches("many", schema(), pieces).unwrap();
    ctx.register_parquet("pq", &file).unwrap();
    for table in ["one", "many", "pq"] {
        let got = grouped(&ctx, table, "");
        assert_eq!(got.len(), want.len(), "{table}: groups");
        assert!(got == want, "{table}: counts and sums differ");
        assert!(grouped(&ctx, table, "where v >= 300") == want_filtered, "{table}: filtered");
    }
}

#[test]
fn few_groups() {
    check(60_000, 3);
}

#[test]
fn some_groups_per_thread() {
    check(120_000, 40);
}

#[test]
fn almost_a_group_per_row() {
    // past the size where threads' tables are merged by partition, and where a thread's
    // table moves to partitioned rows
    check(300_000, 400);
}
