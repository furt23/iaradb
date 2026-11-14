//! A hash join's build keys as a filter on the scan of the probe table:
//! results equal those over the same data in memory (whose scan takes no
//! such filter), the filter is only planned for joins that drop unmatched
//! probe rows, and a scan using it keeps every row whose key matches.

use std::collections::HashSet;
use std::sync::Arc;

use arrow::array::{ArrayRef, AsArray, Date32Array, Float64Array, Int32Array, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Int64Type, Schema, SchemaRef};
use arrow::record_batch::RecordBatch;
use iara_core::SessionContext;
use iara_core::exec::join::JoinHashTable;
use iara_core::exec::join_filter::JoinKeyFilter;
use iara_core::io::parquet::{ParquetTable, write_parquet};
use iara_core::io::{ScanJoinKeys, TableProvider};

use crate::support::dir::TempDir;
use crate::support::render;

const N: i64 = 60_000;
const ROW_GROUP: i64 = 10_000;
/// distinct probe keys (the dim table has more, which no probe row has)
const KEYS: i64 = 4_000;
const DIM_KEYS: i64 = 5_000;

/// The probe key of row `i`: every 97th is NULL.
fn key(i: i64) -> Option<i64> {
    (i % 97 != 0).then(|| (i * 7919) % KEYS)
}

fn selected(k: i64) -> bool {
    k % 500 == 7
}

fn probe_schema() -> SchemaRef {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("k64", DataType::Int64, true),
        Field::new("k32", DataType::Int32, true),
        Field::new("g", DataType::Int64, false),
        Field::new("s", DataType::Utf8, true),
        Field::new("v", DataType::Float64, false),
        Field::new("d", DataType::Date32, false),
    ]))
}

fn probe_batch(first: i64, rows: i64) -> RecordBatch {
    let ids: Vec<i64> = (first..first + rows).collect();
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(ids.clone())),
        Arc::new(Int64Array::from(ids.iter().map(|&i| key(i)).collect::<Vec<_>>())),
        Arc::new(Int32Array::from(ids.iter().map(|&i| key(i).map(|k| k as i32)).collect::<Vec<_>>())),
        Arc::new(Int64Array::from(ids.iter().map(|&i| i % 3).collect::<Vec<_>>())),
        Arc::new(StringArray::from(ids.iter().map(|&i| (i % 53 != 0).then(|| format!("row-{i}"))).collect::<Vec<_>>())),
        Arc::new(Float64Array::from(ids.iter().map(|&i| (i % 1000) as f64 * 0.5).collect::<Vec<_>>())),
        Arc::new(Date32Array::from(ids.iter().map(|&i| 18_000 + (i % 400) as i32).collect::<Vec<_>>())),
    ];
    RecordBatch::try_new(probe_schema(), cols).unwrap()
}

/// The dim table: keys 0..DIM_KEYS and a row with NULL keys; `dflag` is 1 on
/// the keys `selected` and on the NULL row.
fn dim_batch() -> (SchemaRef, RecordBatch) {
    let schema = Arc::new(Schema::new(vec![
        Field::new("dk", DataType::Int64, true),
        Field::new("dk32", DataType::Int32, true),
        Field::new("dflag", DataType::Int64, false),
        Field::new("dg", DataType::Int64, false),
        Field::new("dname", DataType::Utf8, false),
        Field::new("dx", DataType::Float64, false),
        Field::new("dd", DataType::Date32, false),
    ]));
    let ks: Vec<Option<i64>> = (0..DIM_KEYS).map(Some).chain([None]).collect();
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(ks.clone())),
        Arc::new(Int32Array::from(ks.iter().map(|k| k.map(|k| k as i32)).collect::<Vec<_>>())),
        Arc::new(Int64Array::from(ks.iter().map(|k| k.is_none_or(selected) as i64).collect::<Vec<_>>())),
        Arc::new(Int64Array::from(ks.iter().map(|k| k.unwrap_or(0) % 3).collect::<Vec<_>>())),
        Arc::new(StringArray::from(ks.iter().map(|k| format!("row-{}", k.unwrap_or(-1))).collect::<Vec<_>>())),
        Arc::new(Float64Array::from(ks.iter().map(|k| (k.unwrap_or(0) % 10) as f64 * 50.0).collect::<Vec<_>>())),
        Arc::new(Date32Array::from(ks.iter().map(|k| 18_000 + (k.unwrap_or(0) % 400) as i32).collect::<Vec<_>>())),
    ];
    (schema.clone(), RecordBatch::try_new(schema, cols).unwrap())
}

