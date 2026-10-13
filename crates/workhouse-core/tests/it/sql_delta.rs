//! Delta as the default table format: CREATE TABLE (AS), INSERT [OVERWRITE],
//! TRUNCATE, time travel, views, SHOW / DESCRIBE, DROP of managed and external tables.

use std::sync::Arc;

use arrow::array::Int64Array;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use workhouse_core::delta::is_delta_table;
use workhouse_core::io::StorageOptions;
use workhouse_core::{Params, Scalar, SessionContext};

use crate::support::dir::TempDir;

fn run(ctx: &SessionContext, q: &str) -> String {
    let (_, batches) = ctx.sql(q).unwrap().collect().unwrap();
    arrow::util::pretty::pretty_format_batches(&batches).unwrap().to_string()
}

fn error(ctx: &SessionContext, q: &str) -> String {
    match ctx.sql(q).and_then(|f| f.collect()) {
        Ok(_) => panic!("{q} should fail"),
        Err(e) => e.to_string(),
    }
}

fn scalar(ctx: &SessionContext, q: &str) -> String {
    let (_, batches) = ctx.sql(q).unwrap().collect().unwrap();
    arrow::util::display::array_value_to_string(batches[0].column(0), 0).unwrap()
}

fn source(ctx: &SessionContext) {
    let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, false), Field::new("year", DataType::Int64, false)]));
    let ids: Vec<i64> = (0..10).collect();
    let years: Vec<i64> = ids.iter().map(|i| 2020 + i % 2).collect();
    let b = RecordBatch::try_new(schema.clone(), vec![Arc::new(Int64Array::from(ids)), Arc::new(Int64Array::from(years))]).unwrap();
    ctx.register_batches("src", schema, vec![b]);
}

fn warehouse() -> (TempDir, SessionContext) {
    let dir = TempDir::new("sqld");
    let ctx = SessionContext::new();
    source(&ctx);
    ctx.set_warehouse(Some(&dir.join("wh")), &Default::default());
    (dir, ctx)
}

fn is_delta(path: &str) -> bool {
    is_delta_table(path, &StorageOptions::new())
}

#[test]
fn create_table_as_is_delta_by_default() {
    let (dir, ctx) = warehouse();
    run(&ctx, "create table t as select * from src");
    assert!(is_delta(&dir.join("wh/t")));
    assert_eq!(scalar(&ctx, "select count(*) from t"), "10");
    assert!(error(&ctx, "create table t as select 1 as x").contains("already exists"));
    run(&ctx, "create table if not exists t as select 1 as x");

    // append (atomic) and the registered table sees the new version
    let out = run(&ctx, "insert into t select id + 100, year from src where id < 3");
    assert!(out.contains("delta"), "{out}");
    assert_eq!(scalar(&ctx, "select count(*) from t"), "13");
    run(&ctx, "insert into t (year, id) select 1999, 7");
    assert_eq!(scalar(&ctx, "select id from t where year = 1999"), "7");

    // overwrite
    run(&ctx, "insert overwrite table t select * from src where id < 4");
    assert_eq!(scalar(&ctx, "select count(*) from t"), "4");
    run(&ctx, "insert overwrite t select * from src where id < 2");
    assert_eq!(scalar(&ctx, "select count(*) from t"), "2");

    // replace keeps the history
    run(&ctx, "create or replace table t as select id from src where id < 6");
    assert_eq!(scalar(&ctx, "select count(*) from t"), "6");
    assert_eq!(scalar(&ctx, "select count(*) from t version as of 0"), "10");

    // a column the table lacks, or the wrong number of columns
    assert!(error(&ctx, "insert into t (nope) select 1").contains("no column"));
    assert!(error(&ctx, "insert into t select 1, 2").contains("columns"));
}

#[test]
fn partitioned_delta_tables() {
    let (dir, ctx) = warehouse();
    run(&ctx, "create table p partitioned by (year) as select * from src");
    assert!(std::path::Path::new(&dir.join("wh/p/year=2020")).is_dir());
    run(&ctx, "insert into p select id + 50, 2022 from src where id < 2");
    assert_eq!(scalar(&ctx, "select count(*) from p where year = 2022"), "2");
    let d = run(&ctx, "describe p");
    assert!(d.contains("is_partition"), "{d}");
    let year_row = d.lines().find(|l| l.contains("| year")).unwrap();
    assert!(year_row.contains("true"), "{d}");
}

