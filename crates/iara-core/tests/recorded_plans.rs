//! Recorded plans: while recording, the outermost execution of a query keeps
//! its physical plan with the metrics of every node, whichever way the query
//! is run; nested executions are not kept as extra entries.
//!
//! Recording is process-wide, so every case runs in one test.

use std::sync::Arc;

use arrow::array::{ArrayRef, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use iara_core::SessionContext;
use iara_core::exec::memory;
use iara_core::physical::analyze::{Analysis, AnalyzedNode, record_plans, take_recorded};
use iara_core::physical::planner::PlanNode;
use iara_core::session::Collected;

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
    ctx.register_batches("facts", schema, batches).unwrap();
    let schema = Arc::new(Schema::new(vec![Field::new("k", DataType::Int64, false), Field::new("name", DataType::Utf8, false)]));
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from((0..DIMS).collect::<Vec<_>>())),
        Arc::new(StringArray::from((0..DIMS).map(|i| format!("dim-{i:03}")).collect::<Vec<_>>())),
    ];
    ctx.register_batches("dims", schema.clone(), vec![RecordBatch::try_new(schema, cols).unwrap()]).unwrap();
    ctx
}

const JOIN_AGG: &str = "select d.name, count(*) as n, sum(f.v) as total from facts f join dims d on f.k = d.k where f.v < 500 group by d.name";
/// the top of the plan is a sort without a limit: `collect_lazy` runs it with `execute_sorted`
const SORTED: &str = "select k, v from facts order by v, k";
/// the subquery is planned and run before the main plan
const SUBQUERY: &str = "select k, v from facts where v > (select avg(v) from facts) and v < 600";

fn analyzed_names(n: &AnalyzedNode, out: &mut Vec<String>) {
    out.push(n.name.clone());
    n.children.iter().for_each(|c| analyzed_names(c, out));
}

fn planned_names(n: &PlanNode, out: &mut Vec<String>) {
    out.push(n.name.clone());
    n.children.iter().for_each(|c| planned_names(c, out));
}

fn all_measured(n: &AnalyzedNode) {
    assert!(n.metrics.is_some(), "no metrics on {}", n.detail);
    n.children.iter().for_each(all_measured);
}

/// `run` is the only entry kept, it ran query `id` and counted `rows`, and it
/// has the shape of the plan `query` plans to.
fn check_one(run: Vec<Analysis>, id: u64, rows: u64, query: &str, what: &str) {
    assert_eq!(run.len(), 1, "{what}: {} entries", run.len());
    let a = &run[0];
    assert_eq!(a.stats.id, id, "{what}");
    all_measured(&a.plan);
    assert_eq!(a.rows, rows, "{what}");
    assert_eq!(a.plan.metrics.as_ref().unwrap().rows_out, rows, "{what}: the root's rows_out");
    let (mut got, mut want) = (vec![], vec![]);
    analyzed_names(&a.plan, &mut got);
    planned_names(&context().sql(query).unwrap().plan_tree().unwrap(), &mut want);
    assert_eq!(got, want, "{what}");
    // each pipeline names the plan nodes it ran for
    for p in &a.stats.pipelines {
        assert!(!p.nodes.is_empty() && p.nodes.iter().all(|&n| n < got.len()), "{what}: nodes {:?} of {}", p.nodes, p.source);
    }
    if query == JOIN_AGG {
        let join = got.iter().position(|n| n == "HashJoin").unwrap();
        let pipelines = a.stats.pipelines.iter().filter(|p| p.nodes.contains(&join)).count();
        assert_eq!(pipelines, 2, "{what}: the join builds in one pipeline and probes in the next");
    }
}

fn rows_of(batches: &[RecordBatch]) -> u64 {
    batches.iter().map(|b| b.num_rows() as u64).sum()
}

#[test]
fn recording_keeps_the_plan_of_each_query_with_its_metrics() {
    let ctx = context();
    record_plans(true);

    // execute
    let lf = ctx.sql(JOIN_AGG).unwrap();
    take_recorded();
    let (_, batches, stats) = lf.collect_profiled().unwrap();
    check_one(take_recorded(), stats.id, rows_of(&batches), JOIN_AGG, "execute");

    // execute_stream
    take_recorded();
    let mut rows = 0;
    let (_, stats) = lf.stream(&mut |_| Ok(()), &mut |b| Ok(rows += b.num_rows() as u64)).unwrap();
    check_one(take_recorded(), stats.id, rows, JOIN_AGG, "stream");

    // execute_sorted
    let lf = ctx.sql(SORTED).unwrap();
    take_recorded();
    let (collected, stats) = lf.collect_lazy_profiled().unwrap();
    let rows = match collected {
        Collected::Batches(_, b) => rows_of(&b),
        Collected::Sorted { idx, .. } => idx.len() as u64,
    };
    assert_eq!(rows, FACTS as u64);
    let run = take_recorded();
    assert_eq!(run[0].plan.name, "Sort", "the sorted path was not the one taken");
    check_one(run, stats.id, rows, SORTED, "sorted");

    // a spilled sort: the merge of runs is counted too
    let pool = memory::pool();
    pool.set_limit(1 << 20);
    take_recorded();
    let (collected, stats) = lf.collect_lazy_profiled().unwrap();
    pool.set_limit(usize::MAX);
    assert!(stats.spilled_bytes > 0, "the sort did not spill");
    let rows = match collected {
        Collected::Batches(_, b) => rows_of(&b),
        Collected::Sorted { idx, .. } => idx.len() as u64,
    };
    check_one(take_recorded(), stats.id, rows, SORTED, "spilled sort");

    // a subquery planned before the main plan runs as a plan of its own
    let lf = ctx.sql(SUBQUERY).unwrap();
    take_recorded();
    let (_, batches, stats) = lf.collect_profiled().unwrap();
    let mut run = take_recorded();
    assert_eq!(run.len(), 2, "the subquery and the main plan");
    let main = run.split_off(1);
    assert_eq!(run[0].stats.id, stats.id);
    all_measured(&run[0].plan);
    assert_eq!(run[0].rows, 1);
    check_one(main, stats.id, rows_of(&batches), SUBQUERY, "subquery");

    // not recording: nothing is kept
    record_plans(false);
    take_recorded();
    lf.collect_profiled().unwrap();
    ctx.sql(SORTED).unwrap().collect_lazy().unwrap();
    assert!(take_recorded().is_empty());
}
