//! A restricted context (`SessionContext::restricted`): queries read only the catalog
//! tables its allow list covers; files, writes and every other statement are refused.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use arrow::array::Int64Array;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use iara_core::SessionContext;
use iara_core::io::memory::MemTable;

use crate::support::dir::TempDir;

fn batch(values: &[i64]) -> (Arc<Schema>, Vec<RecordBatch>) {
    let schema = Arc::new(Schema::new(vec![Field::new("v", DataType::Int64, false)]));
    let b = RecordBatch::try_new(schema.clone(), vec![Arc::new(Int64Array::from(values.to_vec()))]).unwrap();
    (schema, vec![b])
}

fn table(ctx: &SessionContext, name: &str, values: &[i64]) {
    let (schema, batches) = batch(values);
    ctx.register_batches(name, schema, batches).unwrap();
}

/// `open` and `hidden` (main.main), `sales.orders` and `sales.items` (main.sales),
/// `lake.main.events` and `lake.raw.logs`.
fn ctx() -> SessionContext {
    let ctx = SessionContext::new();
    ctx.create_catalog("lake", false).unwrap();
    table(&ctx, "open", &[1, 2, 3]);
    table(&ctx, "hidden", &[10, 20]);
    table(&ctx, "sales.orders", &[100]);
    table(&ctx, "sales.items", &[200, 201]);
    table(&ctx, "lake.main.events", &[7]);
    table(&ctx, "lake.raw.logs", &[8, 9]);
    ctx
}

fn restricted(allow: &[&str]) -> SessionContext {
    ctx().restricted(allow.iter().map(|a| a.to_string()).collect())
}

fn count(ctx: &SessionContext, q: &str) -> String {
    let (_, batches) = ctx.sql(q).unwrap().collect().unwrap();
    arrow::util::display::array_value_to_string(batches[0].column(0), 0).unwrap()
}

fn error(ctx: &SessionContext, q: &str) -> String {
    match ctx.sql(q).and_then(|f| f.collect()) {
        Ok(_) => panic!("{q} should fail"),
        Err(e) => e.to_string(),
    }
}

fn no_grant(ctx: &SessionContext, q: &str, table: &str) {
    assert_eq!(error(ctx, q), format!("Planning error: no read grant on table {table}"), "{q}");
}

const FILES: &str = "Planning error: reading files directly is not allowed here; query a catalog table";
const QUERIES_ONLY: &str = "Planning error: only queries are allowed here";

#[test]
fn a_covered_table_reads_and_an_uncovered_one_is_refused() {
    let ctx = restricted(&["main.main.open"]);
    assert_eq!(count(&ctx, "select count(*) from open"), "3");
    assert_eq!(count(&ctx, "select count(*) from main.main.open"), "3");
    assert_eq!(count(&ctx, "select count(*) from main.open"), "3");
    no_grant(&ctx, "select * from hidden", "main.main.hidden");
    no_grant(&ctx, "select * from sales.orders", "main.sales.orders");
    no_grant(&ctx, "select * from lake.raw.logs", "lake.raw.logs");
    // one uncovered table anywhere in the query is enough
    no_grant(&ctx, "select * from open join hidden on open.v = hidden.v", "main.main.hidden");
    no_grant(&ctx, "select * from (select * from hidden)", "main.main.hidden");
    no_grant(&ctx, "select * from open union all select * from hidden", "main.main.hidden");
}

#[test]
fn entries_cover_everything_below_them() {
    let all = restricted(&["*"]);
    for t in ["open", "hidden", "sales.orders", "lake.main.events", "lake.raw.logs"] {
        count(&all, &format!("select count(*) from {t}"));
    }

    let catalog = restricted(&["main"]);
    count(&catalog, "select count(*) from open");
    count(&catalog, "select count(*) from sales.items");
    no_grant(&catalog, "select * from lake.main.events", "lake.main.events");

    let lake = restricted(&["lake"]);
    count(&lake, "select count(*) from lake.main.events");
    count(&lake, "select count(*) from lake.raw.logs");
    no_grant(&lake, "select * from open", "main.main.open");

    let schema = restricted(&["main.sales"]);
    count(&schema, "select count(*) from sales.orders");
    count(&schema, "select count(*) from sales.items");
    no_grant(&schema, "select * from open", "main.main.open");
    no_grant(&schema, "select * from lake.raw.logs", "lake.raw.logs");

    let one = restricted(&["main.sales.orders", "lake.main"]);
    count(&one, "select count(*) from sales.orders");
    count(&one, "select count(*) from lake.main.events");
    no_grant(&one, "select * from sales.items", "main.sales.items");
    no_grant(&one, "select * from lake.raw.logs", "lake.raw.logs");
}