#[test]
fn create_table_with_columns_and_not_null() {
    let (dir, ctx) = warehouse();
    run(&ctx, "create table c (id bigint not null, name varchar(20), amount decimal(10,2), at timestamp) comment 'orders'");
    assert!(is_delta(&dir.join("wh/c")));
    assert_eq!(scalar(&ctx, "select count(*) from c"), "0");
    let d = run(&ctx, "describe c");
    assert!(d.contains("id") && d.contains("Decimal128(10, 2)"), "{d}");
    let id_row = d.lines().find(|l| l.contains("| id")).unwrap();
    assert!(id_row.contains("false"), "{d}");
    run(&ctx, "insert into c (id, name) select id, 'x' from src where id < 3");
    assert_eq!(scalar(&ctx, "select count(*) from c"), "3");
    // NULL into a NOT NULL column
    let e = error(&ctx, "insert into c (id, name) select null, 'x'");
    assert!(e.contains("NOT NULL"), "{e}");
    let e = error(&ctx, "insert into c (name) select 'y'");
    assert!(e.contains("id"), "{e}");
    assert_eq!(scalar(&ctx, "select count(*) from c"), "3");
    let e = error(&ctx, "insert overwrite c (id, name) select null, 'x'");
    assert!(e.contains("NOT NULL"), "{e}");
    assert_eq!(scalar(&ctx, "select count(*) from c"), "3");
    // replacing with a new declaration keeps NOT NULL
    run(&ctx, "create or replace table c (k int not null, v text)");
    assert_eq!(scalar(&ctx, "select count(*) from c"), "0");
    assert!(error(&ctx, "insert into c (k, v) select null, 'x'").contains("NOT NULL"));
    assert!(ctx.sql("create table bad (a int primary key)").err().unwrap().to_string().contains("only NOT NULL"));
    assert!(ctx.sql("create table dup (a int, A int)").err().unwrap().to_string().contains("twice"));
    run(&ctx, "create table part (a int, b text, c int) partitioned by (b) using delta");
    assert!(is_delta(&dir.join("wh/part")));
}

#[test]
fn time_travel() {
    let (_dir, ctx) = warehouse();
    run(&ctx, "create table t as select * from src");
    run(&ctx, "insert into t select id + 10, year from src");
    run(&ctx, "insert into t select id + 20, year from src");
    assert_eq!(scalar(&ctx, "select count(*) from t version as of 0"), "10");
    assert_eq!(scalar(&ctx, "select count(*) from t version as of 1"), "20");
    assert_eq!(scalar(&ctx, "select count(*) from t version as of 1 as x where x.id < 5"), "5");
    assert_eq!(scalar(&ctx, "select count(*) from t timestamp as of '2999-01-01 00:00:00'"), "30");
    assert!(error(&ctx, "select * from t timestamp as of '2000-01-01 00:00:00'").contains("before the first"));
    assert!(!error(&ctx, "select * from t version as of 99").is_empty());
    // parameters
    let (_, b) = ctx.sql_with("select count(*) from t version as of $1", &Params::Positional(vec![Scalar::int64(1)])).unwrap().collect().unwrap();
    assert_eq!(arrow::util::display::array_value_to_string(b[0].column(0), 0).unwrap(), "20");
    // not a Delta table
    run(&ctx, "create table old using parquet as select * from src");
    assert!(error(&ctx, "select * from old version as of 0").contains("needs a Delta table"));
    // read_delta
    let p = format!("{}/t", ctx.warehouse().unwrap().0);
    assert_eq!(scalar(&ctx, &format!("select count(*) from read_delta('{p}')")), "30");
    assert_eq!(scalar(&ctx, &format!("select count(*) from read_delta('{p}', version => 0)")), "10");
}

#[test]
fn truncate_tables() {
    let (dir, ctx) = warehouse();
    run(&ctx, "create table t as select * from src");
    run(&ctx, "truncate table t");
    assert_eq!(scalar(&ctx, "select count(*) from t"), "0");
    assert_eq!(scalar(&ctx, "select count(*) from t version as of 0"), "10");
    run(&ctx, "insert into t select * from src where id < 2");
    assert_eq!(scalar(&ctx, "select count(*) from t"), "2");

    run(&ctx, "create table pq using parquet as select * from src");
    run(&ctx, "truncate pq");
    assert_eq!(scalar(&ctx, "select count(*) from pq"), "0");
    run(&ctx, "insert into pq select * from src where id < 3");
    assert_eq!(scalar(&ctx, "select count(*) from pq"), "3");
    assert!(!is_delta(&dir.join("wh/pq")));

    assert!(error(&ctx, "truncate nope").contains("not found"));
}

#[test]
fn views() {
    let (_dir, ctx) = warehouse();
    run(&ctx, "create table t as select * from src");
    let out = run(&ctx, "create view small as select id from t where id < 3");
    assert!(out.contains("view"), "{out}");
    assert_eq!(scalar(&ctx, "select count(*) from small"), "3");
    assert!(error(&ctx, "create view small as select 1").contains("already exists"));
    run(&ctx, "create or replace temp view small as select id from t where id < 5");
    assert_eq!(scalar(&ctx, "select count(*) from small"), "5");
    assert!(error(&ctx, "create or replace view t as select 1").contains("is a table"));
    assert!(error(&ctx, "drop view t").contains("not a view"));
    let t = run(&ctx, "show tables");
    assert!(t.contains("small") && t.contains("view"), "{t}");
    run(&ctx, "drop view small");
    assert!(ctx.sql("select * from small").is_err());
    run(&ctx, "drop view if exists small");
    assert!(error(&ctx, "drop view small").contains("not found"));
}