/// `probe` (Parquet, six row groups) and `probe_mem` (the same rows in
/// memory) next to `dim`.
fn setup(dir: &TempDir) -> (SessionContext, String) {
    let batches: Vec<RecordBatch> = (0..N / ROW_GROUP).map(|g| probe_batch(g * ROW_GROUP, ROW_GROUP)).collect();
    let path = dir.join("probe.parquet");
    write_parquet(&path, probe_schema(), &batches, "zstd", Some(ROW_GROUP as usize)).unwrap();
    let ctx = SessionContext::new();
    ctx.register_parquet("probe", &path).unwrap();
    ctx.register_batches("probe_mem", probe_schema(), batches).unwrap();
    let (schema, dim) = dim_batch();
    ctx.register_batches("dim", schema, vec![dim]).unwrap();
    (ctx, path)
}

fn rows(ctx: &SessionContext, sql: &str) -> Vec<String> {
    let (_, batches) = ctx.sql(sql).unwrap().collect().unwrap();
    let mut out: Vec<String> = render(&batches).split('|').map(str::to_string).collect();
    out.sort();
    out
}

fn plan(ctx: &SessionContext, sql: &str) -> String {
    ctx.sql(sql).unwrap().explain(true).unwrap()
}

/// `template` over the Parquet table (`{p}`) gives the rows it gives over the
/// table in memory, and its plan has the join filter on `column` (None: no join
/// filter at all). Returns the rows.
fn check(ctx: &SessionContext, template: &str, column: Option<&str>) -> Vec<String> {
    let (pq, mem) = (template.replace("{p}", "probe"), template.replace("{p}", "probe_mem"));
    // the scan alternates between filtering early and not: the same query runs twice
    let want = rows(ctx, &mem);
    for _ in 0..2 {
        assert_eq!(rows(ctx, &pq), want, "{template}");
    }
    let plan = plan(ctx, &pq);
    match column {
        Some(c) => {
            let marker = format!("join_filter=[{c}]");
            assert!(plan.matches(&marker).count() == 2, "{marker} on the join and the scan in\n{plan}");
        }
        None => assert!(!plan.contains("join_filter"), "no join filter in\n{plan}"),
    }
    assert!(!self::plan(ctx, &mem).contains("join_filter"), "{template}");
    want
}

/// (rows, sum of ids) of the probe rows whose key is selected.
fn expected() -> (i64, i64) {
    (0..N).filter(|&i| key(i).is_some_and(selected)).fold((0, 0), |(n, s), i| (n + 1, s + i))
}

#[test]
fn inner_join_on_a_selective_build_side() {
    let dir = TempDir::new("jf-inner");
    let (ctx, _) = setup(&dir);
    let (n, sum) = expected();
    assert!(n > 100 && n < N / 100, "a selective join: {n} rows");
    let got = check(&ctx, "select count(*) as n, sum(p.id) as s from {p} p join dim d on p.k64 = d.dk where d.dflag = 1", Some("k64"));
    assert_eq!(got, vec![format!("{n},{sum}")]);
    // the other columns of the rows that join
    let got = check(&ctx, "select p.id, p.s, p.v, p.d, d.dname from {p} p join dim d on p.k64 = d.dk where d.dflag = 1", Some("k64"));
    assert_eq!(got.len() as i64, n);
    // the build side first in the query text
    check(&ctx, "select count(*) as n, sum(p.id) as s from dim d join {p} p on d.dk = p.k64 where d.dflag = 1", Some("k64"));
    // a filter on the probe table too
    check(&ctx, "select count(*), sum(p.id) from {p} p join dim d on p.k64 = d.dk where d.dflag = 1 and p.v > 100 and p.s like 'row-1%'", Some("k64"));
}

