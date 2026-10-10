//! Writing and reading datasets: Hive-partitioned Parquet (local and on an
//! object store), and the SQL statements that write (COPY, CREATE TABLE AS,
//! INSERT, DROP TABLE).

use std::sync::Arc;

use arrow::array::{ArrayRef, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use arrow::util::pretty::pretty_format_batches;
use workhouse_core::SessionContext;

fn sales(ctx: &SessionContext) {
    let n = 2_000i64;
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("year", DataType::Int64, false),
        Field::new("region", DataType::Utf8, true),
        Field::new("amount", DataType::Float64, false),
    ]));
    let ids: Vec<i64> = (0..n).collect();
    let regions = ["north", "south", "east/west"];
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(ids.clone())),
        Arc::new(Int64Array::from(ids.iter().map(|i| 2020 + i % 4).collect::<Vec<_>>())),
        Arc::new(StringArray::from(ids.iter().map(|i| if i % 11 == 0 { None } else { Some(regions[(*i % 3) as usize]) }).collect::<Vec<_>>())),
        Arc::new(Float64Array::from(ids.iter().map(|i| (*i % 100) as f64).collect::<Vec<_>>())),
    ];
    ctx.register_batches("sales", schema.clone(), vec![RecordBatch::try_new(schema, cols).unwrap()]);
}

fn run(ctx: &SessionContext, q: &str) -> String {
    let (_, batches) = ctx.sql(q).unwrap().collect().unwrap();
    pretty_format_batches(&batches).unwrap().to_string()
}

/// The error of a statement that must fail.
fn error(ctx: &SessionContext, q: &str) -> String {
    match ctx.sql(q) {
        Ok(_) => panic!("{q} should fail"),
        Err(e) => e.to_string(),
    }
}

fn scalar(ctx: &SessionContext, q: &str) -> String {
    let (_, batches) = ctx.sql(q).unwrap().collect().unwrap();
    arrow::util::display::array_value_to_string(batches[0].column(0), 0).unwrap()
}

struct Dir(std::path::PathBuf);

impl Dir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("wh-datasets-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Self(p)
    }
    fn join(&self, name: &str) -> String {
        self.0.join(name).to_str().unwrap().replace('\\', "/")
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

const CHECK: &str = "select year, region, count(*) as n, sum(amount) as total from t group by 1, 2 order by 1, 2";

fn copy_and_read_back(ctx: &SessionContext, out: &str) {
    let expected = run(ctx, &CHECK.replace(" t ", " sales "));
    let done = run(ctx, &format!("COPY (select * from sales) TO '{out}' (FORMAT parquet, PARTITION_BY (year, region))"));
    assert!(done.contains("| copy") && done.contains("2000"), "{done}");
    ctx.register_parquet("t", out).unwrap();
    // the partition columns come back (after the files' columns), with their values
    assert_eq!(run(ctx, CHECK), expected);
    let plan = ctx.sql("select sum(amount) from t where year = 2021 and region = 'south'").unwrap().explain(true).unwrap();
    assert!(plan.contains("partitions=1/16"), "{plan}");
    assert_eq!(scalar(ctx, "select count(*) from t where region is null"), "182");
    assert_eq!(scalar(ctx, "select count(distinct region) from t where region like 'east%'"), "1");
}

#[test]
fn partitioned_copy_reads_back_with_pruning() {
    let dir = Dir::new("copy");
    let ctx = SessionContext::new();
    sales(&ctx);
    copy_and_read_back(&ctx, &dir.join("out"));
    // a second copy into a folder with data needs OVERWRITE
    let again = error(&ctx, &format!("copy (select * from sales) to '{}' (partition_by (year))", dir.join("out")));
    assert!(again.contains("OVERWRITE"), "{again}");
}

#[test]
fn partitioned_copy_to_an_object_store() {
    let ctx = SessionContext::new();
    sales(&ctx);
    copy_and_read_back(&ctx, "memory://datasets-test/sales/");
}

#[test]
fn tables_created_in_a_warehouse_take_inserts() {
    let dir = Dir::new("warehouse");
    let ctx = SessionContext::new();
    sales(&ctx);
    ctx.set_warehouse(Some(&dir.join("wh")), &Default::default());

    let created = run(&ctx, "create table recent partitioned by (year) as select id, year, amount from sales where year >= 2022");
    assert!(created.contains("1000"), "{created}");
    assert!(std::path::Path::new(&dir.join("wh/recent/year=2023")).is_dir());
    assert_eq!(scalar(&ctx, "select count(*) from recent where year = 2023"), "500");

    // new rows land in their partitions (a new one too); the column list fills the rest with nulls
    run(&ctx, "insert into recent (id, year) select id, 2024 from sales where id < 10");
    // as in Hive, partition columns come last: (id, amount, year)
    run(&ctx, "insert into recent select id, amount, year from sales where year = 2022 and id < 100");
    assert_eq!(scalar(&ctx, "select count(*) from recent where year = 2024 and amount is null"), "10");
    assert_eq!(scalar(&ctx, "select count(*) from recent where year = 2022"), "525");

    // an existing table is kept unless replaced
    let err = error(&ctx, "create table recent as select 1 as x");
    assert!(err.contains("already exists"), "{err}");
    assert!(run(&ctx, "create table if not exists recent as select 1 as x").contains("| 0"));
    run(&ctx, "create or replace table recent as select id from sales where id < 3");
    assert_eq!(scalar(&ctx, "select count(*) from recent"), "3");
    assert!(!std::path::Path::new(&dir.join("wh/recent/year=2023")).exists(), "replaced data is gone");

    run(&ctx, "drop table recent");
    assert!(ctx.sql("select * from recent").is_err());
    // its files stay: a new table over them needs REPLACE
    assert!(error(&ctx, "create table recent as select 1 as x").contains("already holds data"));
}

#[test]
fn tables_without_a_warehouse_live_in_memory() {
    let ctx = SessionContext::new();
    sales(&ctx);
    run(&ctx, "create table small as select id, region from sales where id < 5");
    run(&ctx, "insert into small (region, id) values ('x', 100)");
    assert_eq!(scalar(&ctx, "select count(*) from small"), "6");
    assert_eq!(scalar(&ctx, "select region from small where id = 100"), "x");
    assert!(error(&ctx, "create table p partitioned by (region) as select * from sales").contains("warehouse"));
    assert!(ctx.sql("drop table nope").is_err());
    run(&ctx, "drop table if exists nope");
}

#[test]
fn copy_writes_csv_too() {
    let dir = Dir::new("csv");
    let ctx = SessionContext::new();
    sales(&ctx);
    let out = dir.join("few.csv");
    run(&ctx, &format!("copy (select id, region from sales where id < 3 order by id) to '{out}' (header false, delimiter ';')"));
    let text = std::fs::read_to_string(&out).unwrap();
    assert_eq!(text.lines().collect::<Vec<_>>(), vec!["0;", "1;south", "2;east/west"]);
}