#[test]
fn show_and_describe() {
    let (_dir, ctx) = warehouse();
    run(&ctx, "create schema s");
    run(&ctx, "create table t as select * from src");
    run(&ctx, "create table s.u as select id from src");
    let all = run(&ctx, "show tables");
    assert!(all.contains("| t ") && all.contains("delta") && !all.contains("| u "), "{all}");
    let s = run(&ctx, "show tables in s");
    assert!(s.contains("| u ") && s.contains("delta"), "{s}");
    let schemas = run(&ctx, "show schemas");
    assert!(schemas.contains("main") && schemas.contains("| s "), "{schemas}");
    let c = run(&ctx, "show columns from t");
    assert!(c.contains("column_name") && c.contains("Int64"), "{c}");
    assert_eq!(run(&ctx, "describe table t"), c);
    assert!(error(&ctx, "describe nope").contains("not found"));
    assert!(error(&ctx, "show tables in nope").contains("does not exist"));
}

#[test]
fn drop_managed_and_external_tables() {
    let (dir, ctx) = warehouse();
    run(&ctx, "create table m as select * from src");
    let managed = dir.join("wh/m");
    assert!(is_delta(&managed));
    run(&ctx, "drop table m");
    assert!(!std::path::Path::new(&managed).exists(), "a managed table folder is deleted");

    // an external table: registered from a path outside the warehouse
    let ext = dir.join("external/e");
    run(&ctx, "create table tmp as select * from src");
    let tmp_path = dir.join("wh/tmp");
    let lf = ctx.sql("select * from src").unwrap();
    workhouse_core::delta::write_table(&lf, &ext, &StorageOptions::new(), workhouse_core::delta::WriteMode::Create, &[], false).unwrap();
    ctx.register_table_at("e", &ext, &StorageOptions::new(), true).unwrap();
    assert_eq!(scalar(&ctx, "select count(*) from e"), "10");
    run(&ctx, "drop table e");
    assert!(is_delta(&ext), "an external table keeps its data");
    assert!(ctx.sql("select * from e").is_err());

    // only the table at the folder of its own name is managed
    ctx.register_table_at("alias", &tmp_path, &StorageOptions::new(), false).unwrap();
    run(&ctx, "drop table alias");
    assert!(is_delta(&tmp_path), "the folder belongs to tmp, not to alias");
    run(&ctx, "drop table tmp");
    assert!(!std::path::Path::new(&tmp_path).exists());
}

#[test]
fn legacy_parquet_tables_are_unchanged() {
    let (dir, ctx) = warehouse();
    run(&ctx, "create table pq using parquet as select * from src");
    let path = dir.join("wh/pq");
    assert!(!is_delta(&path));
    run(&ctx, "insert into pq select id + 100, year from src where id < 2");
    assert_eq!(scalar(&ctx, "select count(*) from pq"), "12");
    assert!(std::fs::read_dir(&path).unwrap().count() >= 2, "appended files, not a log");
    run(&ctx, "insert overwrite pq select * from src where id < 4");
    assert_eq!(scalar(&ctx, "select count(*) from pq"), "4");
    assert!(error(&ctx, "create table pq using delta as select 1 as x").contains("already exists"));
    // a registered Parquet folder is read as Parquet, and DROP leaves its files
    run(&ctx, "drop table pq");
    assert!(std::path::Path::new(&path).is_dir());
    ctx.register_table_at("pq2", &path, &StorageOptions::new(), false).unwrap();
    assert_eq!(scalar(&ctx, "select count(*) from pq2"), "4");
    // replacing a legacy table without USING makes it a Delta table
    run(&ctx, "create or replace table pq2 as select * from src");
    assert_eq!(scalar(&ctx, "select count(*) from pq2"), "10");
    // a Delta folder is found by register_table_at
    run(&ctx, "create table d as select * from src");
    ctx.register_table_at("d2", &dir.join("wh/d"), &StorageOptions::new(), true).unwrap();
    assert_eq!(scalar(&ctx, "select count(*) from d2 version as of 0"), "10");
    assert!(ctx.sql("create table x using csv as select 1 as a").err().unwrap().to_string().contains("unknown table format"));
}

#[test]
fn memory_tables_without_a_warehouse() {
    let ctx = SessionContext::new();
    source(&ctx);
    run(&ctx, "create table m (a int, b text)");
    run(&ctx, "insert into m values (1, 'x')");
    run(&ctx, "insert overwrite m values (2, 'y')");
    assert_eq!(scalar(&ctx, "select a from m"), "2");
    assert!(error(&ctx, "create table z (a int) using delta").contains("needs a warehouse"));
    run(&ctx, "truncate table m");
    assert_eq!(scalar(&ctx, "select count(*) from m"), "0");
}
