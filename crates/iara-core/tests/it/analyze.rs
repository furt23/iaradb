//! `EXPLAIN ANALYZE`: per-operator metrics of a run. The operators' row
//! counts must be the real ones, a plain run must not measure anything, and
//! measuring must not change what the query does.

use std::sync::Arc;

use arrow::array::{ArrayRef, AsArray, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use iara_core::SessionContext;
use iara_core::exec::metrics::PlanMetrics;
use iara_core::physical::analyze::{AnalyzedNode, analyze, analyzed_plan};

const FACTS: i64 = 200_000;
const DIMS: i64 = 100;

fn context() -> SessionContext {
    let ctx = SessionContext::new();
    let schema = Arc::new(Schema::new(vec![Field::new("k", DataType::Int64, false), Field::new("v", DataType::Int64, false)]));
    let batches = (0..FACTS)
        .step_by(50_000)
        .map(|start| {
            let ids: Vec<i64> = (start..(start + 50_000).min(FACTS)).collect();
            let cols: Vec<ArrayRef> = vec![
                Arc::new(Int64Array::from(ids.iter().map(|i| i % DIMS).collect::<Vec<_>>())),
                Arc::new(Int64Array::from(ids.iter().map(|i| i % 1000).collect::<Vec<_>>())),
            ];
            RecordBatch::try_new(schema.clone(), cols).unwrap()
        })
        .collect();
    ctx.register_batches("facts", schema, batches);
    let schema = Arc::new(Schema::new(vec![Field::new("k", DataType::Int64, false), Field::new("name", DataType::Utf8, false)]));
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from((0..DIMS).collect::<Vec<_>>())),
        Arc::new(StringArray::from((0..DIMS).map(|i| format!("dim-{i:03}")).collect::<Vec<_>>())),
    ];
    ctx.register_batches("dims", schema.clone(), vec![RecordBatch::try_new(schema, cols).unwrap()]);
    ctx
}

fn nodes(n: &AnalyzedNode) -> Vec<&AnalyzedNode> {
    let mut out = vec![n];
    for c in &n.children {
        out.extend(nodes(c));
    }
    out
}

fn rows_of(n: &AnalyzedNode) -> u64 {
    n.metrics.as_ref().unwrap_or_else(|| panic!("{} has no metrics", n.detail)).rows_out
}

const JOIN_AGG: &str = "select d.name, count(*) as n, sum(f.v) as total from facts f join dims d on f.k = d.k where f.v < 500 group by d.name";

#[test]
fn a_join_and_aggregate_report_their_real_row_counts() {
    let ctx = context();
    let a = analyze(&ctx.sql(JOIN_AGG).unwrap().plan).unwrap();
    let all = nodes(&a.plan);
    for n in &all {
        let m = n.metrics.as_ref().unwrap_or_else(|| panic!("no metrics on {}", n.detail));
        assert!(m.elapsed_ms >= 0.0);
    }
    let named = |name: &str| all.iter().copied().filter(|n| n.name == name).collect::<Vec<_>>();

    // 100 groups come out
    let agg = named("HashAggregate");
    assert_eq!(agg.len(), 1);
    assert_eq!(rows_of(agg[0]), DIMS as u64);
    assert_eq!(a.rows, DIMS as u64);
    // half of the facts pass `v < 500`, and every one finds its dimension
    let expected = (0..FACTS).filter(|i| i % 1000 < 500).count() as u64;
    let filters = named("Filter");
    assert_eq!(filters.len(), 1, "{:?}", all.iter().map(|n| &n.detail).collect::<Vec<_>>());
    assert_eq!(rows_of(filters[0]), expected);
    assert_eq!(rows_of(named("HashJoin")[0]), expected);
    // the scans: all the facts (the filter is a node of its own) and all the dimensions
    let mut scans: Vec<u64> = all.iter().filter(|n| n.children.is_empty()).map(|n| rows_of(n)).collect();
    scans.sort_unstable();
    assert_eq!(scans, vec![DIMS as u64, FACTS as u64]);
    // batches are counted too
    assert!(all.iter().all(|n| n.metrics.as_ref().unwrap().batches >= 1));
}