#[test]
fn entries_match_whole_names_in_any_case() {
    let ctx = restricted(&[" MAIN.Sales ", "main.main.op"]);
    count(&ctx, "select count(*) from SALES.Orders");
    // `op` is not a prefix grant on `open`; a trailing `.*` is not an entry
    no_grant(&ctx, "select * from open", "main.main.open");
    let ctx = restricted(&["mai", "main.sal", "main.*", ""]);
    no_grant(&ctx, "select * from open", "main.main.open");
    no_grant(&ctx, "select * from sales.orders", "main.sales.orders");
}

#[test]
fn covers_compares_lowercased_names() {
    let policy = restricted(&["lake.raw", "main.main.open"]);
    let policy = policy.read_policy().unwrap();
    assert!(policy.covers("lake", "raw", "logs") && policy.covers("LAKE", "Raw", "LOGS"));
    assert!(policy.covers("main", "main", "open") && !policy.covers("main", "main", "opens"));
    assert!(!policy.covers("lake", "main", "events"));
}

#[test]
fn an_empty_list_refuses_everything_but_constants() {
    let ctx = restricted(&[]);
    assert_eq!(count(&ctx, "select 1"), "1");
    assert_eq!(count(&ctx, "select count(*) from (values (1), (2))"), "2");
    no_grant(&ctx, "select * from open", "main.main.open");
    no_grant(&ctx, "select * from hidden", "main.main.hidden");
    assert!(ctx.table_names().is_empty());
}

#[test]
fn a_cte_named_like_an_uncovered_table_is_not_a_table_read() {
    let ctx = restricted(&["main.sales"]);
    assert_eq!(count(&ctx, "with hidden as (select 1 as v) select count(*) from hidden"), "1");
    // its own definition still reads the table
    no_grant(&ctx, "with hidden as (select * from hidden) select * from hidden", "main.main.hidden");
    no_grant(&ctx, "with recursive hidden(v) as (select v from hidden union all select v + 1 from hidden where v < 3) select * from hidden", "main.main.hidden");
    // a CTE shadows bare names only
    no_grant(&ctx, "with hidden as (select 1 as v) select * from main.main.hidden", "main.main.hidden");
}

#[test]
fn subqueries_are_checked() {
    let ctx = restricted(&["main.main.open"]);
    no_grant(&ctx, "select * from open where v in (select v from hidden)", "main.main.hidden");
    no_grant(&ctx, "select * from open where exists (select 1 from hidden where hidden.v = open.v)", "main.main.hidden");
    no_grant(&ctx, "select * from open where v < (select max(v) from hidden)", "main.main.hidden");
    no_grant(&ctx, "select (select max(v) from hidden) from open", "main.main.hidden");
    no_grant(&ctx, "select * from open where v not in (select v from sales.orders)", "main.sales.orders");
    count(&ctx, "select count(*) from open where v in (select v from open)");
}

#[test]
fn tables_read_lists_the_covered_tables_a_query_read() {
    let r = restricted(&["main.main.open", "lake"]);
    assert!(r.tables_read().is_empty());
    count(&r, "select 1");
    assert!(r.tables_read().is_empty());
    count(&r, "select count(*) from LAKE.Raw.Logs l join open o on l.v = o.v");
    count(&r, "select count(*) from open");
    assert_eq!(r.tables_read(), vec!["lake.raw.logs", "main.main.open"]);
    // a refused table is not a table read
    no_grant(&r, "select * from hidden", "main.main.hidden");
    assert_eq!(r.tables_read(), vec!["lake.raw.logs", "main.main.open"]);
    // nothing is recorded for an unrestricted context
    let base = ctx();
    count(&base, "select count(*) from open");
    assert!(base.tables_read().is_empty());
}

#[test]
fn a_view_is_the_table_read_not_what_it_reads() {
    let base = ctx();
    base.sql("create view v as select * from hidden").unwrap();
    let r = base.restricted(vec!["main.main.v".into()]);
    count(&r, "select count(*) from v");
    assert_eq!(r.tables_read(), vec!["main.main.v"]);
}

