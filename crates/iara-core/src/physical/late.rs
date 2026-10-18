//! Late materialization of `ORDER BY ... LIMIT k` over a (filtered) scan of
//! a table that reads rows by position ([`crate::io::LateRows`]): the filter
//! and the top k run on the columns they need plus each row's position,
//! then the other columns are read for the k rows only. A wide
//! `SELECT * ... WHERE ... ORDER BY t LIMIT 10` decodes the filter and sort
//! columns of the table instead of all of them.

use std::sync::Arc;

use arrow::array::AsArray;
use arrow::datatypes::{DataType, SchemaRef, UInt64Type};
use arrow::record_batch::{RecordBatch, RecordBatchOptions};

use crate::error::Result;
use crate::exec::pipeline::{Emit, Source};
use crate::exec::query::QueryHandle;
use crate::expr::Expr;
use crate::exec::topk_bound::TopKBound;
use crate::io::{LateRows, ScanBound};
use crate::logical::{LogicalPlan, Scan, Sort};
use crate::physical::expr::{PhysExpr, PhysSortExpr, cast_expr};
use crate::physical::planner::PhysicalPlan;
use crate::schema::PlanSchema;

/// Largest k this applies to.
const MAX_FETCH: usize = 10_000;

type Compile<'a> = &'a dyn Fn(&Expr, &PlanSchema) -> Result<PhysExpr>;

/// The (filtered) scan a top k of at most [`MAX_FETCH`] rows reads directly.
fn top_of_scan(s: &Sort) -> Option<(usize, Option<&Expr>, &Scan)> {
    let k = s.fetch.filter(|&k| k <= MAX_FETCH)?;
    let (predicate, scan) = match s.input.as_ref() {
        LogicalPlan::Filter(f) => match f.input.as_ref() {
            LogicalPlan::Scan(sc) => (Some(&f.predicate), sc),
            _ => return None,
        },
        LogicalPlan::Scan(sc) => (None, sc),
        _ => return None,
    };
    if scan.fetch.is_some() || predicate.is_some_and(|p| p.contains_subquery()) {
        return None;
    }
    Some((k, predicate, scan))
}

/// A running bound for the top k on its first key, when that key is a
/// column of `scan` with ordinals (see [`crate::exec::topk_bound`]).
fn scan_bound(s: &Sort, scan: &Scan) -> Option<ScanBound> {
    let first = s.exprs.first()?;
    let i = scan.schema.maybe_index_of(first.expr.as_column()?).ok()??;
    bound_on(scan, i, first.descending, first.nulls_first)
}

fn bound_on(scan: &Scan, i: usize, descending: bool, nulls_first: bool) -> Option<ScanBound> {
    let column = scan.projection.as_ref().map_or(i, |p| p[i]);
    TopKBound::supports(scan.source.schema().field(column).data_type())
        .then(|| ScanBound { column, bound: Arc::new(TopKBound::new(descending, nulls_first)) })
}

/// The scan under a top k whose rows map one to one (or are dropped) up to
/// the sort, through filters, plain column projections and aliases, with a
/// running bound on the column the sort's first key reads. Dropping a scan
/// row past the bound only drops sort input rows past it.
pub fn bounded_scan(s: &Sort) -> Option<(*const Scan, ScanBound)> {
    s.fetch.filter(|&k| k <= MAX_FETCH)?;
    let first = s.exprs.first()?;
    let mut col = first.expr.as_column()?.clone();
    let mut plan = s.input.as_ref();
    loop {
        match plan {
            // nothing else is planned while the scan is: a subquery could read the same scan
            LogicalPlan::Filter(f) if !f.predicate.contains_subquery() => plan = f.input.as_ref(),
            LogicalPlan::Projection(p) if !p.exprs.iter().any(|e| e.contains_subquery()) => {
                let i = p.schema.maybe_index_of(&col).ok()??;
                col = p.exprs[i].unalias_ref().as_column()?.clone();
                plan = p.input.as_ref();
            }
            LogicalPlan::SubqueryAlias(a) => {
                let i = a.schema.maybe_index_of(&col).ok()??;
                col = a.input.schema().column(i);
                plan = a.input.as_ref();
            }
            LogicalPlan::Scan(scan) if scan.fetch.is_none() => {
                let i = scan.schema.maybe_index_of(&col).ok()??;
                return Some((scan as *const Scan, bound_on(scan, i, first.descending, first.nulls_first)?));
            }
            _ => return None,
        }
    }
}

fn sort_keys(s: &Sort, schema: &PlanSchema, compile: Compile<'_>) -> Result<Vec<PhysSortExpr>> {
    s.exprs
        .iter()
        .map(|e| Ok(PhysSortExpr { expr: compile(&e.expr, schema)?, descending: e.descending, nulls_first: e.nulls_first }))
        .collect()
}

