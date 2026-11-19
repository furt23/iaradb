//! A group by on many keys over a small table, in memory and from one Parquet file:
//! how long the query takes once warm.
//!
//! ```text
//! cargo run --release -p iara-core --example small_group_by -- [rows] [distinct values per key, comma separated]
//! ```

use std::sync::Arc;
use std::time::Instant;

use arrow::array::{ArrayRef, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use iara_core::SessionContext;
use iara_core::io::memory::MemTable;
use iara_core::io::parquet::write_parquet;

/// A small generator of the same numbers on every run.
struct Rng(u64);

impl Rng {
    fn next(&mut self, below: u64) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) % below
    }
}

fn main() {
    let rows: usize = std::env::args().nth(1).and_then(|v| v.parse().ok()).unwrap_or(100_000);
    let cards: Vec<u64> = std::env::args().nth(2).unwrap_or_else(|| "3,4,5,2,7,3,6,2,4,5,3,2".into()).split(',').filter_map(|c| c.parse().ok()).collect();
    let mut rng = Rng(7);
    let mut fields = vec![];
    let mut columns: Vec<ArrayRef> = vec![];
    for (i, &card) in cards.iter().enumerate() {
        let values: Vec<u64> = (0..rows).map(|_| rng.next(card)).collect();
        if i % 2 == 0 {
            fields.push(Field::new(format!("k{i}"), DataType::Utf8, true));
            columns.push(Arc::new(StringArray::from_iter_values(values.iter().map(|v| format!("key{i}_{v}")))));
        } else {
            fields.push(Field::new(format!("k{i}"), DataType::Int64, true));
            columns.push(Arc::new(Int64Array::from_iter_values(values.iter().map(|&v| v as i64))));
        }
    }
    fields.push(Field::new("x", DataType::Float64, true));
    columns.push(Arc::new(Float64Array::from_iter_values((0..rows).map(|_| rng.next(1_000_000) as f64 / 1e4))));
    fields.push(Field::new("y", DataType::Int64, true));
    columns.push(Arc::new(Int64Array::from_iter_values((0..rows).map(|_| rng.next(1000) as i64))));
    let schema = Arc::new(Schema::new(fields));
    let batch = RecordBatch::try_new(schema.clone(), columns).expect("a batch");

    let dir = std::env::temp_dir().join(format!("iara-small-group-by-{}", std::process::id()));
    std::fs::create_dir_all(&dir).expect("a folder");
    let file = dir.join("t.parquet").display().to_string();
    write_parquet(&file, schema.clone(), std::slice::from_ref(&batch), "zstd", None).expect("a file");
    let ctx = SessionContext::new();
    ctx.register_table("mem", Arc::new(MemTable::new(schema, vec![batch]))).expect("registered");
    ctx.register_parquet("pq", &file).expect("registered");

    let keys: Vec<String> = (0..cards.len()).map(|i| format!("k{i}")).collect();
    let run = |sql: &str| {
        let mut best = f64::MAX;
        let mut groups = 0;
        for _ in 0..25 {
            let started = Instant::now();
            let (_, batches) = ctx.sql(sql).and_then(|lf| lf.collect()).expect("a result");
            best = best.min(started.elapsed().as_secs_f64() * 1000.0);
            groups = batches.iter().map(|b| b.num_rows()).sum();
        }
        (best, groups)
    };
    println!("{rows} rows, {} threads", rayon::current_num_threads());
    // `IARA_ONLY=mem:12` runs one case (for a profiler)
    let only = std::env::var("IARA_ONLY").ok();
    let wanted = |table: &str, n: usize| only.as_deref().is_none_or(|o| o == format!("{table}:{n}"));
    for n in [keys.len(), 3.min(keys.len()), 1] {
        let by = keys[..n].join(", ");
        for table in ["mem", "pq"] {
            for (what, filter) in [("group by", ""), ("filter, group by", " where y > 100")] {
                if !wanted(table, n) || (only.is_some() && !filter.is_empty()) {
                    continue;
                }
                let sql = format!("select {by}, sum(x) as sx, avg(x) as ax, count(*) as n, min(y) as mn, max(y) as mx from {table}{filter} group by {by}");
                let (ms, groups) = run(&sql);
                println!("{n:>2} keys  {table:<3} {what:<17} {ms:8.2} ms  {groups} groups");
            }
        }
    }
    for table in ["mem", "pq"] {
        if only.is_some() {
            continue;
        }
        let (ms, n) = run(&format!("select k0, k1, x, y from {table} where y > 500 order by x desc"));
        println!("         {table:<3} filter, order by   {ms:8.2} ms  {n} rows");
    }
    let _ = std::fs::remove_dir_all(&dir);
}