#[test]
fn explain_is_a_query_like_any_other() {
    let ctx = restricted(&["main.main.open"]);
    count(&ctx, "explain select * from open");
    count(&ctx, "explain analyze select * from open");
    no_grant(&ctx, "explain select * from hidden", "main.main.hidden");
    no_grant(&ctx, "explain analyze select * from hidden", "main.main.hidden");
}

#[test]
fn files_are_refused_even_with_a_full_grant() {
    for ctx in [restricted(&["main.main.open"]), restricted(&["*"])] {
        for q in [
            "select * from read_parquet('x.parquet')",
            "select * from read_csv('x.csv')",
            "select * from read_json('x.json')",
            "select * from read_delta('some/delta')",
            "select * from read_delta('some/delta', version => 0)",
            "select * from read_parquet('x.parquet') as p where p.v in (select v from open)",
            "select * from open where v in (select v from read_parquet('x.parquet'))",
            "select * from \"some/path.parquet\"",
            "select * from 'some/path.csv'",
            "select * from \"s3://bucket/dir/*.parquet\"",
            "select * from \"C:\\data\\x.parquet\"",
        ] {
            assert_eq!(error(&ctx, q), FILES, "{q}");
        }
        let storage = Default::default();
        assert_eq!(ctx.read_parquet_with("x.parquet", &storage).err().unwrap().to_string(), FILES);
        assert_eq!(ctx.read_csv("x.csv", Default::default()).err().unwrap().to_string(), FILES);
        assert_eq!(ctx.read_delta("d", &storage, None).err().unwrap().to_string(), FILES);
        assert_eq!(iara_core::io::json::read_json(&ctx, "x.json", Default::default(), &storage).err().unwrap().to_string(), FILES);
    }
    // without a policy the same text fails for its own reason
    assert!(!error(&ctx(), "select * from read_parquet('x.parquet')").contains("not allowed here"));
}

#[test]
fn time_travel_checks_the_table() {
    let dir = TempDir::new("policy");
    let ctx = ctx();
    ctx.set_warehouse(Some(&dir.join("wh")), &Default::default());
    ctx.sql("create table secret as select * from hidden").unwrap();
    assert_eq!(count(&ctx, "select count(*) from secret version as of 0"), "2");

    let r = ctx.restricted(vec!["main.main.open".into()]);
    no_grant(&r, "select * from secret version as of 0", "main.main.secret");
    no_grant(&r, "select * from secret timestamp as of '2999-01-01'", "main.main.secret");
    no_grant(&r, "select * from main.main.secret version as of 0 as s", "main.main.secret");
    let r = ctx.restricted(vec!["main.main.secret".into()]);
    assert_eq!(count(&r, "select count(*) from secret version as of 0"), "2");
    assert_eq!(error(&r, &format!("select * from read_delta('{}', version => 0)", dir.join("wh/secret"))), FILES);
}

#[test]
fn views_are_entries_and_what_they_read_is_not_checked_again() {
    let ctx = ctx();
    ctx.sql("create view v as select * from hidden").unwrap();
    let r = ctx.restricted(vec!["main.main.v".into()]);
    assert_eq!(count(&r, "select count(*) from v"), "2");
    no_grant(&r, "select * from hidden", "main.main.hidden");
    // the grant on the table does not cover a view over it
    let r = ctx.restricted(vec!["main.main.hidden".into()]);
    no_grant(&r, "select * from v", "main.main.v");
    assert_eq!(count(&r, "select count(*) from hidden"), "2");
}

#[test]
fn the_grant_is_on_the_table_a_name_resolves_to() {
    let ctx = ctx();
    // `USE` is shared state: `orders` and `open` resolve differently once `sales` is current
    ctx.sql("use sales").unwrap();
    let r = ctx.restricted(vec!["main.main.open".into()]);
    no_grant(&r, "select * from orders", "main.sales.orders");
    assert_eq!(count(&r, "select count(*) from open"), "3");
    let r = ctx.restricted(vec!["main.sales".into()]);
    assert_eq!(count(&r, "select count(*) from orders"), "1");
    no_grant(&r, "select * from open", "main.main.open");
}

