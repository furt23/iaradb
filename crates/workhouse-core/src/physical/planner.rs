//! Physical planning (logical plan -> operators) and execution (operators ->
//! pipelines -> results).

use std::fmt::Write as _;
use std::sync::Arc;

use arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use arrow::record_batch::RecordBatch;

use crate::error::{Result, WhError};
use crate::exec::aggregate::{AggregateExpr, AggregateSink};
use crate::exec::join::{BuildSide, HashJoinProbe, JoinBuildSink, NestedLoopJoin, concat_parallel, joined_schema};
use crate::exec::join_spill::{GraceJoin, GraceJoinSource, PartitionSink};
use crate::exec::ops::{FilterOp, ProjectOp, nullable_schema};
use crate::exec::pipeline::{CollectSink, MemorySource, NullSink, Pipeline, Source, UnionSource, run_pipeline};
use crate::exec::sort::SortSink;
use crate::exec::stream::{Emitter, StreamSink};
use crate::exec::window::{WindowFunctionExpr, WindowSink, WindowSpec, Windowed};
use crate::io::work_table::WorkTable;
use crate::expr::{AggFunc, Expr, Operator, SortExpr, WindowFunc, split_conjunction};
use crate::logical::{JoinType, LogicalPlan};
use crate::physical::expr::{PhysExpr, PhysSortExpr, cast_expr, create_physical_expr};
use crate::scalar::Scalar;
use crate::schema::PlanSchema;
use crate::types::comparison_common;

/// A physical plan node for display: operator kind, its full description,
/// the role it plays for its parent (`probe` / `build` of a join) and inputs.
#[derive(Clone, Debug)]
pub struct PlanNode {
    pub name: String,
    pub detail: String,
    pub role: Option<&'static str>,
    pub children: Vec<PlanNode>,
}

pub enum PhysicalPlan {
    Source { source: Arc<dyn Source>, schema: SchemaRef },
    Filter { input: Box<PhysicalPlan>, predicate: PhysExpr, projection: Option<Vec<usize>>, schema: SchemaRef },
    Project { input: Box<PhysicalPlan>, exprs: Vec<PhysExpr>, schema: SchemaRef },
    Aggregate { input: Box<PhysicalPlan>, group_exprs: Vec<PhysExpr>, aggs: Vec<AggregateExpr>, schema: SchemaRef },
    HashJoin {
        probe: Box<PhysicalPlan>,
        build: Box<PhysicalPlan>,
        probe_keys: Vec<PhysExpr>,
        build_keys: Vec<PhysExpr>,
        join_type: JoinType,
        filter: Option<PhysExpr>,
        joined_schema: SchemaRef,
        schema: SchemaRef,
        order: Option<Vec<usize>>,
        /// semi/anti join executed by building the (smaller) preserved side
        mark_build: bool,
    },
    NestedLoopJoin {
        probe: Box<PhysicalPlan>,
        build: Box<PhysicalPlan>,
        join_type: JoinType,
        filter: Option<PhysExpr>,
        joined_schema: SchemaRef,
        schema: SchemaRef,
        order: Option<Vec<usize>>,
    },
    Sort { input: Box<PhysicalPlan>, keys: Vec<PhysSortExpr>, fetch: Option<usize>, schema: SchemaRef },
    Limit { input: Box<PhysicalPlan>, skip: usize, fetch: Option<usize> },
    Union { inputs: Vec<PhysicalPlan>, schema: SchemaRef },
    Values { batches: Vec<RecordBatch>, schema: SchemaRef },
    Window { input: Box<PhysicalPlan>, specs: Vec<WindowSpec>, schema: SchemaRef },
    RecursiveQuery {
        static_term: Box<PhysicalPlan>,
        recursive_term: Box<PhysicalPlan>,
        work_table: Arc<WorkTable>,
        distinct: bool,
        fetch: Option<usize>,
        schema: SchemaRef,
    },
}

impl PhysicalPlan {
    pub fn schema(&self) -> SchemaRef {
        match self {
            PhysicalPlan::Source { schema, .. }
            | PhysicalPlan::Filter { schema, .. }
            | PhysicalPlan::Project { schema, .. }
            | PhysicalPlan::Aggregate { schema, .. }
            | PhysicalPlan::HashJoin { schema, .. }
            | PhysicalPlan::NestedLoopJoin { schema, .. }
            | PhysicalPlan::Sort { schema, .. }
            | PhysicalPlan::Union { schema, .. }
            | PhysicalPlan::Values { schema, .. }
            | PhysicalPlan::Window { schema, .. }
            | PhysicalPlan::RecursiveQuery { schema, .. } => schema.clone(),
            PhysicalPlan::Limit { input, .. } => input.schema(),
        }
    }

    fn children(&self) -> Vec<&PhysicalPlan> {
        match self {
            PhysicalPlan::Source { .. } | PhysicalPlan::Values { .. } => vec![],
            PhysicalPlan::Filter { input, .. }
            | PhysicalPlan::Project { input, .. }
            | PhysicalPlan::Aggregate { input, .. }
            | PhysicalPlan::Sort { input, .. }
            | PhysicalPlan::Limit { input, .. }
            | PhysicalPlan::Window { input, .. } => vec![input],
            PhysicalPlan::RecursiveQuery { static_term, recursive_term, .. } => vec![static_term, recursive_term],
            PhysicalPlan::HashJoin { probe, build, .. } | PhysicalPlan::NestedLoopJoin { probe, build, .. } => {
                vec![probe, build]
            }
            PhysicalPlan::Union { inputs, .. } => inputs.iter().collect(),
        }
    }