/// `s` planned with late materialization, when it applies and pays off.
pub fn plan(s: &Sort, compile: Compile<'_>) -> Result<Option<PhysicalPlan>> {
    let Some((k, predicate, scan)) = top_of_scan(s) else { return Ok(None) };
    let Some(rows) = scan.source.late_rows() else { return Ok(None) };
    let table = scan.source.schema();
    let all: Vec<usize> = scan.projection.clone().unwrap_or_else(|| (0..table.fields().len()).collect());
    // scan columns the filter and the sort read
    let mut needed: Vec<usize> = vec![];
    let refs = s.exprs.iter().flat_map(|e| e.expr.column_refs()).chain(predicate.into_iter().flat_map(|p| p.column_refs()));
    for c in refs {
        match scan.schema.maybe_index_of(&c)? {
            Some(i) if !needed.contains(&i) => needed.push(i),
            Some(_) => {}
            None => return Ok(None),
        }
    }
    needed.sort_unstable();
    let rest: Vec<usize> = (0..all.len()).filter(|i| !needed.contains(i)).collect();
    let wide = |i: &usize| !table.field(all[*i]).data_type().is_primitive();
    if needed.is_empty() || (rest.len() < 3 && !rest.iter().any(wide)) {
        return Ok(None);
    }
    // phase 1: filter and top k over the needed columns and the positions
    let needed_table: Vec<usize> = needed.iter().map(|&i| all[i]).collect();
    let narrow = LogicalPlan::scan(&scan.table_name, scan.qualifier.clone(), scan.source.clone(), Some(needed_table.clone()), scan.filters.clone(), None)?;
    let narrow_schema = narrow.schema();
    let bound = scan_bound(s, scan);
    let source = rows.positioned_source(&needed_table, &scan.filters, bound.as_ref())?;
    let schema = source.schema();
    let mut node = PhysicalPlan::Source { source, schema: schema.clone() };
    if let Some(p) = predicate {
        let predicate = cast_expr(compile(p, narrow_schema)?, &DataType::Boolean)?;
        node = PhysicalPlan::Filter { input: Box::new(node), predicate, projection: None, schema: schema.clone() };
    }
    let keys = |schema: &PlanSchema| sort_keys(s, schema, compile);
    let top = PhysicalPlan::Sort { input: Box::new(node), keys: keys(narrow_schema)?, fetch: Some(k), schema, bound: bound.map(|b| b.bound) };
    // phase 2 as the source of the original sort (which orders the k rows)
    let out_schema: SchemaRef = Arc::new(table.project(&all)?);
    let late = LateSource {
        top,
        rows,
        needed,
        rest_table: rest.iter().map(|&i| all[i]).collect(),
        schema: out_schema.clone(),
        query: crate::exec::query::current(),
    };
    let source = PhysicalPlan::Source { source: Arc::new(late), schema: out_schema.clone() };
    Ok(Some(PhysicalPlan::Sort { input: Box::new(source), keys: keys(s.input.schema())?, fetch: s.fetch, schema: out_schema, bound: None }))
}

struct LateSource {
    /// top k rows: the needed columns, then the positions
    top: PhysicalPlan,
    rows: Arc<dyn LateRows>,
    /// output columns phase 1 provides (in order)
    needed: Vec<usize>,
    /// table columns read by position, for the other output columns (in order)
    rest_table: Vec<usize>,
    schema: SchemaRef,
    query: Option<Arc<QueryHandle>>,
}

impl Source for LateSource {
    fn num_morsels(&self) -> usize {
        1
    }

    fn run_morsel(&self, _morsel: usize, emit: Emit<'_>) -> Result<()> {
        let batches = crate::exec::query::joined(self.query.clone(), || crate::physical::execute::execute(&self.top))?;
        let top_schema = self.top.schema();
        let top = arrow::compute::concat_batches(&top_schema, &batches)?;
        if top.num_rows() == 0 {
            return Ok(());
        }
        let positions = top.column(top.num_columns() - 1).as_primitive::<UInt64Type>().values();
        let fetched = self.rows.fetch(&self.rest_table, positions)?;
        let (mut from_top, mut from_fetch) = (0, 0);
        let cols = (0..self.schema.fields().len())
            .map(|i| {
                if self.needed.get(from_top) == Some(&i) {
                    from_top += 1;
                    top.column(from_top - 1).clone()
                } else {
                    from_fetch += 1;
                    fetched.column(from_fetch - 1).clone()
                }
            })
            .collect();
        emit(RecordBatch::try_new_with_options(self.schema.clone(), cols, &RecordBatchOptions::new().with_row_count(Some(top.num_rows())))?)
    }

    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }

    fn describe(&self) -> String {
        format!(
            "LateMaterialize[top rows over {} of {} columns, the others read by position]",
            self.needed.len(),
            self.schema.fields().len()
        )
    }
}