#[test]
fn an_uncovered_deferred_table_is_not_loaded() {
    let ctx = ctx();
    let loaded = Arc::new(AtomicBool::new(false));
    let flag = loaded.clone();
    ctx.register_loader("lazy", true, move || {
        flag.store(true, Ordering::SeqCst);
        let (schema, batches) = batch(&[1]);
        Ok(Arc::new(MemTable::new(schema, batches)))
    })
    .unwrap();
    let r = ctx.restricted(vec!["main.main.open".into()]);
    no_grant(&r, "select * from lazy", "main.main.lazy");
    no_grant(&r, "select * from lazy version as of 0", "main.main.lazy");
    assert!(!loaded.load(Ordering::SeqCst));
    let r = ctx.restricted(vec!["main.main.lazy".into()]);
    assert_eq!(count(&r, "select count(*) from lazy"), "1");
    assert!(loaded.load(Ordering::SeqCst));
}

#[test]
fn only_queries_run() {
    let dir = TempDir::new("policy-writes");
    let base = ctx();
    base.set_warehouse(Some(&dir.join("wh")), &Default::default());
    let ctx = base.restricted(vec!["*".into()]);
    for q in [
        "create table t as select * from open",
        "create table t (a bigint)",
        "insert into open select * from open",
        "insert overwrite table open select 1",
        "truncate table open",
        "drop table open",
        "create view v as select * from open",
        "drop view v",
        &format!("copy (select * from open) to '{}'", dir.join("out")),
        "delete from open where v = 1",
        "update open set v = 0",
        "merge into open using open as s on open.v = s.v when matched then delete",
        "optimize open",
        "vacuum open",
        "describe open",
        "describe history open",
        "show tables",
        "show schemas",
        "show catalogs",
        "show columns from open",
        "use sales",
        "use catalog lake",
        "create schema s",
        "drop schema sales cascade",
        "create catalog c",
        "drop catalog lake cascade",
        "alter table open add columns (w bigint)",
        "restore table open to version as of 0",
    ] {
        assert_eq!(error(&ctx, q), QUERIES_ONLY, "{q}");
    }
    // nothing happened
    assert!(!base.contains("t") && !base.contains("v"));
    assert_eq!(base.current_schema(), "main");
    assert!(base.has_catalog("lake") && !base.has_catalog("c") && base.has_schema("main", "sales"));
    assert_eq!(count(&base, "select count(*) from open"), "3");
    assert!(!std::path::Path::new(&dir.join("out")).exists());
    // a statement that does not parse is not run either
    assert!(ctx.sql("create table").is_err());
}

#[test]
fn the_not_found_message_lists_only_covered_tables() {
    let r = restricted(&["main.main.open", "lake.raw"]);
    let e = error(&r, "select * from nope");
    assert_eq!(e, "Planning error: table 'nope' not found (registered: [\"lake.raw.logs\", \"open\"])");
    let e = error(&r, "select * from ghost.t");
    assert!(e.contains("schema 'ghost' does not exist") && e.contains("lake.raw.logs") && e.contains("open"), "{e}");
    for hidden in ["hidden", "orders", "items", "events"] {
        assert!(!e.contains(hidden), "{e}");
    }
    assert_eq!(r.table_names(), vec!["lake.raw.logs", "open"]);
    assert_eq!(ctx().table_names().len(), 6);
}

#[test]
fn a_fork_stays_restricted() {
    let r = restricted(&["main.main.open"]);
    let fork = r.fork();
    assert_eq!(count(&fork, "select count(*) from open"), "3");
    no_grant(&fork, "select * from hidden", "main.main.hidden");
    assert_eq!(error(&fork, "create table t as select 1"), QUERIES_ONLY);
    assert_eq!(error(&fork, "select * from read_parquet('x.parquet')"), FILES);
    no_grant(&fork.fork(), "select * from hidden", "main.main.hidden");
    assert!(fork.read_policy().unwrap().covers("main", "main", "open"));
}

#[test]
fn restricting_leaves_the_original_alone_and_shares_its_tables() {
    let base = ctx();
    let r = base.restricted(vec!["main.main.late".into()]);
    assert!(base.read_policy().is_none());
    assert_eq!(count(&base, "select count(*) from hidden"), "2");
    // the same state: a table registered later is there, and covered
    table(&base, "late", &[1, 2, 3, 4]);
    assert_eq!(count(&r, "select count(*) from late"), "4");
    no_grant(&r, "select * from hidden", "main.main.hidden");
    // an unrestricted context still writes, and files fail for their own reason
    base.sql("create view w as select 1 as x").unwrap();
    assert!(base.contains("w"));
    assert_eq!(count(&base, "select count(*) from w"), "1");
    assert!(!error(&base, "select * from \"nowhere/x.parquet\"").contains("not allowed here"));
}