#[test]
fn key_types_are_cast_to_the_build_keys() {
    let dir = TempDir::new("jf-types");
    let (ctx, _) = setup(&dir);
    // Int32 probe keys against Int64 build keys, and the other way round
    check(&ctx, "select count(*), sum(p.id) from {p} p join dim d on p.k32 = d.dk where d.dflag = 1", Some("k32"));
    check(&ctx, "select count(*), sum(p.id) from {p} p join dim d on p.k64 = d.dk32 where d.dflag = 1", Some("k64"));
    check(&ctx, "select count(*), sum(p.id) from {p} p join dim d on p.k32 = d.dk32 where d.dflag = 1", Some("k32"));
    // dates
    check(&ctx, "select count(*), sum(p.id) from {p} p join dim d on p.d = d.dd where d.dflag = 1", Some("d"));
    // a cast that keeps the values
    check(&ctx, "select count(*), sum(p.id) from {p} p join dim d on cast(p.k32 as bigint) = d.dk where d.dflag = 1", Some("k32"));
    // casts that change them, strings
    check(&ctx, "select count(*), sum(p.id) from {p} p join dim d on cast(p.k64 as int) = d.dk32 where d.dflag = 1", None);
    check(&ctx, "select count(*), sum(p.id) from {p} p join dim d on p.s = d.dname where d.dflag = 1", None);
}

#[test]
fn the_key_reaches_the_scan_through_filters_and_projections() {
    let dir = TempDir::new("jf-through");
    let (ctx, _) = setup(&dir);
    check(
        &ctx,
        "select count(*), sum(q.id) from (select id as id, k64 as kk, v from {p} where v > 100) q join dim d on q.kk = d.dk where d.dflag = 1",
        Some("k64"),
    );
    // not through an aggregate, a limit or a window
    check(&ctx, "select count(*), sum(q.m) from (select k64 as kk, max(id) as m from {p} group by k64) q join dim d on q.kk = d.dk where d.dflag = 1", None);
    check(&ctx, "select count(*), sum(q.id) from (select id, k64 as kk from {p} limit 30000) q join dim d on q.kk = d.dk where d.dflag = 1", None);
}

#[test]
fn only_a_single_column_key_is_filtered() {
    let dir = TempDir::new("jf-keys");
    let (ctx, _) = setup(&dir);
    // a computed key, several keys
    check(&ctx, "select count(*), sum(p.id) from {p} p join dim d on p.k64 + 1 = d.dk where d.dflag = 1", None);
    check(&ctx, "select count(*), sum(p.id) from {p} p join dim d on p.k64 = d.dk and p.g = d.dg where d.dflag = 1", None);
    // a residual condition on the joined rows
    check(&ctx, "select count(*), sum(p.id) from {p} p join dim d on p.k64 = d.dk and p.v > d.dx where d.dflag = 1", Some("k64"));
}

#[test]
fn semi_joins_drop_the_rows_that_do_not_match() {
    let dir = TempDir::new("jf-semi");
    let (ctx, _) = setup(&dir);
    let (n, sum) = expected();
    let got = check(&ctx, "select count(*), sum(p.id) from {p} p where p.k64 in (select dk from dim where dflag = 1)", Some("k64"));
    assert_eq!(got, vec![format!("{n},{sum}")]);
    check(&ctx, "select count(*), sum(p.id) from {p} p where exists (select 1 from dim d where d.dk = p.k64 and d.dflag = 1)", Some("k64"));
    // the preserved side built, the probe side only marks its rows
    check(
        &ctx,
        "select count(*), sum(d.dk) from dim d where d.dflag = 1 and exists (select 1 from {p} p where p.k64 = d.dk and p.v > d.dx)",
        Some("k64"),
    );
    // the scan reads only the key and the filter's column: `s` is decoded for the rows whose key matches
    check(&ctx, "select count(*), sum(d.dk) from dim d where d.dflag = 1 and d.dk in (select k64 from {p} where s is not null)", Some("k64"));
}

#[test]
fn anti_joins_keep_the_rows_that_do_not_match() {
    let dir = TempDir::new("jf-anti");
    let (ctx, _) = setup(&dir);
    // the probe side is preserved: nothing may be dropped
    let got = check(&ctx, "select count(*) from {p} p where not exists (select 1 from dim d where d.dk = p.k64 and d.dflag = 1)", None);
    let (n, _) = expected();
    assert_eq!(got, vec![format!("{}", N - n)]);
    // the build side is the preserved one, the probe side only marks it
    check(
        &ctx,
        "select count(*), sum(d.dk) from dim d where d.dflag = 1 and not exists (select 1 from {p} p where p.k64 = d.dk and p.v > d.dx)",
        Some("k64"),
    );
}