    fn line(&self) -> String {
        let join = |v: &[PhysExpr]| v.iter().map(|e| e.to_string()).collect::<Vec<_>>().join(", ");
        match self {
            PhysicalPlan::Source { source, .. } => source.describe(),
            PhysicalPlan::Filter { predicate, projection, .. } => match projection {
                Some(p) => format!("Filter: {predicate} (then keep columns {p:?})"),
                None => format!("Filter: {predicate}"),
            },
            PhysicalPlan::Project { exprs, .. } => format!("Project: {}", join(exprs)),
            PhysicalPlan::Aggregate { group_exprs, aggs, .. } => format!(
                "HashAggregate: keys=[{}], aggs=[{}]",
                join(group_exprs),
                aggs.iter().map(|a| a.name.clone()).collect::<Vec<_>>().join(", ")
            ),
            PhysicalPlan::HashJoin { join_type, probe_keys, build_keys, filter, order, mark_build, .. } => format!(
                "HashJoin({join_type:?}): probe=[{}] build=[{}]{}{}{}",
                join(probe_keys),
                join(build_keys),
                if filter.is_some() { " +filter" } else { "" },
                if order.is_some() { " (sides swapped)" } else { "" },
                if *mark_build { " (build=preserved side, mark matches)" } else { "" }
            ),
            PhysicalPlan::NestedLoopJoin { join_type, .. } => format!("NestedLoopJoin({join_type:?})"),
            PhysicalPlan::Sort { keys, fetch, .. } => {
                let k: Vec<String> = keys
                    .iter()
                    .map(|k| format!("{} {}", k.expr, if k.descending { "DESC" } else { "ASC" }))
                    .collect();
                match fetch {
                    Some(f) => format!("TopK(k={f}): [{}]", k.join(", ")),
                    None => format!("ParallelSort: [{}]", k.join(", ")),
                }
            }
            PhysicalPlan::Limit { skip, fetch, .. } => format!("Limit: skip={skip} fetch={fetch:?}"),
            PhysicalPlan::Union { .. } => "Union".into(),
            PhysicalPlan::Values { batches, .. } => {
                format!("Values: {} rows", batches.iter().map(|b| b.num_rows()).sum::<usize>())
            }
            PhysicalPlan::Window { specs, .. } => {
                format!("Window: {}", specs.iter().map(|s| format!("[{}]", s.describe())).collect::<Vec<_>>().join(" "))
            }
            PhysicalPlan::RecursiveQuery { work_table, distinct, fetch, .. } => format!(
                "RecursiveQuery: {} [UNION{}]{}",
                work_table.name(),
                if *distinct { "" } else { " ALL" },
                fetch.map(|f| format!(" fetch={f}")).unwrap_or_default()
            ),
        }
    }

    /// The plan as a tree of labelled nodes (for display in tools).
    pub fn tree(&self) -> PlanNode {
        let children = self.children();
        let roles: &[&'static str] = match self {
            PhysicalPlan::HashJoin { .. } | PhysicalPlan::NestedLoopJoin { .. } => &["probe", "build"],
            PhysicalPlan::RecursiveQuery { .. } => &["base", "recursive"],
            _ => &[],
        };
        PlanNode {
            name: self.kind(),
            detail: self.line(),
            role: None,
            children: children
                .into_iter()
                .enumerate()
                .map(|(i, c)| PlanNode { role: roles.get(i).copied(), ..c.tree() })
                .collect(),
        }
    }

    fn kind(&self) -> String {
        match self {
            PhysicalPlan::Source { source, .. } => {
                let d = source.describe();
                d.split(['[', '(']).next().unwrap_or(&d).to_string()
            }
            PhysicalPlan::Filter { .. } => "Filter".into(),
            PhysicalPlan::Project { .. } => "Project".into(),
            PhysicalPlan::Aggregate { .. } => "HashAggregate".into(),
            PhysicalPlan::HashJoin { .. } => "HashJoin".into(),
            PhysicalPlan::NestedLoopJoin { .. } => "NestedLoopJoin".into(),
            PhysicalPlan::Sort { fetch: Some(_), .. } => "TopK".into(),
            PhysicalPlan::Sort { .. } => "Sort".into(),
            PhysicalPlan::Limit { .. } => "Limit".into(),
            PhysicalPlan::Union { .. } => "Union".into(),
            PhysicalPlan::Values { .. } => "Values".into(),
            PhysicalPlan::Window { .. } => "Window".into(),
            PhysicalPlan::RecursiveQuery { .. } => "RecursiveQuery".into(),
        }
    }

    pub fn display_indent(&self) -> String {
        let mut out = String::new();
        fn go(p: &PhysicalPlan, d: usize, out: &mut String) {
            let label = match p {
                PhysicalPlan::HashJoin { .. } | PhysicalPlan::NestedLoopJoin { .. } => {
                    let _ = writeln!(out, "{}{}", "  ".repeat(d), p.line());
                    let c = p.children();
                    let _ = writeln!(out, "{}  [probe]", "  ".repeat(d));
                    go(c[0], d + 2, out);
                    let _ = writeln!(out, "{}  [build]", "  ".repeat(d));
                    go(c[1], d + 2, out);
                    return;
                }
                _ => p.line(),
            };
            let _ = writeln!(out, "{}{}", "  ".repeat(d), label);
            for c in p.children() {
                go(c, d + 1, out);
            }
        }
        go(self, 0, &mut out);
        out
    }
}

// ---------------------------------------------------------------------------
// cardinality estimation (used to pick join build sides)
// ---------------------------------------------------------------------------

pub fn predicate_selectivity(p: &Expr) -> f64 {
    predicate_selectivity_in(p, None)
}

