//! DELETE / UPDATE / MERGE and the maintenance statements through SQL, and views over Delta tables.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::Int64Array;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use iara_core::{Params, Scalar, SessionContext};

use crate::support::dir::TempDir;

fn run(ctx: &SessionContext, q: &str) -> String {
    let (_, batches) = ctx.sql(q).unwrap().collect().unwrap();
    arrow::util::pretty::pretty_format_batches(&batches).unwrap().to_string()
}

fn run_with(ctx: &SessionContext, q: &str, p: &Params) -> String {
    let (_, batches) = ctx.sql_with(q, p).unwrap().collect().unwrap();
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

fn warehouse() -> (TempDir, SessionContext) {
    let dir = TempDir::new("sqldml");
    let ctx = SessionContext::new();
    let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, false), Field::new("v", DataType::Int64, false)]));
    let ids: Vec<i64> = (0..10).collect();
    let vs: Vec<i64> = ids.iter().map(|i| i * 10).collect();
    let b = RecordBatch::try_new(schema.clone(), vec![Arc::new(Int64Array::from(ids)), Arc::new(Int64Array::from(vs))]).unwrap();
    ctx.register_batches("src", schema, vec![b]);
    ctx.set_warehouse(Some(&dir.join("wh")), &Default::default());
    run(&ctx, "create table t as select * from src");
    (dir, ctx)
}

#[test]
fn delete_update_with_params_and_alias() {
    let (_dir, ctx) = warehouse();
    let named = Params::Named(HashMap::from([("lo".to_string(), Scalar::int64(8))]));
    let out = run_with(&ctx, "delete from t as x where x.id >= :lo", &named);
    assert!(out.contains("num_affected_rows"), "{out}");
    assert_eq!(scalar(&ctx, "select count(*) from t"), "8");
    let pos = Params::Positional(vec![Scalar::int64(2), Scalar::int64(1)]);
    run_with(&ctx, "update t set v = v + $1 where id = $2", &pos);
    assert_eq!(scalar(&ctx, "select v from t where id = 1"), "12");
    run(&ctx, "update t as a set v = case when a.id > 5 then -1 else a.v end, id = id where a.id in (6, 7)");
    assert_eq!(scalar(&ctx, "select sum(v) from t where id in (6, 7)"), "-2");
    // no predicate: all rows
    run(&ctx, "update t set v = 0");
    assert_eq!(scalar(&ctx, "select sum(v) from t"), "0");
    run(&ctx, "delete from t");
    assert_eq!(scalar(&ctx, "select count(*) from t"), "0");
}

#[test]
fn merge_upsert_through_sql() {
    let (_dir, ctx) = warehouse();
    run(&ctx, "create table s2 as select id + 5 as id, 1 as v from src");
    let out = run(
        &ctx,
        "merge into t using s2 on t.id = s2.id \
         when matched and s2.id = 9 then delete \
         when matched then update set v = s2.v \
         when not matched then insert (id, v) values (s2.id, s2.v * 100)",
    );
    assert!(out.contains("merge"), "{out}");
    // ids 0..5 untouched, 5..9 now v=1, 9 deleted, 10..14 inserted with v=100
    assert_eq!(scalar(&ctx, "select count(*) from t"), "14");
    assert_eq!(scalar(&ctx, "select sum(v) from t where id between 5 and 8"), "4");
    assert_eq!(scalar(&ctx, "select count(*) from t where id = 9"), "0");
    assert_eq!(scalar(&ctx, "select sum(v) from t where id >= 10"), "500");
    // star forms, a subquery source and BY SOURCE
    run(
        &ctx,
        "merge into t as tgt using (select id, 7 as v from src where id < 3) as s on tgt.id = s.id \
         when matched then update set * \
         when not matched by target then insert * \
         when not matched by source and tgt.id >= 10 then delete",
    );
    assert_eq!(scalar(&ctx, "select count(*) from t where id >= 10"), "0");
    assert_eq!(scalar(&ctx, "select sum(v) from t where id < 3"), "21");
    let named = Params::Named(HashMap::from([("n".to_string(), Scalar::int64(3))]));
    run_with(&ctx, "merge into t using (select 99 as id, :n as v) s on t.id = s.id when not matched then insert *", &named);
    assert_eq!(scalar(&ctx, "select v from t where id = 99"), "3");
}