#[test]
fn outer_joins_filter_only_when_the_probe_side_is_not_preserved() {
    let dir = TempDir::new("jf-outer");
    let (ctx, _) = setup(&dir);
    // the probe rows are all kept, matched or not
    let got = check(&ctx, "select count(*) as n, count(d.dk) as m from {p} p left join (select dk from dim where dflag = 1) d on p.k64 = d.dk", None);
    let (n, _) = expected();
    assert_eq!(got, vec![format!("{N},{n}")]);
    check(&ctx, "select count(*), count(d.dk) from (select dk from dim where dflag = 1) d right join {p} p on p.k64 = d.dk", None);
    check(&ctx, "select count(*), count(d.dk), count(p.id) from {p} p full join (select dk from dim where dflag = 1) d on p.k64 = d.dk", None);
    // the build rows are kept, with or without a match: unmatched probe rows go
    let got = check(&ctx, "select count(*) as n, count(p.id) as m from (select dk from dim where dflag = 1) d left join {p} p on p.k64 = d.dk", Some("k64"));
    let unmatched = (0..DIM_KEYS).filter(|&k| selected(k) && k >= KEYS).count() as i64 + 1; // the NULL key row
    assert_eq!(got, vec![format!("{},{n}", n + unmatched)]);
    check(&ctx, "select count(*), count(p.id) from {p} p right join (select dk from dim where dflag = 1) d on p.k64 = d.dk", Some("k64"));
}

#[test]
fn a_recursive_term_filters_with_each_round_s_keys() {
    let dir = TempDir::new("jf-recursive");
    let (ctx, _) = setup(&dir);
    // the work table is the build side, and different in every round: a round
    // finds the one row with id k, and its id + 1 is the next round's key
    let got = check(
        &ctx,
        "with recursive r(k) as (select 7 union select p.id + 1 from r join {p} p on p.id = r.k and p.v > r.k - 1000 where r.k < 60) select count(*), sum(k) from r",
        Some("id"),
    );
    assert_eq!(got, vec!["54,1809".to_string()]);
}

/// Every row of a scan with the key filter set whose key is among the build
/// keys comes out, and the row groups filtered early send fewer of the others.
#[test]
fn a_scan_keeps_the_rows_that_match() {
    let dir = TempDir::new("jf-scan");
    let (_, path) = setup(&dir);
    let table = ParquetTable::try_new(&path).unwrap();
    let wanted: Vec<i64> = (0..DIM_KEYS).filter(|&k| selected(k)).collect();
    let keys: ArrayRef = Arc::new(Int64Array::from(wanted.clone()));
    let build = RecordBatch::try_from_iter([("k", keys.clone())]).unwrap();
    let hash = Arc::new(JoinHashTable::build(build, vec![keys], false).unwrap());
    let filter = Arc::new(JoinKeyFilter::new("k64", DataType::Int64));
    let gates = [ScanJoinKeys { column: 1, keys: filter.clone() }];
    // id, k64, v: the other columns are decoded for the rows that pass
    let source = table.create_gated_source(Some(&[0, 1, 5]), &[], None, &gates).expect("a Parquet table takes join keys").unwrap();
    assert!(source.describe().contains("join_filter=[k64]"), "{}", source.describe());
    assert!(filter.attached());
    let run = || {
        let mut ids = vec![];
        for m in 0..source.num_morsels() {
            source
                .run_morsel(m, &mut |b: RecordBatch| {
                    ids.extend(b.column(0).as_primitive::<Int64Type>().values().iter().copied());
                    Ok(())
                })
                .unwrap();
        }
        ids
    };
    // before the build side is done, every row comes out
    assert_eq!(run().len() as i64, N);
    filter.set(&hash);
    let matching: HashSet<i64> = (0..N).filter(|&i| key(i).is_some_and(selected)).collect();
    let got = run();
    assert!(matching.iter().all(|i| got.contains(i)), "a matching row was dropped");
    // three of the six row groups filter early
    assert!((got.len() as i64) < N - 20_000, "{} rows of {N}", got.len());
}