/// `column = literal` on a column with a known number of distinct values.
fn eq_selectivity(l: &Expr, r: &Expr, input: Option<&LogicalPlan>) -> Option<f64> {
    let input = input?;
    let col = match (l, r) {
        (c @ Expr::Column(_), Expr::Literal(_)) | (Expr::Literal(_), c @ Expr::Column(_)) => c,
        _ => return None,
    };
    let ndv = expr_ndv(input, col)?;
    Some((1.0 / ndv.max(1.0)).clamp(1e-7, 1.0))
}

pub fn predicate_selectivity_in(p: &Expr, input: Option<&LogicalPlan>) -> f64 {
    let rec = |x: &Expr| predicate_selectivity_in(x, input);
    match p {
        Expr::Binary { left, op: Operator::And, right } => rec(left) * rec(right),
        Expr::Binary { left, op: Operator::Or, right } => {
            let (a, b) = (rec(left), rec(right));
            1.0 - (1.0 - a) * (1.0 - b)
        }
        Expr::Binary { left, op: Operator::Eq, right } => eq_selectivity(left, right, input).unwrap_or(0.1),
        Expr::Binary { left, op: Operator::NotEq, right } => 1.0 - eq_selectivity(left, right, input).unwrap_or(0.1),
        Expr::Binary { left, op, right } if op.is_comparison() => {
            range_bound(left, *op, right)
                .and_then(|(c, lo, hi)| range_selectivity(input?, &c, lo, hi))
                .unwrap_or(0.4)
        }
        Expr::InList { expr, list, negated } => {
            let one = list
                .first()
                .and_then(|l| eq_selectivity(expr, l, input))
                .unwrap_or(0.05);
            let s = (one * list.len() as f64).min(0.9);
            if *negated { 1.0 - s } else { s }
        }
        Expr::Like { negated: false, .. } => 0.25,
        Expr::Like { negated: true, .. } => 0.9,
        Expr::IsNull(_) => 0.1,
        Expr::IsNotNull(_) => 0.9,
        Expr::Not(x) => 1.0 - rec(x),
        _ => 0.5,
    }
}

fn selectivity(pred: &Expr) -> f64 {
    selectivity_in(pred, None)
}

/// `column <op> literal` as (column, lower bound, upper bound).
fn range_bound(l: &Expr, op: Operator, r: &Expr) -> Option<(crate::schema::Column, Option<f64>, Option<f64>)> {
    let (c, op, lit) = match (l, r) {
        (Expr::Column(c), Expr::Literal(v)) => (c, op, v),
        (Expr::Literal(v), Expr::Column(c)) => (c, op.swap(), v),
        _ => return None,
    };
    let v = crate::io::ordinal_values(&v_array(lit))?;
    let v = arrow::array::AsArray::as_primitive::<arrow::datatypes::Float64Type>(&v);
    if arrow::array::Array::is_null(v, 0) {
        return None;
    }
    let v = v.value(0);
    match op {
        Operator::Lt | Operator::LtEq => Some((c.clone(), None, Some(v))),
        Operator::Gt | Operator::GtEq => Some((c.clone(), Some(v), None)),
        _ => None,
    }
}

fn v_array(s: &crate::scalar::Scalar) -> arrow::array::ArrayRef {
    s.array().clone()
}

/// Fraction of a column's [min, max] statistics range covered by [lo, hi].
fn range_selectivity(input: &LogicalPlan, c: &crate::schema::Column, lo: Option<f64>, hi: Option<f64>) -> Option<f64> {
    let (p, i) = column_origin(input, c)?;
    let (mn, mx) = p.column_range(i)?;
    if mx <= mn {
        return None;
    }
    let (a, b) = (lo.unwrap_or(mn).max(mn), hi.unwrap_or(mx).min(mx));
    Some(((b - a) / (mx - mn)).clamp(0.001, 1.0))
}

fn selectivity_in(pred: &Expr, input: Option<&LogicalPlan>) -> f64 {
    let conjuncts = split_conjunction(pred);
    // bounds on the same column combine into one range, estimated from statistics
    let mut ranges: Vec<(crate::schema::Column, Option<f64>, Option<f64>)> = vec![];
    let mut rest = vec![];
    for p in &conjuncts {
        let bound = match (p, input) {
            (Expr::Binary { left, op, right }, Some(inp)) if op.is_comparison() => {
                range_bound(left, *op, right).filter(|(c, _, _)| range_selectivity(inp, c, None, None).is_some())
            }
            _ => None,
        };
        match bound {
            Some((c, lo, hi)) => match ranges.iter_mut().find(|r| r.0 == c) {
                Some(r) => {
                    if let Some(lo) = lo {
                        r.1 = Some(r.1.map_or(lo, |x: f64| x.max(lo)));
                    }
                    if let Some(hi) = hi {
                        r.2 = Some(r.2.map_or(hi, |x: f64| x.min(hi)));
                    }
                }
                None => ranges.push((c, lo, hi)),
            },
            None => rest.push(p.clone()),
        }
    }
    let ranged_sel: f64 = ranges
        .iter()
        .map(|(c, lo, hi)| input.and_then(|inp| range_selectivity(inp, c, *lo, *hi)).unwrap_or(0.4))
        .product();
    // a lower and an upper bound on the same column form one range
    let mut ranged: Vec<crate::schema::Column> = vec![];
    ranged_sel * rest
        .iter()
        .map(|p| {
            if let Expr::Binary { left, op, .. } = p {
                if op.is_comparison() && !matches!(op, Operator::Eq | Operator::NotEq) {
                    if let Expr::Column(c) = left.as_ref() {
                        if ranged.contains(c) {
                            return 0.625;
                        }
                        ranged.push(c.clone());
                    }
                }
            }
            predicate_selectivity_in(p, input)
        })
        .product::<f64>()
        .max(0.0005)
}

