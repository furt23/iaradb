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
use crate::io::LateRows;
use crate::logical::{LogicalPlan, Sort};
use crate::physical::expr::{PhysExpr, PhysSortExpr, cast_expr};
use crate::physical::planner::PhysicalPlan;
use crate::schema::PlanSchema;

/// Largest k this applies to.
const MAX_FETCH: usize = 10_000;

/// `s` planned with late materialization, when it applies and pays off.
pub fn plan(s: &Sort, compile: &dyn Fn(&Expr, &PlanSchema) -> Result<PhysExpr>) -> Result<Option<PhysicalPlan>> {
    let Some(k) = s.fetch.filter(|&k| k <= MAX_FETCH) else { return Ok(None) };
    let (predicate, scan) = match s.input.as_ref() {
        LogicalPlan::Filter(f) => match f.input.as_ref() {
            LogicalPlan::Scan(sc) => (Some(&f.predicate), sc),
            _ => return Ok(None),
        },
        LogicalPlan::Scan(sc) => (None, sc),
        _ => return Ok(None),
    };
    if scan.fetch.is_some() || predicate.is_some_and(|p| p.contains_subquery()) {
        return Ok(None);
    }
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
    let source = rows.positioned_source(&needed_table, &scan.filters)?;
    let schema = source.schema();
    let mut node = PhysicalPlan::Source { source, schema: schema.clone() };
    if let Some(p) = predicate {
        let predicate = cast_expr(compile(p, narrow_schema)?, &DataType::Boolean)?;
        node = PhysicalPlan::Filter { input: Box::new(node), predicate, projection: None, schema: schema.clone() };
    }
    let keys = |schema: &PlanSchema| -> Result<Vec<PhysSortExpr>> {
        s.exprs
            .iter()
            .map(|e| Ok(PhysSortExpr { expr: compile(&e.expr, schema)?, descending: e.descending, nulls_first: e.nulls_first }))
            .collect()
    };
    let top = PhysicalPlan::Sort { input: Box::new(node), keys: keys(narrow_schema)?, fetch: Some(k), schema };
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
    Ok(Some(PhysicalPlan::Sort { input: Box::new(source), keys: keys(s.input.schema())?, fetch: s.fetch, schema: out_schema }))
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