#[test]
fn parquet_tables_are_refused() {
    let (dir, ctx) = warehouse();
    run(&ctx, &format!("copy (select * from src) to '{}' (format parquet)", dir.join("p.parquet")));
    ctx.register_parquet("p", &dir.join("p.parquet")).unwrap();
    for q in [
        "delete from p",
        "update p set v = 1",
        "merge into p using src on p.id = src.id when matched then delete",
        "optimize p",
        "vacuum p",
        "alter table p add column x int",
    ] {
        let e = error(&ctx, q);
        assert!(e.contains("Delta table"), "{q}: {e}");
    }
}

#[test]
fn history_detail_optimize_vacuum_restore() {
    let (_dir, ctx) = warehouse();
    run(&ctx, "insert into t select id + 100, v from src");
    run(&ctx, "delete from t where id = 0");
    let history = run(&ctx, "describe history t");
    for op in ["DELETE", "WRITE"] {
        assert!(history.contains(op), "{history}");
    }
    assert_eq!(scalar(&ctx, "select count(*) from (select * from t) x"), "19");
    let limited = run(&ctx, "describe history t limit 2");
    assert_eq!(limited.matches("| WRITE").count() + limited.matches("| DELETE").count(), 2, "{limited}");
    assert!(run(&ctx, "describe detail t").contains("delta"));
    // optimize compacts the small files; the table reads the same
    let out = run(&ctx, "optimize t");
    assert!(out.contains("optimize"), "{out}");
    assert_eq!(scalar(&ctx, "select count(*) from t"), "19");
    // vacuum: a dry run lists, a short retention is refused without FORCE
    let dry = run(&ctx, "vacuum t dry run");
    assert!(dry.contains("vacuum"), "{dry}");
    assert!(error(&ctx, "vacuum t retain 0 hours").to_lowercase().contains("retention"));
    run(&ctx, "vacuum t retain 0 hours dry run force");
    // restore
    run(&ctx, "restore table t to version as of 0");
    assert_eq!(scalar(&ctx, "select count(*) from t"), "10");
    run(&ctx, "restore t to timestamp as of '2099-01-01'");
    assert_eq!(scalar(&ctx, "select count(*) from t"), "10");
}

#[test]
fn alter_table_statements() {
    let (_dir, ctx) = warehouse();
    run(&ctx, "alter table t add column note text");
    run(&ctx, "alter table t add columns (a int, b double)");
    assert_eq!(scalar(&ctx, "select count(note) from t"), "0");
    assert_eq!(scalar(&ctx, "select count(*) from (select * from t limit 1) x where a is null and b is null"), "1");
    run(&ctx, "update t set note = 'x' where id = 1");
    assert_eq!(scalar(&ctx, "select note from t where id = 1"), "x");
    run(&ctx, "alter table t set tblproperties ('k' = 'v', 'delta.logRetentionDuration' = 'interval 30 days')");
    assert!(run(&ctx, "describe detail t").contains("k"), "properties");
    run(&ctx, "alter table t unset tblproperties if exists ('k', 'missing')");
    run(&ctx, "comment on table t is 'sales'");
    assert!(run(&ctx, "describe detail t").contains("sales"));
    assert!(error(&ctx, "alter table t rename column a to c").to_lowercase().contains("not supported"));
    assert!(error(&ctx, "alter table nope add column a int").contains("not found"));
}

#[test]
fn views_and_frames_see_later_writes() {
    let (_dir, ctx) = warehouse();
    run(&ctx, "create view big as select * from t where id >= 5");
    let frame = ctx.sql("select count(*) from t").unwrap();
    assert_eq!(scalar(&ctx, "select count(*) from big"), "5");
    run(&ctx, "insert into t select id + 100, v from src");
    assert_eq!(scalar(&ctx, "select count(*) from big"), "15");
    run(&ctx, "delete from t where id >= 100");
    run(&ctx, "update t set v = 1 where id = 5");
    assert_eq!(scalar(&ctx, "select sum(v) from big where id = 5"), "1");
    // a frame planned before the writes reads the table as it is when it runs
    let (_, batches) = frame.collect().unwrap();
    assert_eq!(arrow::util::display::array_value_to_string(batches[0].column(0), 0).unwrap(), "10");
    // time travel is pinned
    assert_eq!(scalar(&ctx, "select count(*) from t version as of 0"), "10");
}