/// The table column a plan column comes from, when it flows through unchanged.
pub fn column_origin(plan: &LogicalPlan, col: &crate::schema::Column) -> Option<(Arc<dyn crate::io::TableProvider>, usize)> {
    match plan {
        LogicalPlan::Scan(s) => {
            let idx = s.schema.maybe_index_of(col).ok()??;
            let t = match &s.projection {
                Some(p) => p[idx],
                None => idx,
            };
            Some((s.source.clone(), t))
        }
        LogicalPlan::Filter(f) => column_origin(&f.input, col),
        LogicalPlan::Sort(s) => column_origin(&s.input, col),
        LogicalPlan::Limit(l) => column_origin(&l.input, col),
        LogicalPlan::Projection(p) => {
            let idx = p.schema.maybe_index_of(col).ok()??;
            match p.exprs[idx].unalias_ref() {
                Expr::Column(c) => column_origin(&p.input, c),
                _ => None,
            }
        }
        LogicalPlan::SubqueryAlias(sa) => {
            let idx = sa.schema.maybe_index_of(col).ok()??;
            column_origin(&sa.input, &sa.input.schema().column(idx))
        }
        LogicalPlan::Aggregate(a) => {
            let idx = a.schema.maybe_index_of(col).ok()??;
            match a.group_by.get(idx).map(|g| g.unalias_ref()) {
                Some(Expr::Column(c)) => column_origin(&a.input, c),
                _ => None,
            }
        }
        LogicalPlan::Window(w) => {
            let idx = w.schema.maybe_index_of(col).ok()??;
            let input = w.input.schema();
            (idx < input.len()).then(|| column_origin(&w.input, &input.column(idx)))?
        }
        LogicalPlan::Join(j) => {
            if let Some(o) = column_origin(&j.left, col) {
                return Some(o);
            }
            if matches!(j.join_type, JoinType::Semi | JoinType::Anti) {
                return None;
            }
            column_origin(&j.right, col)
        }
        _ => None,
    }
}

/// Distinct values of a join key expression evaluated over `plan`.
pub fn expr_ndv(plan: &LogicalPlan, e: &Expr) -> Option<f64> {
    match e.unalias_ref() {
        Expr::Column(c) => {
            let (p, i) = column_origin(plan, c)?;
            p.column_ndv(i).or_else(|| p.num_rows().map(|n| n as f64))
        }
        Expr::Cast { expr, .. } => expr_ndv(plan, expr),
        _ => None,
    }
}

/// |L join R| = |L| * |R| / ndv(key), with ndv(key) = min(ndv_L, ndv_R)
/// (the smaller key domain is assumed to be contained in the larger one, as
/// for foreign-key joins). Composite keys multiply, capped by the inputs.
pub fn join_cardinality(left: &LogicalPlan, right: &LogicalPlan, on: &[(Expr, Expr)], l_rows: f64, r_rows: f64) -> f64 {
    let mut ndv = 1.0f64;
    for (l, r) in on {
        let nl = expr_ndv(left, l).unwrap_or(l_rows);
        let nr = expr_ndv(right, r).unwrap_or(r_rows);
        ndv *= nl.min(nr).max(1.0);
    }
    let cap = if on.len() > 1 { l_rows.min(r_rows).max(1.0) } else { f64::INFINITY };
    l_rows * r_rows / ndv.min(cap).max(1.0)
}

/// (base cardinality, selectivity of the filters applied on top of it).
/// Inner equi-joins are assumed to be foreign-key joins: the result has the
/// cardinality of the larger input, reduced by the filters of both sides.
pub fn cardinality(plan: &LogicalPlan) -> (f64, f64) {
    match plan {
        LogicalPlan::Scan(s) => {
            let n = s.source.num_rows().unwrap_or(1_000_000) as f64;
            (match s.fetch {
                Some(f) => n.min(f as f64),
                None => n,
            }, 1.0)
        }
        LogicalPlan::Filter(f) => {
            let (b, s) = cardinality(&f.input);
            (b, s * selectivity_in(&f.predicate, Some(&f.input)))
        }
        LogicalPlan::Projection(p) => cardinality(&p.input),
        LogicalPlan::SubqueryAlias(s) => cardinality(&s.input),
        LogicalPlan::Aggregate(a) => {
            if a.group_by.is_empty() {
                (1.0, 1.0)
            } else {
                ((estimate_rows(&a.input) * 0.1).max(1.0), 1.0)
            }
        }
        LogicalPlan::Join(j) => {
            let (lb, ls) = cardinality(&j.left);
            let (rb, rs) = cardinality(&j.right);
            let fsel = j.filter.as_ref().map(selectivity).unwrap_or(1.0);
            match j.join_type {
                JoinType::Inner if j.on.is_empty() => (lb * ls * rb * rs, fsel),
                JoinType::Inner => (join_cardinality(&j.left, &j.right, &j.on, lb * ls, rb * rs), fsel),
                JoinType::Left => (lb, ls),
                JoinType::Right => (rb, rs),
                JoinType::Full => (lb * ls + rb * rs, 1.0),
                JoinType::Semi => (lb, ls * rs.max(0.05)),
                JoinType::Anti => (lb, ls * 0.5),
            }
        }
        LogicalPlan::Sort(s) => match s.fetch {
            Some(f) => ((f as f64).min(estimate_rows(&s.input)), 1.0),
            None => cardinality(&s.input),
        },
        LogicalPlan::Limit(l) => match l.fetch {
            Some(f) => ((f as f64).min(estimate_rows(&l.input)), 1.0),
            None => cardinality(&l.input),
        },
        LogicalPlan::Union(u) => (u.inputs.iter().map(|i| estimate_rows(i)).sum(), 1.0),
        LogicalPlan::Values(v) => (v.batches.iter().map(|b| b.num_rows()).sum::<usize>() as f64, 1.0),
        LogicalPlan::Window(w) => cardinality(&w.input),
        LogicalPlan::RecursiveQuery(r) => {
            let n = estimate_rows(&r.static_term) * 10.0;
            (r.fetch.map_or(n, |f| n.min(f as f64)), 1.0)
        }
    }
}

