//! Catalogs and schemas: `catalog.schema.table` names, the current catalog and
//! schema (`USE`), `CREATE CATALOG` / `DROP CATALOG`,
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
    ctx.register_batches(name, schema, vec![batch]).unwrap();
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

/// The values of one column of a statement's result, as text.
fn column(ctx: &SessionContext, q: &str, c: usize) -> Vec<String> {
    let (_, batches) = ctx.sql(q).unwrap().collect().unwrap();
    batches
        .iter()
        .flat_map(|b| (0..b.num_rows()).map(move |r| arrow::util::display::array_value_to_string(b.column(c), r).unwrap()))
        .collect()
}

/// The first value of a frame.
fn first(lf: iara_core::LazyFrame) -> String {
    let (_, batches) = lf.collect().unwrap();
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
    // the DataFrame API and the registry calls take the default catalog's `main` for a bare name, whatever `USE` says
    let (_, batches) = ctx.table("t").unwrap().collect().unwrap();
    assert_eq!(arrow::util::display::array_value_to_string(batches[0].column(0), 0).unwrap(), "1");
    assert!(ctx.contains("t") && !ctx.contains("only_tpch"));
    assert!(ctx.table("only_tpch").is_err() && ctx.table("tpch.only_tpch").is_ok());

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
    // a three-part name names its catalog, which must exist, and its schema
    assert_eq!(scalar(&ctx, "select v from main.tpch.lineitem"), "2");
    assert!(error(&ctx, "select v from main.main.lineitem").contains("not found"));
    let e = error(&ctx, "select v from lake.tpch.lineitem");
    assert!(e.contains("table 'lake.tpch.lineitem' not found") && e.contains("catalog 'lake' does not exist"), "{e}");
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
    for bad in ["\"a b\"", "\"a.b.c\"", "\"../x\"", "\"1a\"", "main.\"a b\""] {
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

    for bad in ["\"../x\"", "\"a b\"", "\"ok/../../x\"", "ok.\"../x\"", "a.b.c.d", "main.ok.\"../x\"", "\"a\\b\"", "\"1t\""] {
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
    // and so does a three-part look-alike, though its catalog does not exist
    let e = error(&ctx, "select v from some.where.parquet");
    assert!(e.contains("path 'some.where.parquet' does not exist"), "{e}");
}

#[test]
fn tables_created_in_a_schema_with_a_location_are_written_there() {
    let dir = Dir::new("location");
    let ctx = SessionContext::new();
    ctx.set_warehouse(Some(&dir.join("wh")), &Default::default());
    ctx.sql("create schema s").unwrap().collect().unwrap();
    ctx.sql("create schema other").unwrap().collect().unwrap();
    ctx.set_schema_location("s", Some(&dir.join("loc")), &Default::default()).unwrap();
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

// ---------------------------------------------------------------------------
// catalogs
// ---------------------------------------------------------------------------

#[test]
fn catalogs_are_created_and_listed_with_the_default_first() {
    let ctx = SessionContext::new();
    assert_eq!(ctx.catalogs(), ["main"]);
    assert_eq!((ctx.default_catalog().as_str(), ctx.current_catalog().as_str()), ("main", "main"));
    run(&ctx, "create catalog zeta");
    run(&ctx, "create catalog Alpha");
    assert_eq!(ctx.catalogs(), ["main", "alpha", "zeta"]);
    assert_eq!(column(&ctx, "show catalogs", 0), ["main", "alpha", "zeta"]);
    assert_eq!(column(&ctx, "show catalogs", 1), ["true", "false", "false"]);

    assert_eq!(error(&ctx, "create catalog alpha"), "Planning error: catalog 'alpha' already exists");
    assert!(error(&ctx, "create catalog main").contains("already exists"));
    run(&ctx, "create catalog if not exists ALPHA");
    run(&ctx, "create catalog if not exists main");
    assert_eq!(ctx.catalogs().len(), 3);
    for bad in ["\"a b\"", "\"a.b\"", "\"../x\"", "\"1a\""] {
        assert!(error(&ctx, &format!("create catalog {bad}")).contains("invalid catalog name"), "{bad}");
    }
    // the summary row: operation, table, path, rows
    let (_, batches) = ctx.sql("create catalog beta").unwrap().collect().unwrap();
    let row: Vec<String> = (0..4).map(|c| arrow::util::display::array_value_to_string(batches[0].column(c), 0).unwrap()).collect();
    assert_eq!(row, ["create catalog", "beta", "", "0"]);

    // a new catalog has its `main` schema and nothing else
    assert_eq!(ctx.schemas_of("beta").unwrap(), ["main"]);
    assert!(ctx.has_catalog("BETA") && ctx.has_schema("beta", "main") && !ctx.has_schema("beta", "s"));
    assert_eq!(ctx.schemas_of("nope").unwrap_err().to_string(), "Planning error: catalog 'nope' does not exist (CREATE CATALOG nope first)");

    // the session names its default catalog when it is created
    let lake = SessionContext::with_default_catalog("Lake").unwrap();
    assert_eq!((lake.default_catalog().as_str(), lake.current_catalog().as_str()), ("lake", "lake"));
    assert_eq!(lake.catalogs(), ["lake"]);
    assert!(SessionContext::with_default_catalog("a.b").is_err() && SessionContext::with_default_catalog("").is_err());
    run(&lake, "create catalog main");
    assert_eq!(lake.catalogs(), ["lake", "main"]);
}

#[test]
fn three_part_names_create_read_and_write_across_catalogs() {
    let ctx = SessionContext::new();
    run(&ctx, "create catalog lake");
    run(&ctx, "create schema lake.sales");
    let done = run(&ctx, "create table lake.sales.orders as select 1 as v union all select 2");
    assert!(done.contains("| create") && done.contains("lake.sales.orders") && done.contains("| 2 "), "{done}");
    assert_eq!(ctx.table_names(), ["lake.sales.orders"]);
    assert_eq!(ctx.schemas_of("lake").unwrap(), ["main", "sales"]);
    assert_eq!(ctx.schemas(), ["main"]);

    // reads: scans are named by the bare table, or by the alias
    assert_eq!(scalar(&ctx, "select sum(v) from lake.sales.orders"), "3");
    assert_eq!(scalar(&ctx, "select sum(orders.v) from lake.sales.orders"), "3");
    assert_eq!(scalar(&ctx, "select sum(o.v) from \"lake\".\"sales\".\"orders\" as o"), "3");
    assert_eq!(scalar(&ctx, "select sum(v) from LAKE.Sales.ORDERS"), "3");

    // a join across catalogs
    run(&ctx, "create table prices as select 1 as v, 10 as price union all select 2, 20");
    assert_eq!(scalar(&ctx, "select sum(p.price) from lake.sales.orders o join prices p on o.v = p.v"), "30");
    assert_eq!(scalar(&ctx, "select sum(p.price) from lake.sales.orders o join main.main.prices p on o.v = p.v"), "30");
    assert_eq!(scalar(&ctx, "with t as (select 100 as v) select v from t"), "100");

    // writes
    run(&ctx, "insert into lake.sales.orders select 3");
    assert_eq!(scalar(&ctx, "select sum(v) from lake.sales.orders"), "6");
    let done = run(&ctx, "create view lake.sales.big as select v from lake.sales.orders where v > 1");
    assert!(done.contains("lake.sales.big"), "{done}");
    assert_eq!(scalar(&ctx, "select count(*) from lake.sales.big"), "2");
    assert!(error(&ctx, "drop view lake.sales.orders").contains("'lake.sales.orders' is a table, not a view"));
    run(&ctx, "drop view lake.sales.big");
    assert_eq!(column(&ctx, "describe lake.sales.orders", 0), ["v"]);
    assert_eq!(column(&ctx, "show columns from lake.sales.orders", 0), ["v"]);
    assert!(error(&ctx, "create table lake.sales.orders as select 1").contains("table 'lake.sales.orders' already exists"));
    run(&ctx, "create table if not exists lake.sales.orders as select 1");
    run(&ctx, "create or replace table lake.sales.orders as select 5 as v");
    assert_eq!(scalar(&ctx, "select sum(v) from lake.sales.orders"), "5");
    run(&ctx, "truncate table lake.sales.orders");
    assert_eq!(scalar(&ctx, "select count(*) from lake.sales.orders"), "0");
    let done = run(&ctx, "drop table lake.sales.orders");
    assert!(done.contains("| drop") && done.contains("lake.sales.orders"), "{done}");
    assert_eq!(ctx.table_names(), ["prices"]);
    assert!(error(&ctx, "drop table lake.sales.orders").contains("table 'lake.sales.orders' not found"));
    run(&ctx, "drop table if exists lake.sales.orders");
    // the schema is left
    assert_eq!(ctx.schemas_of("lake").unwrap(), ["main", "sales"]);
}

#[test]
fn catalogs_and_schemas_that_do_not_exist_are_named_in_the_error() {
    let ctx = SessionContext::new();
    run(&ctx, "create catalog lake");
    table(&ctx, "lake.s.t", &[1]);
    let no_catalog = "Planning error: catalog 'nope' does not exist (CREATE CATALOG nope first)";
    for q in [
        "create table nope.s.t as select 1",
        "create view nope.s.v as select 1",
        "insert into nope.s.t select 1",
        "truncate table nope.s.t",
        "drop table nope.s.t",
        "drop view nope.s.t",
        "describe nope.s.t",
        "optimize nope.s.t",
        "update nope.s.t set a = 1",
        "create schema nope.s",
        "drop schema nope.s",
    ] {
        assert_eq!(error(&ctx, q), no_catalog, "{q}");
    }
    run(&ctx, "drop table if exists nope.s.t");
    run(&ctx, "drop view if exists nope.s.t");
    run(&ctx, "drop schema if exists lake.nope");
    let e = error(&ctx, "select v from nope.s.t");
    assert!(e.contains("table 'nope.s.t' not found") && e.contains("catalog 'nope' does not exist") && e.contains("registered: [\"lake.s.t\"]"), "{e}");

    assert_eq!(error(&ctx, "create table lake.nope.t as select 1"), "Planning error: schema 'lake.nope' does not exist (CREATE SCHEMA lake.nope first)");
    assert!(error(&ctx, "insert into lake.nope.t select 1").contains("schema 'lake.nope' does not exist"));
    assert!(error(&ctx, "select v from lake.nope.t").contains("table 'lake.nope.t' not found: schema 'lake.nope' does not exist"));
    assert!(error(&ctx, "select v from lake.s.nope").contains("table 'lake.s.nope' not found"));
    // a two-part name is never catalog.table: `lake` is looked for as a schema of the current catalog
    let e = error(&ctx, "select v from lake.t");
    assert!(e.contains("table 'lake.t' not found: schema 'lake' does not exist"), "{e}");
    assert!(error(&ctx, "create table lake.t as select 1").contains("schema 'lake' does not exist (CREATE SCHEMA lake first)"));
    // a name that has too many parts or none that is valid
    assert!(error(&ctx, "create table lake.s.t.x as select 1").contains("catalog.schema.table"));
}

#[test]
fn use_catalog_changes_where_names_are_looked_up() {
    let ctx = SessionContext::new();
    table(&ctx, "t", &[1]);
    table(&ctx, "d_only", &[9]);
    run(&ctx, "create catalog lake");
    table(&ctx, "lake.main.t", &[2]);
    table(&ctx, "lake.s.t", &[3]);
    table(&ctx, "lake.s.s_only", &[4]);
    table(&ctx, "lake.main.l_only", &[5]);
    assert_eq!(scalar(&ctx, "select v from t"), "1");

    let done = run(&ctx, "use catalog LAKE");
    assert!(done.contains("| use catalog") && done.contains("lake"), "{done}");
    assert_eq!((ctx.current_catalog().as_str(), ctx.current_schema().as_str()), ("lake", "main"));
    assert_eq!(scalar(&ctx, "select v from t"), "2");
    // `s.t` is schema s of the current catalog; `main.t` is its main schema, not the catalog `main`
    assert_eq!(scalar(&ctx, "select v from s.t"), "3");
    assert_eq!(scalar(&ctx, "select v from main.t"), "2");
    assert_eq!(scalar(&ctx, "select v from main.main.t"), "1");
    assert_eq!(scalar(&ctx, "select v from lake.s.t"), "3");
    assert_eq!(scalar(&ctx, "select v from l_only"), "5");
    // the default catalog's tables are out of sight for short names
    assert!(error(&ctx, "select v from d_only").contains("not found"));
    assert_eq!(scalar(&ctx, "select v from main.main.d_only"), "9");
    let e = error(&ctx, "select v from nosuch.t");
    assert!(e.contains("schema 'lake.nosuch' does not exist"), "{e}");
    // CTEs still shadow only bare names
    assert_eq!(scalar(&ctx, "with t as (select 100 as v) select v from t"), "100");
    assert_eq!(scalar(&ctx, "with t as (select 100 as v) select v from main.t"), "2");

    // bare writes go to the current catalog and schema
    run(&ctx, "create table w as select 7 as v");
    assert_eq!(scalar(&ctx, "select v from lake.main.w"), "7");
    run(&ctx, "use s");
    assert_eq!((ctx.current_catalog().as_str(), ctx.current_schema().as_str()), ("lake", "s"));
    assert_eq!(scalar(&ctx, "select v from t"), "3");
    assert_eq!(scalar(&ctx, "select v from l_only"), "5");
    run(&ctx, "create table w2 as select 8 as v");
    run(&ctx, "insert into w2 select 9");
    assert_eq!(scalar(&ctx, "select sum(v) from lake.s.w2"), "17");
    assert_eq!(ctx.table_names(), ["d_only", "lake.main.l_only", "lake.main.t", "lake.main.w", "lake.s.s_only", "lake.s.t", "lake.s.w2", "t"]);

    // USE catalog.schema sets both; USE CATALOG starts at main
    run(&ctx, "use main.main");
    assert_eq!((ctx.current_catalog().as_str(), ctx.current_schema().as_str()), ("main", "main"));
    assert_eq!(scalar(&ctx, "select v from t"), "1");
    let done = run(&ctx, "use lake.s");
    assert!(done.contains("| use ") && done.contains("lake.s"), "{done}");
    assert_eq!((ctx.current_catalog().as_str(), ctx.current_schema().as_str()), ("lake", "s"));
    run(&ctx, "use catalog lake");
    assert_eq!((ctx.current_catalog().as_str(), ctx.current_schema().as_str()), ("lake", "main"));

    // a failed USE changes nothing
    run(&ctx, "use s");
    assert_eq!(error(&ctx, "use catalog nope"), "Planning error: catalog 'nope' does not exist (CREATE CATALOG nope first)");
    assert!(error(&ctx, "use nope.s").contains("catalog 'nope' does not exist"));
    assert_eq!(error(&ctx, "use lake.nope"), "Planning error: schema 'lake.nope' does not exist (CREATE SCHEMA lake.nope first)");
    assert!(error(&ctx, "use nope").contains("schema 'lake.nope' does not exist"));
    assert!(error(&ctx, "use catalog \"a b\"").contains("invalid catalog name"));
    assert!(error(&ctx, "use a.b.c").contains("invalid schema name"));
    assert_eq!((ctx.current_catalog().as_str(), ctx.current_schema().as_str()), ("lake", "s"));

    // forks copy both and then go their own way
    let fork = ctx.fork();
    assert_eq!((fork.current_catalog().as_str(), fork.current_schema().as_str()), ("lake", "s"));
    assert_eq!(fork.catalogs(), ["main", "lake"]);
    run(&fork, "use catalog main");
    run(&fork, "create catalog other");
    assert_eq!((ctx.current_catalog().as_str(), ctx.current_schema().as_str()), ("lake", "s"));
    assert_eq!(ctx.catalogs(), ["main", "lake"]);
    assert_eq!(fork.default_catalog(), "main");
}

#[test]
fn registration_names_stay_relative_to_the_default_catalog() {
    let ctx = SessionContext::new();
    run(&ctx, "create catalog lake");
    table(&ctx, "t", &[1]);
    table(&ctx, "lake.s.t", &[2]);
    run(&ctx, "use lake.s");

    // USE does not move the registry: a bare name is the default catalog's `main`
    table(&ctx, "late", &[3]);
    table(&ctx, "s.in_default", &[4]);
    assert_eq!(ctx.table_names(), ["lake.s.t", "late", "s.in_default", "t"]);
    assert!(ctx.contains("late") && ctx.contains("main.late") && ctx.contains("main.main.late") && !ctx.contains("lake.s.late"));
    assert!(ctx.contains("t") && ctx.contains("lake.s.t") && ctx.contains("s.in_default") && !ctx.contains("s.t"));
    assert_eq!(scalar(&ctx, "select v from main.main.late"), "3");
    assert_eq!(first(ctx.table("t").unwrap()), "1");
    assert_eq!(first(ctx.table("lake.s.t").unwrap()), "2");
    assert!(ctx.table("s.t").is_err());
    assert_eq!(ctx.is_loaded("t"), Some(true));
    assert_eq!(ctx.is_loaded("lake.s.t"), Some(true));
    assert_eq!(ctx.is_loaded("s.t"), None);
    assert!(ctx.lookup("t").unwrap().is_some() && ctx.lookup("lake.s.t").unwrap().is_some() && ctx.lookup("s.t").unwrap().is_none());
    assert!(ctx.deregister("lake.s.t") && !ctx.deregister("lake.s.t") && !ctx.deregister("s.t"));

    // a catalog that does not exist: registering fails, anything else finds nothing
    let no_catalog = "Planning error: catalog 'nope' does not exist (CREATE CATALOG nope first)";
    let schema = Arc::new(Schema::new(vec![Field::new("v", DataType::Int64, false)]));
    assert_eq!(ctx.register_batches("nope.s.t", schema, vec![]).unwrap_err().to_string(), no_catalog);
    assert!(!ctx.contains("nope.s.t") && !ctx.deregister("nope.s.t") && ctx.is_loaded("nope.s.t").is_none());
    assert!(ctx.lookup("nope.s.t").unwrap().is_none() && ctx.table("nope.s.t").is_err());
    // a loader fails before it reads anything
    assert_eq!(ctx.register_parquet("nope.s.t", "missing.parquet").unwrap_err().to_string(), no_catalog);
    assert_eq!(ctx.register_parquet_with("nope.s.t", "missing.parquet", &Default::default(), true).unwrap_err().to_string(), no_catalog);
    assert_eq!(ctx.table_names().len(), 3);

    // views register by name too
    let plan = ctx.sql("select 1 as v").unwrap().plan.clone();
    ctx.register_view("lake.main.v", plan.clone()).unwrap();
    assert_eq!(scalar(&ctx, "select v from lake.main.v"), "1");
    assert_eq!(first(ctx.table("lake.main.v").unwrap()), "1");
    assert!(ctx.register_view("nope.main.v", plan).is_err());

    // what is not a name stays one bare name, in the default catalog
    table(&ctx, "Sales 2024", &[4]);
    assert!(ctx.table_names().contains(&"sales 2024".to_string()));
    assert_eq!(first(ctx.table("Sales 2024").unwrap()), "4");
    assert!(ctx.contains("sales 2024") && ctx.deregister("SALES 2024"));
}

#[test]
fn show_catalogs_schemas_and_tables_in_a_catalog() {
    let ctx = SessionContext::new();
    run(&ctx, "create catalog lake");
    run(&ctx, "create schema lake.s");
    run(&ctx, "create schema local");
    table(&ctx, "orders", &[1]);
    table(&ctx, "lake.s.t", &[1]);
    run(&ctx, "create view lake.s.v as select 1 as v");

    assert_eq!(column(&ctx, "show schemas", 0), ["main", "local"]);
    assert_eq!(column(&ctx, "show schemas", 1), ["true", "false"]);
    assert_eq!(column(&ctx, "show schemas in lake", 0), ["main", "s"]);
    assert_eq!(column(&ctx, "show schemas from LAKE", 0), ["main", "s"]);
    // `current` is the current schema, in the current catalog only
    assert_eq!(column(&ctx, "show schemas in lake", 1), ["false", "false"]);
    assert_eq!(column(&ctx, "show databases in main", 0), ["main", "local"]);
    assert_eq!(error(&ctx, "show schemas in nope"), "Planning error: catalog 'nope' does not exist (CREATE CATALOG nope first)");

    assert_eq!(column(&ctx, "show tables", 1), ["orders"]);
    assert_eq!(column(&ctx, "show tables in lake.s", 0), ["s", "s"]);
    assert_eq!(column(&ctx, "show tables in lake.s", 1), ["t", "v"]);
    assert_eq!(column(&ctx, "show tables in lake.s", 2), ["table", "view"]);
    assert_eq!(column(&ctx, "show tables from Lake.S", 1), ["t", "v"]);
    assert!(column(&ctx, "show tables in lake.main", 1).is_empty());
    // `s` alone is a schema of the current catalog
    assert!(error(&ctx, "show tables in s").contains("schema 's' does not exist"));
    assert!(error(&ctx, "show tables in lake.nope").contains("schema 'lake.nope' does not exist"));
    assert!(error(&ctx, "show tables in nope.s").contains("catalog 'nope' does not exist"));
    assert!(error(&ctx, "show tables in a.b.c").contains("invalid schema name"));

    run(&ctx, "use catalog lake");
    assert_eq!(column(&ctx, "show catalogs", 1), ["false", "true"]);
    assert_eq!(column(&ctx, "show schemas", 0), ["main", "s"]);
    assert_eq!(column(&ctx, "show schemas", 1), ["true", "false"]);
    assert_eq!(column(&ctx, "show schemas in main", 1), ["false", "false"]);
    assert_eq!(column(&ctx, "show tables in s", 1), ["t", "v"]);
    assert!(column(&ctx, "show tables", 1).is_empty());
    run(&ctx, "use s");
    assert_eq!(column(&ctx, "show tables", 1), ["t", "v"]);
    assert_eq!(column(&ctx, "show tables in main.local", 1), Vec::<String>::new());
}

#[test]
fn create_and_drop_schema_in_a_catalog() {
    let ctx = SessionContext::new();
    run(&ctx, "create catalog lake");
    run(&ctx, "create schema lake.s");
    assert_eq!(ctx.schemas_of("lake").unwrap(), ["main", "s"]);
    assert_eq!(ctx.schemas(), ["main"]);
    // the same name in another catalog is another schema
    run(&ctx, "create schema s");
    assert_eq!(error(&ctx, "create schema lake.s"), "Planning error: schema 'lake.s' already exists");
    assert_eq!(error(&ctx, "create schema s"), "Planning error: schema 's' already exists");
    assert!(error(&ctx, "create schema lake.main").contains("schema 'lake.main' already exists"));
    run(&ctx, "create schema if not exists lake.S");
    assert_eq!(column(&ctx, "create schema lake.q", 1), ["lake.q"]);
    assert_eq!(column(&ctx, "create schema r", 1), ["r"]);
    assert_eq!(column(&ctx, "drop schema lake.q", 1), ["lake.q"]);

    table(&ctx, "lake.s.a", &[1]);
    table(&ctx, "s.a", &[2]);
    let e = error(&ctx, "drop schema lake.s");
    assert!(e.contains("schema 'lake.s' is not empty") && e.contains("DROP SCHEMA lake.s CASCADE"), "{e}");
    run(&ctx, "use lake.s");
    let done = run(&ctx, "drop schema lake.s cascade");
    assert!(done.contains("drop schema") && done.contains("lake.s"), "{done}");
    // the other catalog's schema `s` and its table stay; the current schema fell back to main
    assert_eq!(ctx.table_names(), ["s.a"]);
    assert_eq!(ctx.schemas_of("lake").unwrap(), ["main"]);
    assert_eq!((ctx.current_catalog().as_str(), ctx.current_schema().as_str()), ("lake", "main"));
    assert!(error(&ctx, "drop schema lake.s").contains("schema 'lake.s' does not exist"));
    run(&ctx, "drop schema if exists lake.s");
    assert!(error(&ctx, "drop schema lake.main").contains("cannot be dropped"));
    // `s` is now looked up in the current catalog, lake
    assert!(error(&ctx, "drop schema s").contains("schema 'lake.s' does not exist"));
    assert_eq!(ctx.drop_schema("main.s", false, true).unwrap(), ["s.a"]);
    assert_eq!(ctx.table_names(), Vec::<String>::new());
}

#[test]
fn drop_catalog_restrict_and_cascade() {
    let ctx = SessionContext::new();
    run(&ctx, "create catalog c");
    table(&ctx, "c.s.a", &[1]);
    table(&ctx, "c.main.b", &[2]);
    table(&ctx, "a", &[3]);
    run(&ctx, "use c.s");

    let e = error(&ctx, "drop catalog c");
    assert!(e.contains("catalog 'c' is not empty") && e.contains("2 tables") && e.contains("DROP CATALOG c CASCADE"), "{e}");
    assert!(error(&ctx, "drop catalog c restrict").contains("is not empty"));
    assert_eq!(ctx.table_names(), ["a", "c.main.b", "c.s.a"]);
    // a schema alone makes a catalog non-empty
    run(&ctx, "create catalog e");
    run(&ctx, "create schema e.x");
    assert!(error(&ctx, "drop catalog e").contains("0 tables, 1 schemas"));
    run(&ctx, "drop catalog e cascade");
    assert_eq!(ctx.catalogs(), ["main", "c"]);

    let done = run(&ctx, "drop catalog c cascade");
    assert!(done.contains("drop catalog") && done.contains("| c "), "{done}");
    assert_eq!(ctx.table_names(), ["a"]);
    assert_eq!(ctx.catalogs(), ["main"]);
    // the current catalog was dropped: the default one is current again, in main
    assert_eq!((ctx.current_catalog().as_str(), ctx.current_schema().as_str()), ("main", "main"));
    assert_eq!(scalar(&ctx, "select v from a"), "3");
    assert!(error(&ctx, "select v from c.s.a").contains("catalog 'c' does not exist"));

    assert_eq!(error(&ctx, "drop catalog c"), "Planning error: catalog 'c' does not exist");
    run(&ctx, "drop catalog if exists c");
    // the default catalog cannot be dropped
    assert!(error(&ctx, "drop catalog main").contains("catalog 'main' is the default catalog and cannot be dropped"));
    assert!(error(&ctx, "drop catalog main cascade").contains("cannot be dropped"));
    assert!(error(&ctx, "drop catalog if exists main").contains("cannot be dropped"));
    assert_eq!(ctx.table_names(), ["a"]);

    // an empty catalog drops without CASCADE; a catalog the session is not in leaves the current one alone
    run(&ctx, "create catalog e2");
    run(&ctx, "create catalog keep");
    run(&ctx, "use catalog keep");
    run(&ctx, "drop catalog e2");
    assert_eq!(ctx.catalogs(), ["main", "keep"]);
    assert_eq!(ctx.current_catalog(), "keep");
    // the Rust API returns what a cascade dropped
    table(&ctx, "keep.s.t1", &[1]);
    table(&ctx, "keep.main.t0", &[1]);
    assert_eq!(ctx.drop_catalog("keep", false, true).unwrap(), ["keep.main.t0", "keep.s.t1"]);
    assert_eq!(ctx.current_catalog(), "main");

    // a default catalog with another name cannot be dropped either
    let lake = SessionContext::with_default_catalog("lake").unwrap();
    assert!(lake.drop_catalog("lake", true, true).unwrap_err().to_string().contains("cannot be dropped"));
    run(&lake, "create catalog main");
    run(&lake, "drop catalog main");
    assert_eq!(lake.catalogs(), ["lake"]);
}

#[test]
fn display_names_are_bare_in_the_default_catalogs_main_and_full_elsewhere() {
    let ctx = SessionContext::with_default_catalog("lake").unwrap();
    run(&ctx, "create catalog other");
    table(&ctx, "t", &[1]);
    table(&ctx, "main.u", &[1]);
    table(&ctx, "s.t", &[1]);
    table(&ctx, "lake.s.v", &[1]);
    table(&ctx, "other.main.t", &[1]);
    table(&ctx, "other.s.t", &[1]);
    assert_eq!(ctx.table_names(), ["other.main.t", "other.s.t", "s.t", "s.v", "t", "u"]);
    assert_eq!(ctx.catalogs(), ["lake", "other"]);
    // the names of a default catalog that is not called `main`
    assert_eq!(scalar(&ctx, "select v from lake.main.t"), "1");
    assert_eq!(scalar(&ctx, "select v from main.t"), "1");
    assert!(error(&ctx, "select v from lake.t").contains("schema 'lake' does not exist"));

    // statements report the same names
    assert_eq!(column(&ctx, "create table lake.main.z as select 1 as v", 1), ["z"]);
    assert_eq!(column(&ctx, "create table s.x as select 1 as v", 1), ["s.x"]);
    assert_eq!(column(&ctx, "create table other.main.y as select 1 as v", 1), ["other.main.y"]);
    assert_eq!(column(&ctx, "create table other.s.x as select 1 as v", 1), ["other.s.x"]);
    assert_eq!(column(&ctx, "insert into other.main.y select 2", 1), ["other.main.y"]);
    assert_eq!(column(&ctx, "create schema other.q", 1), ["other.q"]);
    assert_eq!(column(&ctx, "create schema lake.q2", 1), ["q2"]);
    assert_eq!(column(&ctx, "use other.q", 1), ["other.q"]);
    assert_eq!(column(&ctx, "use lake.q2", 1), ["q2"]);
    assert_eq!(column(&ctx, "use catalog other", 1), ["other"]);
    assert_eq!(column(&ctx, "drop table main.y", 1), ["other.main.y"]);
    let e = error(&ctx, "select v from other.s.nope");
    assert!(e.contains("registered:") && e.contains("other.s.t") && e.contains("\"s.t\""), "{e}");
}

#[test]
fn managed_folders_of_a_catalog_are_under_the_catalog_in_the_warehouse() {
    let dir = Dir::new("catalog-folders");
    let wh = dir.join("wh");
    let ctx = SessionContext::new();
    ctx.set_warehouse(Some(&wh), &Default::default());
    run(&ctx, "create catalog lake");
    run(&ctx, "create schema lake.sales");
    run(&ctx, "create schema tpch");

    let done = run(&ctx, "create table lake.sales.t using parquet as select 1 as v");
    assert!(done.contains("lake.sales.t") && done.contains("wh/_catalogs/lake/sales/t"), "{done}");
    assert!(Path::new(&wh).join("_catalogs/lake/sales/t").is_dir());
    // `main` of another catalog has a folder too; all of them are under `_catalogs`
    run(&ctx, "create table lake.main.m using parquet as select 2 as v");
    assert!(Path::new(&wh).join("_catalogs/lake/main/m").is_dir());
    // the default catalog keeps its layout
    run(&ctx, "create table d using parquet as select 3 as v");
    run(&ctx, "create table tpch.d using parquet as select 4 as v");
    assert!(Path::new(&wh).join("d").is_dir() && Path::new(&wh).join("tpch/d").is_dir());
    assert!(!Path::new(&wh).join("main").exists() && !Path::new(&wh).join("lake").exists());
    // the same names in two catalogs stay apart
    run(&ctx, "create table lake.main.d using parquet as select 5 as v");
    assert_eq!(scalar(&ctx, "select v from lake.main.d"), "5");
    assert_eq!(scalar(&ctx, "select v from d"), "3");
    run(&ctx, "insert into lake.sales.t select 10");
    assert_eq!(std::fs::read_dir(Path::new(&wh).join("_catalogs/lake/sales/t")).unwrap().count(), 2);
    assert_eq!(scalar(&ctx, "select sum(v) from lake.sales.t"), "11");

    // Delta tables (the default format): every statement takes three-part names
    run(&ctx, "create table lake.main.dt as select 1 as id, 'a' as name union all select 2, 'b'");
    let dt = Path::new(&wh).join("_catalogs/lake/main/dt");
    assert!(dt.join("_delta_log").is_dir());
    run(&ctx, "insert into lake.main.dt select 3, 'c'");
    run(&ctx, "update lake.main.dt set name = 'z' where id = 1");
    run(&ctx, "delete from lake.main.dt where id = 2");
    assert_eq!(scalar(&ctx, "select count(*) from lake.main.dt"), "2");
    run(&ctx, "create table lake.main.src as select 3 as id, 'q' as name union all select 9, 'n'");
    // in the catalog, a bare name finds both tables, and the merge's source too
    run(&ctx, "use catalog lake");
    run(
        &ctx,
        "merge into dt t using src s on t.id = s.id when matched then update set name = s.name when not matched then insert (id, name) values (s.id, s.name)",
    );
    run(&ctx, "use catalog main");
    assert_eq!(scalar(&ctx, "select count(*) from lake.main.dt"), "3");
    assert_eq!(scalar(&ctx, "select name from lake.main.dt where id = 3"), "q");
    assert_eq!(column(&ctx, "describe history lake.main.dt", 0).len(), 5);
    assert_eq!(column(&ctx, "describe detail lake.main.dt", 0).len(), 1);
    assert!(error(&ctx, "merge into lake.main.dt t using nope.s.x s on t.id = s.id when matched then delete").contains("catalog 'nope' does not exist"));
    assert_eq!(scalar(&ctx, "select count(*) from lake.main.dt version as of 0"), "2");
    run(&ctx, "restore table lake.main.dt to version as of 0");
    assert_eq!(scalar(&ctx, "select count(*) from lake.main.dt"), "2");
    run(&ctx, "optimize lake.main.dt");
    run(&ctx, "comment on table lake.main.dt is 'orders'");
    run(&ctx, "alter table lake.main.dt add column (extra bigint)");
    assert_eq!(column(&ctx, "describe lake.main.dt", 0), ["id", "name", "extra"]);
    run(&ctx, "vacuum lake.main.dt dry run");
    run(&ctx, "truncate table lake.main.dt");
    assert_eq!(scalar(&ctx, "select count(*) from lake.main.dt"), "0");

    // DROP TABLE deletes the folder of a managed table only: here the catalog's folder rule says which
    assert_eq!(column(&ctx, "drop table lake.main.dt", 2).len(), 1);
    assert!(!dt.exists(), "managed Delta table: folder deleted");
    run(&ctx, "create table lake.main.e as select 1 as id");
    let e = Path::new(&wh).join("_catalogs/lake/main/e");
    ctx.register_delta("lake.main.alias", e.to_str().unwrap(), &Default::default(), None, false).unwrap();
    run(&ctx, "drop table lake.main.alias");
    assert!(e.join("_delta_log").is_dir(), "registered elsewhere than its managed folder: external, files stay");
    run(&ctx, "drop table lake.main.e");
    assert!(!e.exists());
    // a table of the default catalog at the same name is another folder
    run(&ctx, "create table e as select 1 as id");
    assert!(Path::new(&wh).join("e/_delta_log").is_dir());
    run(&ctx, "drop table e");
    assert!(!Path::new(&wh).join("e").exists());

    // schema locations are per catalog and take priority over the warehouse
    ctx.set_schema_location("lake.sales", Some(&dir.join("loc")), &Default::default()).unwrap();
    assert_eq!(ctx.schema_location("LAKE.sales").map(|(p, _)| p), Some(dir.join("loc")));
    assert!(ctx.schema_location("sales").is_none() && ctx.schema_location("lake.main").is_none());
    run(&ctx, "create schema sales");
    run(&ctx, "create table sales.t using parquet as select 6 as v");
    assert!(Path::new(&wh).join("sales/t").is_dir());
    run(&ctx, "create table lake.sales.u using parquet as select 7 as v");
    assert!(Path::new(&dir.join("loc/u")).is_dir() && !Path::new(&wh).join("_catalogs/lake/sales/u").exists());
    assert!(ctx.fork().schema_location("lake.sales").is_some());
    ctx.set_schema_location("lake.sales", None, &Default::default()).unwrap();
    assert!(ctx.schema_location("lake.sales").is_none());
    assert!(ctx.set_schema_location("a.b.c", Some("x"), &Default::default()).is_err());
}

#[test]
fn a_default_catalog_with_another_name_keeps_the_default_layout() {
    let dir = Dir::new("custom-default");
    let wh = dir.join("wh");
    let ctx = SessionContext::with_default_catalog("lake").unwrap();
    ctx.set_warehouse(Some(&wh), &Default::default());
    run(&ctx, "create schema s");
    run(&ctx, "create catalog main");
    run(&ctx, "create table t using parquet as select 1 as v");
    run(&ctx, "create table s.t using parquet as select 2 as v");
    run(&ctx, "create table main.main.t using parquet as select 3 as v");
    assert!(Path::new(&wh).join("t").is_dir() && Path::new(&wh).join("s/t").is_dir());
    assert!(Path::new(&wh).join("_catalogs/main/main/t").is_dir());
    assert_eq!(scalar(&ctx, "select v from t"), "1");
    assert_eq!(scalar(&ctx, "select v from lake.main.t"), "1");
    assert_eq!(scalar(&ctx, "select v from main.main.t"), "3");
    ctx.set_schema_location("s", Some(&dir.join("loc")), &Default::default()).unwrap();
    assert_eq!(ctx.schema_location("lake.s").map(|(p, _)| p), Some(dir.join("loc")));
}
