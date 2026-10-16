//! Schemas in the catalog: `schema.table` names, the current schema (`USE`),
//! `CREATE SCHEMA` / `DROP SCHEMA`, and the statements that write with
//! qualified names.

use std::path::Path;
use std::sync::Arc;

use arrow::array::Int64Array;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use arrow::util::pretty::pretty_format_batches;
use iara_core::SessionContext;

/// A table `name` with one column `v` holding `values`.
fn table(ctx: &SessionContext, name: &str, values: &[i64]) {
    let schema = Arc::new(Schema::new(vec![Field::new("v", DataType::Int64, false)]));
    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(Int64Array::from(values.to_vec()))]).unwrap();
    ctx.register_batches(name, schema, vec![batch]);
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

/// A fresh temporary folder, removed on drop.
struct Dir(std::path::PathBuf);

impl Dir {
    fn new(tag: &str) -> Self {
        let p = std::env::temp_dir().join(format!("wh-schemas-{tag}-{}", std::process::id()));
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

#[test]
fn qualified_tables_register_and_select() {
    let ctx = SessionContext::new();
    table(&ctx, "orders", &[1, 2]);
    table(&ctx, "TPCH.LineItem", &[10, 20, 30]);
    assert_eq!(ctx.schemas(), ["main", "tpch"]);
    assert_eq!(ctx.table_names(), ["orders", "tpch.lineitem"]);
    assert!(ctx.contains("tpch.lineitem") && ctx.contains("orders") && !ctx.contains("lineitem"));

    assert_eq!(scalar(&ctx, "select sum(v) from tpch.lineitem"), "60");
    assert_eq!(scalar(&ctx, "select sum(v) from TPCH.LINEITEM"), "60");
    assert_eq!(scalar(&ctx, "select sum(v) from \"tpch\".\"lineitem\""), "60");
    // scans are named by the bare table name, or by the alias
    assert_eq!(scalar(&ctx, "select sum(lineitem.v) from tpch.lineitem"), "60");
    assert_eq!(scalar(&ctx, "select sum(tpch.lineitem.v) from tpch.lineitem"), "60");
    assert_eq!(scalar(&ctx, "select sum(l.v) from tpch.lineitem as l"), "60");
    assert_eq!(scalar(&ctx, "select count(*) from tpch.lineitem l join orders o on l.v = o.v * 10"), "2");
    // `main.orders` is `orders`
    assert_eq!(scalar(&ctx, "select sum(v) from main.orders"), "3");

    // the DataFrame API reads the same names
    let (_, batches) = ctx.table("tpch.lineitem").unwrap().collect().unwrap();
    assert_eq!(batches.iter().map(|b| b.num_rows()).sum::<usize>(), 3);
    assert_eq!(ctx.is_loaded("tpch.lineitem"), Some(true));
    assert_eq!(ctx.is_loaded("lineitem"), None);
    assert!(ctx.deregister("tpch.lineitem") && !ctx.deregister("tpch.lineitem"));
    assert_eq!(ctx.table_names(), ["orders"]);
    // the schema stays once it exists
    assert_eq!(ctx.schemas(), ["main", "tpch"]);
}

#[test]
fn bare_names_resolve_in_the_current_schema_then_main() {
    let ctx = SessionContext::new();
    table(&ctx, "t", &[1]);
    table(&ctx, "only_main", &[5]);
    table(&ctx, "tpch.t", &[2]);
    table(&ctx, "tpch.only_tpch", &[7]);
    assert_eq!(ctx.current_schema(), "main");
    assert_eq!(scalar(&ctx, "select v from t"), "1");
    assert!(error(&ctx, "select v from only_tpch").contains("not found"));

    run(&ctx, "use tpch");
    assert_eq!(ctx.current_schema(), "tpch");
    assert_eq!(scalar(&ctx, "select v from t"), "2");
    assert_eq!(scalar(&ctx, "select v from only_tpch"), "7");
    // not in tpch: falls back to main
    assert_eq!(scalar(&ctx, "select v from only_main"), "5");
    // qualified names ignore the current schema
    assert_eq!(scalar(&ctx, "select v from main.t"), "1");
    assert_eq!(scalar(&ctx, "select v from tpch.t"), "2");
    assert!(error(&ctx, "select v from tpch.only_main").contains("not found"));
    // the DataFrame API resolves like a query; the registry calls take `main`'s
    let (_, batches) = ctx.table("t").unwrap().collect().unwrap();
    assert_eq!(arrow::util::display::array_value_to_string(batches[0].column(0), 0).unwrap(), "2");
    assert!(ctx.contains("t") && !ctx.contains("only_tpch"));

    run(&ctx, "use main");
    assert_eq!(scalar(&ctx, "select v from t"), "1");
}

#[test]
fn a_qualified_name_is_not_shadowed_by_its_last_part() {
    let ctx = SessionContext::new();
    table(&ctx, "lineitem", &[1]);
    // `tpch` does not exist yet
    let e = error(&ctx, "select v from tpch.lineitem");
    assert!(e.contains("table 'tpch.lineitem' not found") && e.contains("schema 'tpch' does not exist"), "{e}");
    run(&ctx, "create schema tpch");
    // main.lineitem does not answer for tpch.lineitem
    let e = error(&ctx, "select v from tpch.lineitem");
    assert!(e.contains("table 'tpch.lineitem' not found"), "{e}");
    table(&ctx, "tpch.lineitem", &[2]);
    assert_eq!(scalar(&ctx, "select v from tpch.lineitem"), "2");
    assert_eq!(scalar(&ctx, "select v from lineitem"), "1");
    // and the other way round
    ctx.deregister("lineitem");
    assert!(error(&ctx, "select v from lineitem").contains("not found"));
    assert_eq!(scalar(&ctx, "select v from tpch.lineitem"), "2");
    // a three-part name ignores its catalog but not its schema
    assert_eq!(scalar(&ctx, "select v from lake.tpch.lineitem"), "2");
    assert!(error(&ctx, "select v from lake.main.lineitem").contains("not found"));
}

#[test]
fn ctes_shadow_only_bare_names() {
    let ctx = SessionContext::new();
    table(&ctx, "t", &[1]);
    table(&ctx, "tpch.t", &[2]);
    assert_eq!(scalar(&ctx, "with t as (select 100 as v) select v from t"), "100");
    assert_eq!(scalar(&ctx, "with t as (select 100 as v) select v from tpch.t"), "2");
    assert_eq!(scalar(&ctx, "with t as (select 100 as v) select v from main.t"), "1");
    run(&ctx, "use tpch");
    assert_eq!(scalar(&ctx, "with t as (select 100 as v) select v from t"), "100");
}

#[test]
fn use_checks_the_schema_and_forks_copy_it() {
    let ctx = SessionContext::new();
    let done = run(&ctx, "create schema tpch");
    assert!(done.contains("create schema") && done.contains("tpch"), "{done}");
    let done = run(&ctx, "USE Tpch;");
    assert!(done.contains("| use") && done.contains("tpch"), "{done}");
    assert_eq!(ctx.current_schema(), "tpch");

    assert_eq!(error(&ctx, "use nope"), "Planning error: schema 'nope' does not exist (CREATE SCHEMA nope first)");
    assert_eq!(ctx.current_schema(), "tpch");
    assert!(error(&ctx, "use \"../x\"").contains("invalid schema name"));

    table(&ctx, "tpch.t", &[1]);
    let fork = ctx.fork();
    assert_eq!(fork.current_schema(), "tpch");
    assert_eq!(fork.schemas(), ["main", "tpch"]);
    assert_eq!(fork.table_names(), ["tpch.t"]);
    // later changes on either side are independent
    run(&fork, "use main");
    run(&fork, "create schema other");
    assert_eq!(fork.current_schema(), "main");
    assert_eq!(ctx.current_schema(), "tpch");
    assert_eq!(ctx.schemas(), ["main", "tpch"]);
}

#[test]
fn schemas_are_created_once_and_listed_with_main_first() {
    let ctx = SessionContext::new();
    assert_eq!(ctx.schemas(), ["main"]);
    run(&ctx, "create schema zeta");
    run(&ctx, "create schema alpha");
    table(&ctx, "mid.t", &[1]);
    assert_eq!(ctx.schemas(), ["main", "alpha", "mid", "zeta"]);

    assert_eq!(error(&ctx, "create schema alpha"), "Planning error: schema 'alpha' already exists");
    assert!(error(&ctx, "create schema main").contains("already exists"));
    let again = run(&ctx, "create schema if not exists ALPHA");
    assert!(again.contains("create schema") && again.contains("alpha"), "{again}");
    run(&ctx, "create schema if not exists main");
    assert_eq!(ctx.schemas().len(), 4);
    for bad in ["\"a b\"", "\"a.b\"", "\"../x\"", "\"1a\""] {
        assert!(error(&ctx, &format!("create schema {bad}")).contains("invalid schema name"), "{bad}");
    }
    // the summary row: operation, table, path, rows
    let (_, batches) = ctx.sql("create schema beta").unwrap().collect().unwrap();
    let row: Vec<String> = (0..4).map(|c| arrow::util::display::array_value_to_string(batches[0].column(c), 0).unwrap()).collect();
    assert_eq!(row, ["create schema", "beta", "", "0"]);
}

#[test]
fn drop_schema_restrict_and_cascade() {
    let ctx = SessionContext::new();
    table(&ctx, "s.a", &[1]);
    table(&ctx, "s.b", &[2]);
    table(&ctx, "a", &[3]);
    run(&ctx, "use s");

    let e = error(&ctx, "drop schema s");
    assert!(e.contains("not empty") && e.contains("DROP SCHEMA s CASCADE"), "{e}");
    assert!(error(&ctx, "drop schema s restrict").contains("not empty"));
    assert_eq!(ctx.table_names(), ["a", "s.a", "s.b"]);

    let done = run(&ctx, "drop schema s cascade");
    assert!(done.contains("drop schema") && done.contains("| s "), "{done}");
    assert_eq!(ctx.table_names(), ["a"]);
    assert_eq!(ctx.schemas(), ["main"]);
    // dropping the current schema falls back to main
    assert_eq!(ctx.current_schema(), "main");
    assert_eq!(scalar(&ctx, "select v from a"), "3");

    assert!(error(&ctx, "drop schema s").contains("schema 's' does not exist"));
    run(&ctx, "drop schema if exists s");
    assert!(error(&ctx, "drop schema main").contains("cannot be dropped"));
    assert!(error(&ctx, "drop schema main cascade").contains("cannot be dropped"));
    assert_eq!(ctx.table_names(), ["a"]);

    // an empty schema drops without CASCADE
    run(&ctx, "create schema e");
    run(&ctx, "drop schema e");
    assert_eq!(ctx.schemas(), ["main"]);
    // the Rust API returns what a cascade dropped
    table(&ctx, "x.t1", &[1]);
    table(&ctx, "x.t2", &[1]);
    assert_eq!(ctx.drop_schema("x", false, true).unwrap(), ["x.t1", "x.t2"]);
}

#[test]
fn tables_created_in_memory_take_inserts_by_qualified_name() {
    let ctx = SessionContext::new();
    run(&ctx, "create schema sales");
    let done = run(&ctx, "create table sales.orders as select 1 as v");
    assert!(done.contains("| create") && done.contains("sales.orders") && done.contains("| 1 "), "{done}");
    assert_eq!(ctx.table_names(), ["sales.orders"]);
    run(&ctx, "create table orders as select 100 as v");
    assert_eq!(ctx.table_names(), ["orders", "sales.orders"]);

    let done = run(&ctx, "insert into sales.orders select 2");
    assert!(done.contains("| insert") && done.contains("sales.orders"), "{done}");
    assert_eq!(scalar(&ctx, "select sum(v) from sales.orders"), "3");
    assert_eq!(scalar(&ctx, "select sum(v) from orders"), "100");

    assert!(error(&ctx, "create table sales.orders as select 1").contains("table 'sales.orders' already exists"));
    run(&ctx, "create table if not exists sales.orders as select 1");
    run(&ctx, "create or replace table sales.orders as select 5 as v");
    assert_eq!(scalar(&ctx, "select sum(v) from sales.orders"), "5");

    let done = run(&ctx, "drop table sales.orders");
    assert!(done.contains("| drop") && done.contains("sales.orders"), "{done}");
    assert_eq!(ctx.table_names(), ["orders"]);
    assert!(error(&ctx, "drop table sales.orders").contains("table 'sales.orders' not found"));
    run(&ctx, "drop table if exists sales.orders");
    // the schema is left
    assert_eq!(ctx.schemas(), ["main", "sales"]);
}

#[test]
fn bare_writes_go_to_the_current_schema() {
    let ctx = SessionContext::new();
    run(&ctx, "create schema s");
    table(&ctx, "t", &[1]);
    run(&ctx, "use s");
    // created in the current schema, not in main
    run(&ctx, "create table t as select 10 as v");
    assert_eq!(ctx.table_names(), ["s.t", "t"]);
    run(&ctx, "insert into t select 20");
    assert_eq!(scalar(&ctx, "select sum(v) from s.t"), "30");
    assert_eq!(scalar(&ctx, "select sum(v) from main.t"), "1");
    // an existing table is found in the current schema, then in main
    table(&ctx, "only_main", &[5]);
    run(&ctx, "insert into only_main select 6");
    assert_eq!(scalar(&ctx, "select sum(v) from main.only_main"), "11");
    run(&ctx, "drop table t");
    assert_eq!(ctx.table_names(), ["only_main", "t"]);
    run(&ctx, "drop table t");
    assert_eq!(ctx.table_names(), ["only_main"]);
}

#[test]
fn tables_created_in_a_warehouse_live_in_their_schema_folder() {
    let dir = Dir::new("warehouse");
    let wh = dir.join("wh");
    let ctx = SessionContext::new();
    ctx.set_warehouse(Some(&wh), &Default::default());
    run(&ctx, "create schema tpch");

    let done = run(&ctx, "create table tpch.t using parquet as select 1 as v");
    assert!(done.contains("tpch.t") && done.contains("wh/tpch/t"), "{done}");
    let folder = Path::new(&wh).join("tpch").join("t");
    assert!(folder.is_dir() && std::fs::read_dir(&folder).unwrap().count() == 1);
    // a table in main keeps <warehouse>/<table>
    run(&ctx, "create table t using parquet as select 100 as v");
    assert!(Path::new(&wh).join("t").is_dir());
    assert_eq!(scalar(&ctx, "select v from t"), "100");
    assert_eq!(scalar(&ctx, "select v from tpch.t"), "1");

    run(&ctx, "insert into tpch.t select 2");
    assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 2);
    assert_eq!(scalar(&ctx, "select sum(v) from tpch.t"), "3");

    // partitioned tables too
    run(&ctx, "create table tpch.p using parquet partitioned by (v) as select 1 as v, 'a' as w");
    assert!(Path::new(&wh).join("tpch").join("p").join("v=1").is_dir());

    // replace removes the schema table's folder only
    run(&ctx, "create or replace table tpch.t using parquet as select 7 as v");
    assert_eq!(std::fs::read_dir(&folder).unwrap().count(), 1);
    assert_eq!(scalar(&ctx, "select v from t"), "100");

    // DROP TABLE keeps the files: re-creating needs OR REPLACE
    run(&ctx, "drop table tpch.t");
    assert!(ctx.sql("select * from tpch.t").is_err());
    assert!(error(&ctx, "create table tpch.t using parquet as select 1 as v").contains("already holds data"));
    run(&ctx, "create or replace table tpch.t using parquet as select 1 as v");
    assert_eq!(scalar(&ctx, "select v from tpch.t"), "1");
}

#[test]
fn bad_names_are_rejected_before_anything_is_written() {
    let dir = Dir::new("names");
    let wh = dir.join("wh");
    let ctx = SessionContext::new();
    ctx.set_warehouse(Some(&wh), &Default::default());
    run(&ctx, "create schema ok");

    for bad in ["\"../x\"", "\"a b\"", "\"ok/../../x\"", "ok.\"../x\"", "a.b.c", "\"a\\b\"", "\"1t\""] {
        let e = error(&ctx, &format!("create table {bad} as select 1"));
        assert!(e.contains("invalid table name"), "{bad}: {e}");
        assert!(error(&ctx, &format!("insert into {bad} select 1")).contains("invalid table name"), "{bad}");
        assert!(error(&ctx, &format!("drop table if exists {bad}")).contains("invalid table name"), "{bad}");
    }
    assert!(!Path::new(&wh).exists(), "nothing was written");
    assert!(!dir.0.join("x").exists());
    assert!(ctx.table_names().is_empty());

    // a schema that does not exist
    let e = error(&ctx, "create table nope.t as select 1");
    assert_eq!(e, "Planning error: schema 'nope' does not exist (CREATE SCHEMA nope first)");
    assert!(error(&ctx, "insert into nope.t select 1").contains("schema 'nope' does not exist (CREATE SCHEMA nope first)"));
    assert!(error(&ctx, "drop table nope.t").contains("schema 'nope' does not exist"));
    run(&ctx, "drop table if exists nope.t");
    assert!(error(&ctx, "insert into ok.missing select 1").contains("table 'ok.missing' not found"));
    assert!(!Path::new(&wh).exists());
}

#[test]
fn files_in_from_still_resolve_as_paths() {
    let dir = Dir::new("files");
    let ctx = SessionContext::new();
    let file = dir.join("data.parquet");
    run(&ctx, &format!("copy (select 41 as v) to '{file}'"));
    assert_eq!(scalar(&ctx, &format!("select v from '{file}'")), "41");
    assert_eq!(scalar(&ctx, &format!("select v from read_parquet('{file}')")), "41");
    // `a.parquet` is read as a path when no table `parquet` is in schema `a`
    let e = error(&ctx, "select v from nowhere.parquet");
    assert!(e.contains("path 'nowhere.parquet' does not exist"), "{e}");
}

#[test]
fn tables_created_in_a_schema_with_a_location_are_written_there() {
    let dir = Dir::new("location");
    let ctx = SessionContext::new();
    ctx.set_warehouse(Some(&dir.join("wh")), &Default::default());
    ctx.sql("create schema s").unwrap().collect().unwrap();
    ctx.sql("create schema other").unwrap().collect().unwrap();
    ctx.set_schema_location("s", Some(&dir.join("loc")), &Default::default());
    assert_eq!(ctx.schema_location("S").map(|(p, _)| p), Some(dir.join("loc")));

    run(&ctx, "create table s.t using parquet as select 1 as v union all select 2");
    run(&ctx, "create table other.t using parquet as select 3 as v");
    assert!(Path::new(&dir.join("loc/t")).is_dir());
    assert!(!Path::new(&dir.join("wh/s")).exists());
    assert!(Path::new(&dir.join("wh/other/t")).is_dir());
    assert_eq!(scalar(&ctx, "select sum(v) from s.t"), "3");

    run(&ctx, "create or replace table s.t using parquet as select 10 as v");
    assert_eq!(scalar(&ctx, "select sum(v) from s.t"), "10");
    // a fork keeps the locations
    assert!(ctx.fork().schema_location("s").is_some());
}