pub fn estimate_rows(plan: &LogicalPlan) -> f64 {
    let (b, s) = cardinality(plan);
    (b * s).max(1.0)
}

// ---------------------------------------------------------------------------
// planner
// ---------------------------------------------------------------------------

/// Evaluate uncorrelated scalar subqueries and substitute their value.
fn resolve_subqueries(e: &Expr) -> Result<Expr> {
    if !e.contains_subquery() {
        return Ok(e.clone());
    }
    e.clone().transform_up(&mut |x| match x {
        Expr::ScalarSubquery(q) => {
            let plan = crate::optimizer::optimize(&q.0)?;
            let phys = create_physical_plan(&plan)?;
            let batches = execute(&phys)?;
            let rows: usize = batches.iter().map(|b| b.num_rows()).sum();
            let dt = plan.schema().field(0).data_type().clone();
            if rows == 0 {
                return Ok(Expr::Literal(Scalar::null_of(&dt)));
            }
            if rows > 1 {
                return Err(WhError::Execution("scalar subquery returned more than one row".into()));
            }
            let b = batches.iter().find(|b| b.num_rows() > 0).unwrap();
            Ok(Expr::Literal(Scalar::from_array(b.column(0).as_ref(), 0)?))
        }
        Expr::InSubquery { .. } | Expr::Exists { .. } => {
            Err(WhError::NotSupported(format!("subquery predicate in unsupported position: {x}")))
        }
        other => Ok(other),
    })
}

fn compile(e: &Expr, schema: &PlanSchema) -> Result<PhysExpr> {
    let e = resolve_subqueries(e)?;
    create_physical_expr(&e, schema)
}

/// Output schema of a computed node: names and types come from the logical
/// plan (operators cast if a kernel produced a different physical type), so
/// logical and physical schemas never diverge.
fn output_schema(names: &PlanSchema, _exprs: &[PhysExpr]) -> SchemaRef {
    Arc::new(Schema::new(
        names.fields().iter().map(|f| Field::new(f.name(), f.field.data_type().clone(), true)).collect::<Vec<_>>(),
    ))
}

fn swap_order(nl: usize, nr: usize) -> Vec<usize> {
    // logical output = [left..., right...]; joined = [right(probe)..., left(build)...]
    (0..nl).map(|i| nr + i).chain(0..nr).collect()
}