#[test]
fn the_analyzed_plan_has_the_shape_of_the_plan_tree() {
    let ctx = context();
    let lf = ctx.sql(JOIN_AGG).unwrap();
    fn shape(n: &iara_core::physical::planner::PlanNode, out: &mut Vec<(String, Option<&'static str>)>) {
        out.push((n.detail.clone(), n.role));
        n.children.iter().for_each(|c| shape(c, out));
    }
    let mut want = vec![];
    shape(&lf.plan_tree().unwrap(), &mut want);
    let got: Vec<_> = nodes(&analyze(&lf.plan).unwrap().plan).iter().map(|n| (n.detail.clone(), n.role)).collect();
    assert_eq!(got, want);
}

#[test]
fn a_plain_run_measures_nothing() {
    let ctx = context();
    let lf = ctx.sql(JOIN_AGG).unwrap();
    let phys = lf.physical_plan().unwrap();
    let metrics = PlanMetrics::new(phys.node_count());
    let (_, plain) = lf.stream(&mut |_| Ok(()), &mut |_| Ok(())).unwrap();
    // no counters were wired to the run
    assert!(nodes(&analyzed_plan(&phys.tree(), &metrics)).iter().all(|n| n.metrics.is_none()));

    // the wrappers of an analyzed run are transparent: the same pipelines, as the profile shows them
    let analyzed = analyze(&lf.plan).unwrap().stats;
    let shape = |s: &iara_core::exec::query::QueryStats| {
        s.pipelines.iter().map(|p| (p.source.clone(), p.operators.clone(), p.sink.clone(), p.rows_in, p.rows_out)).collect::<Vec<_>>()
    };
    assert_eq!(shape(&analyzed), shape(&plain));
}

#[test]
fn every_kind_of_node_reports_and_the_root_counts_the_result() {
    let ctx = context();
    let queries = [
        "select * from facts where v = 7",
        "select name from dims order by name desc limit 5",
        "select * from facts order by v desc, k limit 10",
        "select k, v from facts order by v, k",
        "select k from facts where v < 3 union all select k from dims",
        "select k, row_number() over (partition by k order by v) as rn from facts where v < 50",
        "select f.k from facts f where exists (select 1 from dims d where d.k = f.k and d.k < 10)",
        "select count(*) from facts f where f.k not in (select k from dims where k < 90)",
        // the small side is the one kept: semi / anti joins that mark build rows
        "select d.name from dims d where d.k in (select k from facts where v < 5)",
        "select d.name from dims d where not exists (select 1 from facts f where f.k = d.k and f.v < 5 and d.k < 50)",
        "select d.name, f.v from dims d left join facts f on d.k = f.k and f.v = 1",
        "select count(*) from dims a, dims b where a.k < b.k",
        "select a.k, b.k from (select k from dims where k < 10) a full join (select k from dims where k > 5 and k < 20) b on a.k = b.k",
        "with recursive r(n) as (select 1 union all select n + 1 from r where n < 20) select n from r",
        "select k from facts offset 1000 limit 20",
        "select 1 as one",
    ];
    for q in queries {
        let lf = ctx.sql(q).unwrap_or_else(|e| panic!("{q}: {e}"));
        let (_, batches) = lf.collect().unwrap();
        let want: usize = batches.iter().map(|b| b.num_rows()).sum();
        let a = analyze(&lf.plan).unwrap_or_else(|e| panic!("{q}: {e}"));
        for n in nodes(&a.plan) {
            assert!(n.metrics.is_some(), "{q}: no metrics on {}", n.detail);
        }
        assert_eq!(a.rows, want as u64, "{q}");
        assert_eq!(rows_of(&a.plan), want as u64, "{q}: the root's rows_out");
    }
}

fn text_of(batches: &[RecordBatch]) -> String {
    assert_eq!(batches.len(), 1);
    let b = &batches[0];
    assert_eq!(b.schema().fields().iter().map(|f| f.name().as_str()).collect::<Vec<_>>(), ["plan"]);
    assert_eq!(b.num_rows(), 1);
    b.column(0).as_string::<i32>().value(0).to_string()
}

#[test]
fn explain_analyze_runs_the_query_and_shows_rows_and_time() {
    let ctx = context();
    let (_, batches) = ctx.sql(&format!("explain analyze {JOIN_AGG}")).unwrap().collect().unwrap();
    let text = text_of(&batches);
    for needle in ["HashAggregate", "HashJoin", "Filter", "rows=100 ", "time=", "ms)"] {
        assert!(text.contains(needle), "{needle} is missing from:\n{text}");
    }
    // every operator line carries its numbers
    let lines: Vec<_> = text.lines().filter(|l| !l.trim_start().starts_with('[')).collect();
    assert!(lines.len() >= 5, "{text}");
    assert!(lines.iter().all(|l| l.contains("rows=") && l.contains("time=")), "{text}");
}

#[test]
fn plain_explain_does_not_run_the_query() {
    let ctx = context();
    let (_, batches) = ctx.sql(&format!("explain {JOIN_AGG}")).unwrap().collect().unwrap();
    let text = text_of(&batches);
    assert!(text.contains("Physical plan") && !text.contains("rows="), "{text}");
}

#[test]
fn only_queries_can_be_explained() {
    let ctx = context();
    assert!(ctx.sql("explain analyze create table x as select 1").is_err());
    assert!(ctx.sql("describe select 1").is_err());
}