pub fn create_physical_plan(plan: &LogicalPlan) -> Result<PhysicalPlan> {
    Ok(match plan {
        LogicalPlan::Scan(s) => {
            let source = s.source.create_source(s.projection.as_deref(), &s.filters, s.fetch)?;
            let schema = source.schema();
            PhysicalPlan::Source { source, schema }
        }
        LogicalPlan::Filter(f) => {
            let input = create_physical_plan(&f.input)?;
            let predicate = cast_expr(compile(&f.predicate, f.input.schema())?, &DataType::Boolean)?;
            let schema = input.schema();
            PhysicalPlan::Filter { input: Box::new(input), predicate, projection: None, schema }
        }
        LogicalPlan::Projection(p) => {
            let input = create_physical_plan(&p.input)?;
            let exprs = p.exprs.iter().map(|e| compile(e, p.input.schema())).collect::<Result<Vec<_>>>()?;
            let schema = output_schema(&p.schema, &exprs);
            // fuse column-only projections into a preceding filter
            let in_schema = input.schema();
            let all_cols: Option<Vec<usize>> = exprs
                .iter()
                .zip(schema.fields())
                .map(|(e, f)| e.as_column_index().filter(|&i| in_schema.field(i).name() == f.name()))
                .collect();
            match (input, all_cols) {
                (PhysicalPlan::Filter { input: fin, predicate, projection: None, .. }, Some(cols)) => {
                    let fschema = Arc::new(in_schema.project(&cols)?);
                    PhysicalPlan::Filter { input: fin, predicate, projection: Some(cols), schema: fschema }
                }
                (input, _) => PhysicalPlan::Project { input: Box::new(input), exprs, schema },
            }
        }
        LogicalPlan::Aggregate(a) => {
            let input = create_physical_plan(&a.input)?;
            let in_schema = a.input.schema();
            let group_exprs = a.group_by.iter().map(|e| compile(e, in_schema)).collect::<Result<Vec<_>>>()?;
            let mut aggs = vec![];
            let mut fields: Vec<Field> = a
                .schema
                .fields()
                .iter()
                .take(group_exprs.len())
                .map(|f| Field::new(f.name(), f.field.data_type().clone(), true))
                .collect();
            for (i, ae) in a.aggs.iter().enumerate() {
                let Expr::Agg { func, args, distinct, filter } = ae.unalias_ref() else {
                    return Err(WhError::Plan(format!("not an aggregate: {ae}")));
                };
                let mut pargs = args.iter().map(|x| compile(x, in_schema)).collect::<Result<Vec<_>>>()?;
                if let Some(first) = pargs.first_mut() {
                    let t = first.data_type();
                    if t == DataType::Boolean && matches!(func, AggFunc::Sum | AggFunc::Mean) {
                        *first = cast_expr(first.clone(), &DataType::Int64)?;
                    }
                    if t == DataType::Null {
                        *first = cast_expr(first.clone(), &DataType::Int64)?;
                    }
                }
                let input_type = pargs.first().map(|p| p.data_type());
                let out_type = a.schema.field(a.group_by.len() + i).data_type().clone();
                let pfilter = match filter {
                    Some(f) => Some(cast_expr(compile(f, in_schema)?, &DataType::Boolean)?),
                    None => None,
                };
                let name = a.schema.field(a.group_by.len() + i).name().clone();
                fields.push(Field::new(&name, out_type, true));
                aggs.push(AggregateExpr {
                    func: *func,
                    args: pargs,
                    distinct: *distinct,
                    filter: pfilter,
                    input_type,
                    name,
                });
            }
            PhysicalPlan::Aggregate {
                input: Box::new(input),
                group_exprs,
                aggs,
                schema: Arc::new(Schema::new(fields)),
            }
        }
        LogicalPlan::Join(j) => plan_join(j, plan)?,
        LogicalPlan::Sort(s) => {
            let input = create_physical_plan(&s.input)?;
            let keys = s
                .exprs
                .iter()
                .map(|e| {
                    Ok(PhysSortExpr {
                        expr: compile(&e.expr, s.input.schema())?,
                        descending: e.descending,
                        nulls_first: e.nulls_first,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let schema = input.schema();
            PhysicalPlan::Sort { input: Box::new(input), keys, fetch: s.fetch, schema }
        }
        LogicalPlan::Limit(l) => {
            PhysicalPlan::Limit { input: Box::new(create_physical_plan(&l.input)?), skip: l.skip, fetch: l.fetch }
        }
        LogicalPlan::Union(u) => {
            let inputs = u.inputs.iter().map(|i| create_physical_plan(i)).collect::<Result<Vec<_>>>()?;
            let schema = nullable_schema(u.schema.arrow_schema());
            PhysicalPlan::Union { inputs, schema }
        }
        LogicalPlan::SubqueryAlias(s) => create_physical_plan(&s.input)?,
        LogicalPlan::Values(v) => {
            PhysicalPlan::Values { batches: v.batches.clone(), schema: v.schema.arrow_schema().clone() }
        }
        LogicalPlan::Window(w) => plan_window(w)?,
        LogicalPlan::RecursiveQuery(r) => PhysicalPlan::RecursiveQuery {
            static_term: Box::new(create_physical_plan(&r.static_term)?),
            recursive_term: Box::new(create_physical_plan(&r.recursive_term)?),
            work_table: r.work_table.clone(),
            distinct: r.distinct,
            fetch: r.fetch,
            schema: r.work_table.schema_ref(),
        },
    })
}

/// Group the window functions by (PARTITION BY, ORDER BY): each group sorts
/// the input once.
fn plan_window(w: &crate::logical::Window) -> Result<PhysicalPlan> {
    let input = create_physical_plan(&w.input)?;
    let in_schema = w.input.schema();
    let n_in = in_schema.len();
    let mut groups: Vec<((Vec<Expr>, Vec<SortExpr>), WindowSpec)> = vec![];
    let mut fields: Vec<Field> = input.schema().fields().iter().map(|f| f.as_ref().clone()).collect();
    for (i, e) in w.exprs.iter().enumerate() {
        let Expr::Window(we) = e.unalias_ref() else {
            return Err(WhError::Plan(format!("not a window function: {e}")));
        };
        // the order of a whole partition does not change an aggregate of it
        let order_free = matches!(we.func, WindowFunc::Agg(f) if !matches!(f, AggFunc::First | AggFunc::Last)) && we.frame.is_whole();
        let order_by = if order_free { vec![] } else { we.order_by.clone() };
        let mut args = we.args.iter().map(|a| compile(a, in_schema)).collect::<Result<Vec<_>>>()?;
        if let (WindowFunc::Agg(func), Some(first)) = (we.func, args.first_mut()) {
            let t = first.data_type();
            if (t == DataType::Boolean && matches!(func, AggFunc::Sum | AggFunc::Mean)) || t == DataType::Null {
                *first = cast_expr(first.clone(), &DataType::Int64)?;
            }
        }
        let field = w.schema.field(n_in + i);
        fields.push(Field::new(field.name(), field.data_type().clone(), true));
        let func = WindowFunctionExpr {
            func: we.func,
            args,
            distinct: we.distinct,
            filter: we.filter.as_ref().map(|f| cast_expr(compile(f, in_schema)?, &DataType::Boolean)).transpose()?,
            ignore_nulls: we.ignore_nulls,
            frame: we.frame.clone(),
            out_type: field.data_type().clone(),
            name: field.name().clone(),
        };
        let key = (we.partition_by.clone(), order_by);
        match groups.iter_mut().find(|(k, _)| *k == key) {
            Some((_, spec)) => spec.funcs.push((n_in + i, func)),
            None => {
                let spec = WindowSpec {
                    partition_by: key.0.iter().map(|p| compile(p, in_schema)).collect::<Result<_>>()?,
                    order_by: key
                        .1
                        .iter()
                        .map(|o| Ok(PhysSortExpr { expr: compile(&o.expr, in_schema)?, descending: o.descending, nulls_first: o.nulls_first }))
                        .collect::<Result<_>>()?,
                    funcs: vec![(n_in + i, func)],
                };
                groups.push((key, spec));
            }
        }
    }
    Ok(PhysicalPlan::Window {
        input: Box::new(input),
        specs: groups.into_iter().map(|(_, s)| s).collect(),
        schema: Arc::new(Schema::new(fields)),
    })
}

fn plan_join(j: &crate::logical::Join, _plan: &LogicalPlan) -> Result<PhysicalPlan> {
    let ls = j.left.schema();
    let rs = j.right.schema();
    let nl = ls.len();
    let nr = rs.len();
    let l_est = estimate_rows(&j.left);
    let r_est = estimate_rows(&j.right);

    // (probe, build, executed join type, swapped?)
    let mark_build = matches!(j.join_type, JoinType::Semi | JoinType::Anti) && !j.on.is_empty() && l_est * 2.0 < r_est;
    // `Right` as executed type = "build side preserved": matched pairs are
    // streamed, unmatched build rows are emitted when the probe finishes
    let keyed = !j.on.is_empty();
    let (swap, exec_type) = match j.join_type {
        JoinType::Inner => (l_est < r_est, JoinType::Inner),
        JoinType::Left if keyed && l_est * 2.0 < r_est => (true, JoinType::Right),
        JoinType::Right if keyed && r_est * 2.0 < l_est => (false, JoinType::Right),
        JoinType::Right => (true, JoinType::Left),
        t if mark_build => (true, t),
        t => (false, t),
    };
    let (probe_l, build_l) = if swap { (&j.right, &j.left) } else { (&j.left, &j.right) };
    let probe = create_physical_plan(probe_l)?;
    let build = create_physical_plan(build_l)?;
    let joined = joined_schema(&probe.schema(), &build.schema());
    let order = (swap && !mark_build).then(|| swap_order(nl, nr));
    let out_schema = match j.join_type {
        JoinType::Semi | JoinType::Anti if mark_build => build.schema(),
        JoinType::Semi | JoinType::Anti => probe.schema(),
        _ => match &order {
            None => joined.clone(),
            Some(o) => Arc::new(Schema::new(o.iter().map(|&i| joined.field(i).clone()).collect::<Vec<_>>())),
        },
    };
    let probe_plan_schema = probe_l.schema();
    let build_plan_schema = build_l.schema();
    let filter = match &j.filter {
        Some(f) => {
            let js = PlanSchema::join(probe_plan_schema, build_plan_schema);
            Some(cast_expr(compile(f, &js)?, &DataType::Boolean)?)
        }
        None => None,
    };
    if j.on.is_empty() {
        if matches!(j.join_type, JoinType::Full | JoinType::Right) {
            return Err(WhError::NotSupported("outer joins without equality conditions".into()));
        }
        return Ok(PhysicalPlan::NestedLoopJoin {
            probe: Box::new(probe),
            build: Box::new(build),
            join_type: exec_type,
            filter,
            joined_schema: joined,
            schema: out_schema,
            order,
        });
    }
    let mut probe_keys = vec![];
    let mut build_keys = vec![];
    for (l, r) in &j.on {
        let (pk, bk) = if swap { (r, l) } else { (l, r) };
        let pk = compile(pk, probe_plan_schema)?;
        let bk = compile(bk, build_plan_schema)?;
        let (pt, bt) = (pk.data_type(), bk.data_type());
        let common = comparison_common(&pt, &bt)
            .ok_or_else(|| WhError::Plan(format!("cannot join {pt} with {bt}")))?;
        probe_keys.push(cast_expr(pk, &common)?);
        build_keys.push(cast_expr(bk, &common)?);
    }
    Ok(PhysicalPlan::HashJoin {
        probe: Box::new(probe),
        build: Box::new(build),
        probe_keys,
        build_keys,
        join_type: exec_type,
        filter,
        joined_schema: joined,
        schema: out_schema,
        order,
        mark_build,
    })
}

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

pub fn execute(plan: &PhysicalPlan) -> Result<Vec<RecordBatch>> {
    match plan {
        PhysicalPlan::Aggregate { input, group_exprs, aggs, schema } => {
            let pipe = build_pipeline(input)?;
            let sink = AggregateSink::new(group_exprs.clone(), aggs.clone(), schema.clone());
            run_pipeline(&pipe, &sink)
        }
        PhysicalPlan::Sort { input, keys, fetch, schema } => {
            let pipe = build_pipeline(input)?;
            run_pipeline(&pipe, &SortSink { keys: keys.clone(), fetch: *fetch, schema: schema.clone() })?.into_batches()
        }
        PhysicalPlan::Limit { input, skip, fetch } => {
            let pipe = build_pipeline(input)?;
            run_pipeline(&pipe, &CollectSink::with_limit(*skip, *fetch))
        }
        PhysicalPlan::Values { batches, .. } => Ok(batches.clone()),
        PhysicalPlan::Window { input, specs, schema } => {
            let pipe = build_pipeline(input)?;
            run_pipeline(&pipe, &WindowSink::new(specs.clone(), schema.clone()))?.into_batches()
        }
        PhysicalPlan::RecursiveQuery { static_term, recursive_term, work_table, distinct, fetch, .. } => {
            let base = execute(static_term)?;
            crate::exec::recursive::iterate(base, work_table, *distinct, *fetch, || execute(recursive_term))
        }
        _ => run_pipeline(&build_pipeline(plan)?, &CollectSink::new()),
    }
}

/// Run a plan, handing its batches to `emit` in order as they are produced:
/// pipelines stream through an order-preserving sink, a sort's runs are
/// merged straight into `emit`. Only aggregations and window results are
/// produced whole before being handed out.
pub fn execute_stream(plan: &PhysicalPlan, emit: Emitter<'_>) -> Result<()> {
    match plan {
        PhysicalPlan::Sort { input, keys, fetch, schema } => {
            let pipe = build_pipeline(input)?;
            run_pipeline(&pipe, &SortSink { keys: keys.clone(), fetch: *fetch, schema: schema.clone() })?.emit(emit)
        }
        PhysicalPlan::Limit { input, skip, fetch } => run_pipeline(&build_pipeline(input)?, &StreamSink::new(emit, *skip, *fetch)),
        PhysicalPlan::Window { input, specs, schema } => match run_pipeline(&build_pipeline(input)?, &WindowSink::new(specs.clone(), schema.clone()))? {
            Windowed::Batches(b) => b.into_iter().try_for_each(emit),
            Windowed::Partitions(p) => run_pipeline(&Pipeline::new(Arc::new(p)), &StreamSink::new(emit, 0, None)),
        },
        PhysicalPlan::Aggregate { .. } | PhysicalPlan::Values { .. } | PhysicalPlan::RecursiveQuery { .. } => {
            execute(plan)?.into_iter().try_for_each(emit)
        }
        _ => run_pipeline(&build_pipeline(plan)?, &StreamSink::new(emit, 0, None)),
    }
}

fn build_pipeline(plan: &PhysicalPlan) -> Result<Pipeline> {
    Ok(match plan {
        PhysicalPlan::Source { source, .. } => Pipeline::new(source.clone()),
        PhysicalPlan::Filter { input, predicate, projection, .. } => build_pipeline(input)?
            .with_op(Arc::new(FilterOp { predicate: predicate.clone(), projection: projection.clone() })),
        PhysicalPlan::Project { input, exprs, schema } => {
            build_pipeline(input)?.with_op(Arc::new(ProjectOp { exprs: exprs.clone(), schema: schema.clone() }))
        }
        PhysicalPlan::HashJoin { probe, build, probe_keys, build_keys, join_type, filter, joined_schema, schema, order, mark_build } => {
            let build_pipe = build_pipeline(build)?;
            let track_matches = matches!(join_type, JoinType::Full | JoinType::Right) || *mark_build;
            let sink = JoinBuildSink::new(build_keys.clone(), build.schema(), track_matches);
            let table = match run_pipeline(&build_pipe, &sink)? {
                BuildSide::Table(t) => Arc::new(t),
                BuildSide::Spilled(build_parts) => {
                    // grace hash join: the probe side is partitioned like the build side
                    let probe_sink = PartitionSink::new(probe_keys.clone(), probe.schema(), build_parts.len());
                    let probe_parts = run_pipeline(&build_pipeline(probe)?, &probe_sink)?;
                    let join = GraceJoin {
                        build_keys: build_keys.clone(),
                        build_schema: build.schema(),
                        probe_keys: probe_keys.clone(),
                        join_type: *join_type,
                        filter: filter.clone(),
                        joined_schema: joined_schema.clone(),
                        output_schema: schema.clone(),
                        order: order.clone(),
                        mark_build: *mark_build,
                    };
                    return Ok(Pipeline::new(Arc::new(GraceJoinSource::new(join, build_parts, probe_parts))));
                }
            };
            let op = Arc::new(HashJoinProbe {
                table: table.clone(),
                probe_keys: probe_keys.clone(),
                join_type: *join_type,
                filter: filter.clone(),
                joined_schema: joined_schema.clone(),
                output_schema: schema.clone(),
                order: order.clone(),
                mark_only: *mark_build,
            });
            if *mark_build {
                // run the probe side only to mark matches, then stream the kept build rows
                run_pipeline(&build_pipeline(probe)?.with_op(op), &NullSink)?;
                let rows = table.rows_by_match(*join_type == JoinType::Semi)?;
                return Ok(Pipeline::new(Arc::new(MemorySource::new(rows, schema.clone(), "SemiJoinMarked"))));
            }
            build_pipeline(probe)?.with_op(op)
        }
        PhysicalPlan::NestedLoopJoin { probe, build, join_type, filter, joined_schema, schema, order } => {
            let batches = execute(build)?;
            let bschema = build.schema();
            let build_batch = if batches.is_empty() {
                RecordBatch::new_empty(bschema.clone())
            } else {
                concat_parallel(&bschema, &batches)?
            };
            build_pipeline(probe)?.with_op(Arc::new(NestedLoopJoin {
                build: build_batch,
                join_type: *join_type,
                filter: filter.clone(),
                joined_schema: joined_schema.clone(),
                output_schema: schema.clone(),
                order: order.clone(),
            }))
        }
        PhysicalPlan::Union { inputs, schema } => {
            let pipes = inputs.iter().map(build_pipeline).collect::<Result<Vec<_>>>()?;
            Pipeline::new(Arc::new(UnionSource::new(pipes, schema.clone())))
        }
        // spilled window partitions are evaluated one per morsel, in the next pipeline
        PhysicalPlan::Window { input, specs, schema } => match run_pipeline(&build_pipeline(input)?, &WindowSink::new(specs.clone(), schema.clone()))? {
            Windowed::Batches(b) => Pipeline::new(Arc::new(MemorySource::new(b, schema.clone(), "Materialized"))),
            Windowed::Partitions(p) => Pipeline::new(Arc::new(p)),
        },
        PhysicalPlan::Aggregate { .. }
        | PhysicalPlan::Sort { .. }
        | PhysicalPlan::Limit { .. }
        | PhysicalPlan::Values { .. }
        | PhysicalPlan::RecursiveQuery { .. } => {
            let batches = execute(plan)?;
            Pipeline::new(Arc::new(MemorySource::new(batches, plan.schema(), "Materialized")))
        }
    })
}
