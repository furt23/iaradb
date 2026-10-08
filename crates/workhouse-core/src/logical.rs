//! Logical query plans.

use std::fmt::{self, Write as _};
use std::sync::Arc;

use arrow::datatypes::{Field, SchemaRef};
use arrow::record_batch::RecordBatch;

use crate::error::{Result, WhError};
use crate::expr::{Expr, SortExpr};
use crate::io::TableProvider;
use crate::io::work_table::WorkTable;
use crate::schema::{PlanSchema, PlanSchemaRef, QualifiedField};
use crate::types::comparison_common;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum JoinType {
    Inner,
    Left,
    Right,
    Full,
    Semi,
    Anti,
}

impl JoinType {
    pub fn parse(s: &str) -> Result<Self> {
        Ok(match s.to_ascii_lowercase().as_str() {
            "inner" => JoinType::Inner,
            "left" | "left_outer" | "leftouter" => JoinType::Left,
            "right" | "right_outer" | "rightouter" => JoinType::Right,
            "full" | "outer" | "full_outer" | "fullouter" => JoinType::Full,
            "semi" | "left_semi" | "leftsemi" => JoinType::Semi,
            "anti" | "left_anti" | "leftanti" => JoinType::Anti,
            o => return Err(WhError::Plan(format!("unknown join type '{o}'"))),
        })
    }
}

#[derive(Clone, Debug)]
pub struct Scan {
    pub table_name: String,
    pub qualifier: Option<String>,
    pub source: Arc<dyn TableProvider>,
    pub projection: Option<Vec<usize>>,
    /// Predicates usable by the source for pruning (the Filter above stays).
    pub filters: Vec<Expr>,
    pub fetch: Option<usize>,
    pub schema: PlanSchemaRef,
}

#[derive(Clone, Debug)]
pub struct Filter {
    pub input: Arc<LogicalPlan>,
    pub predicate: Expr,
}

#[derive(Clone, Debug)]
pub struct Projection {
    pub input: Arc<LogicalPlan>,
    pub exprs: Vec<Expr>,
    pub schema: PlanSchemaRef,
}

#[derive(Clone, Debug)]
pub struct Aggregate {
    pub input: Arc<LogicalPlan>,
    pub group_by: Vec<Expr>,
    pub aggs: Vec<Expr>,
    pub schema: PlanSchemaRef,
}

#[derive(Clone, Debug)]
pub struct Join {
    pub left: Arc<LogicalPlan>,
    pub right: Arc<LogicalPlan>,
    pub on: Vec<(Expr, Expr)>,
    pub filter: Option<Expr>,
    pub join_type: JoinType,
    pub schema: PlanSchemaRef,
}

#[derive(Clone, Debug)]
pub struct Sort {
    pub input: Arc<LogicalPlan>,
    pub exprs: Vec<SortExpr>,
    pub fetch: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct Limit {
    pub input: Arc<LogicalPlan>,
    pub skip: usize,
    pub fetch: Option<usize>,
}

#[derive(Clone, Debug)]
pub struct Union {
    pub inputs: Vec<Arc<LogicalPlan>>,
    pub schema: PlanSchemaRef,
}

#[derive(Clone, Debug)]
pub struct SubqueryAlias {
    pub input: Arc<LogicalPlan>,
    pub alias: String,
    pub schema: PlanSchemaRef,
}

#[derive(Clone, Debug)]
pub struct Values {
    pub schema: PlanSchemaRef,
    pub batches: Vec<RecordBatch>,
}

/// Window functions: the input columns followed by one column per window
/// expression (rows keep their input order).
#[derive(Clone, Debug)]
pub struct Window {
    pub input: Arc<LogicalPlan>,
    pub exprs: Vec<Expr>,
    pub schema: PlanSchemaRef,
}

/// `WITH RECURSIVE name AS (static UNION [ALL] recursive)`: the recursive
/// term reads the rows of the previous iteration from `work_table` and runs
/// until it produces no new rows.
#[derive(Clone, Debug)]
pub struct RecursiveQuery {
    pub name: String,
    pub static_term: Arc<LogicalPlan>,
    pub recursive_term: Arc<LogicalPlan>,
    pub work_table: Arc<WorkTable>,
    /// UNION (rows already produced are discarded) instead of UNION ALL
    pub distinct: bool,
    /// stop once this many rows were produced (a LIMIT above the CTE)
    pub fetch: Option<usize>,
    pub schema: PlanSchemaRef,
}

#[derive(Clone, Debug)]
pub enum LogicalPlan {
    Scan(Scan),
    Filter(Filter),
    Projection(Projection),
    Aggregate(Aggregate),
    Join(Join),
    Sort(Sort),
    Limit(Limit),
    Union(Union),
    SubqueryAlias(SubqueryAlias),
    Values(Values),
    Window(Window),
    RecursiveQuery(RecursiveQuery),
}

fn expand_wildcards(exprs: Vec<Expr>, schema: &PlanSchema) -> Result<Vec<Expr>> {
    let mut out = Vec::with_capacity(exprs.len());
    for e in exprs {
        match e {
            Expr::Wildcard { qualifier } => {
                let mut any = false;
                for f in schema.fields() {
                    let keep = match (&qualifier, &f.qualifier) {
                        (None, _) => true,
                        (Some(q), Some(fq)) => q.eq_ignore_ascii_case(fq),
                        (Some(_), None) => false,
                    };
                    if keep {
                        any = true;
                        out.push(Expr::Column(f.column()));
                    }
                }
                if !any {
                    if let Some(q) = qualifier {
                        return Err(WhError::Plan(format!("no columns found for '{q}.*'")));
                    }
                }
            }
            e => out.push(e),
        }
    }
    Ok(out)
}

impl LogicalPlan {
    pub fn schema(&self) -> &PlanSchemaRef {
        match self {
            LogicalPlan::Scan(s) => &s.schema,
            LogicalPlan::Filter(f) => f.input.schema(),
            LogicalPlan::Projection(p) => &p.schema,
            LogicalPlan::Aggregate(a) => &a.schema,
            LogicalPlan::Join(j) => &j.schema,
            LogicalPlan::Sort(s) => s.input.schema(),
            LogicalPlan::Limit(l) => l.input.schema(),
            LogicalPlan::Union(u) => &u.schema,
            LogicalPlan::SubqueryAlias(s) => &s.schema,
            LogicalPlan::Values(v) => &v.schema,
            LogicalPlan::Window(w) => &w.schema,
            LogicalPlan::RecursiveQuery(r) => &r.schema,
        }
    }

    pub fn inputs(&self) -> Vec<&Arc<LogicalPlan>> {
        match self {
            LogicalPlan::Scan(_) | LogicalPlan::Values(_) => vec![],
            LogicalPlan::Filter(f) => vec![&f.input],
            LogicalPlan::Projection(p) => vec![&p.input],
            LogicalPlan::Aggregate(a) => vec![&a.input],
            LogicalPlan::Join(j) => vec![&j.left, &j.right],
            LogicalPlan::Sort(s) => vec![&s.input],
            LogicalPlan::Limit(l) => vec![&l.input],
            LogicalPlan::Union(u) => u.inputs.iter().collect(),
            LogicalPlan::SubqueryAlias(s) => vec![&s.input],
            LogicalPlan::Window(w) => vec![&w.input],
            LogicalPlan::RecursiveQuery(r) => vec![&r.static_term, &r.recursive_term],
        }
    }

    /// Rebuild the node on top of new inputs (recomputing its schema).
    pub fn with_new_inputs(&self, mut inputs: Vec<Arc<LogicalPlan>>) -> Result<LogicalPlan> {
        Ok(match self {
            LogicalPlan::Scan(_) | LogicalPlan::Values(_) => self.clone(),
            LogicalPlan::Filter(f) => LogicalPlan::filter(inputs.remove(0), f.predicate.clone())?,
            LogicalPlan::Projection(p) => LogicalPlan::project(inputs.remove(0), p.exprs.clone())?,
            LogicalPlan::Aggregate(a) => {
                LogicalPlan::aggregate(inputs.remove(0), a.group_by.clone(), a.aggs.clone())?
            }
            LogicalPlan::Join(j) => {
                let left = inputs.remove(0);
                let right = inputs.remove(0);
                LogicalPlan::join(left, right, j.on.clone(), j.filter.clone(), j.join_type)?
            }
            LogicalPlan::Sort(s) => LogicalPlan::sort(inputs.remove(0), s.exprs.clone(), s.fetch)?,
            LogicalPlan::Limit(l) => LogicalPlan::limit(inputs.remove(0), l.skip, l.fetch),
            LogicalPlan::Union(_) => LogicalPlan::union(inputs)?,
            LogicalPlan::SubqueryAlias(s) => LogicalPlan::subquery_alias(inputs.remove(0), &s.alias),
            LogicalPlan::Window(w) => LogicalPlan::window(inputs.remove(0), w.exprs.clone())?,
            LogicalPlan::RecursiveQuery(r) => {
                let static_term = inputs.remove(0);
                let recursive_term = inputs.remove(0);
                LogicalPlan::RecursiveQuery(RecursiveQuery { static_term, recursive_term, ..r.clone() })
            }
        })
    }

    // -----------------------------------------------------------------------
    // constructors
    // -----------------------------------------------------------------------

    pub fn scan(
        table_name: &str,
        qualifier: Option<String>,
        source: Arc<dyn TableProvider>,
        projection: Option<Vec<usize>>,
        filters: Vec<Expr>,
        fetch: Option<usize>,
    ) -> Result<LogicalPlan> {
        let full = source.schema();
        let arrow = match &projection {
            Some(p) => Arc::new(full.project(p)?),
            None => full,
        };
        let schema = Arc::new(PlanSchema::from_arrow(qualifier.as_deref(), &arrow));
        Ok(LogicalPlan::Scan(Scan {
            table_name: table_name.to_string(),
            qualifier,
            source,
            projection,
            filters,
            fetch,
            schema,
        }))
    }

    pub fn filter(input: Arc<LogicalPlan>, predicate: Expr) -> Result<LogicalPlan> {
        let dt = predicate.data_type(input.schema())?;
        if !matches!(dt, arrow::datatypes::DataType::Boolean | arrow::datatypes::DataType::Null) {
            return Err(WhError::Plan(format!("filter predicate must be boolean, got {dt}: {predicate}")));
        }
        Ok(LogicalPlan::Filter(Filter { input, predicate }))
    }

    pub fn project(input: Arc<LogicalPlan>, exprs: Vec<Expr>) -> Result<LogicalPlan> {
        let exprs = expand_wildcards(exprs, input.schema())?;
        let fields = exprs
            .iter()
            .map(|e| {
                if e.contains_agg() {
                    return Err(WhError::Plan(format!(
                        "aggregate expression '{e}' used outside of an aggregation context"
                    )));
                }
                e.to_field(input.schema())
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(LogicalPlan::Projection(Projection { input, exprs, schema: Arc::new(PlanSchema::new(fields)) }))
    }

    pub fn aggregate(input: Arc<LogicalPlan>, group_by: Vec<Expr>, aggs: Vec<Expr>) -> Result<LogicalPlan> {
        let group_by = expand_wildcards(group_by, input.schema())?;
        let mut fields = Vec::with_capacity(group_by.len() + aggs.len());
        for g in &group_by {
            if g.contains_agg() {
                return Err(WhError::Plan(format!("aggregate '{g}' is not allowed in GROUP BY")));
            }
            fields.push(g.to_field(input.schema())?);
        }
        for a in &aggs {
            if !matches!(a.unalias_ref(), Expr::Agg { .. }) {
                return Err(WhError::Plan(format!("'{a}' is not an aggregate expression")));
            }
            fields.push(a.to_field(input.schema())?);
        }
        Ok(LogicalPlan::Aggregate(Aggregate {
            input,
            group_by,
            aggs,
            schema: Arc::new(PlanSchema::new(fields)),
        }))
    }

    pub fn join(
        left: Arc<LogicalPlan>,
        right: Arc<LogicalPlan>,
        on: Vec<(Expr, Expr)>,
        filter: Option<Expr>,
        join_type: JoinType,
    ) -> Result<LogicalPlan> {
        for (l, r) in &on {
            l.data_type(left.schema())?;
            r.data_type(right.schema())?;
        }
        let nullable = |s: &PlanSchema| -> Vec<QualifiedField> {
            s.fields()
                .iter()
                .map(|f| QualifiedField {
                    qualifier: f.qualifier.clone(),
                    field: Arc::new(f.field.as_ref().clone().with_nullable(true)),
                })
                .collect()
        };
        let ls = left.schema();
        let rs = right.schema();
        let schema = match join_type {
            JoinType::Inner => PlanSchema::join(ls, rs),
            JoinType::Left => {
                let mut f = ls.fields().to_vec();
                f.extend(nullable(rs));
                PlanSchema::new(f)
            }
            JoinType::Right => {
                let mut f = nullable(ls);
                f.extend(rs.fields().iter().cloned());
                PlanSchema::new(f)
            }
            JoinType::Full => {
                let mut f = nullable(ls);
                f.extend(nullable(rs));
                PlanSchema::new(f)
            }
            JoinType::Semi | JoinType::Anti => ls.as_ref().clone(),
        };
        if let Some(f) = &filter {
            f.data_type(&PlanSchema::join(ls, rs))?;
        }
        Ok(LogicalPlan::Join(Join { left, right, on, filter, join_type, schema: Arc::new(schema) }))
    }

    pub fn sort(input: Arc<LogicalPlan>, exprs: Vec<SortExpr>, fetch: Option<usize>) -> Result<LogicalPlan> {
        for e in &exprs {
            e.expr.data_type(input.schema())?;
        }
        Ok(LogicalPlan::Sort(Sort { input, exprs, fetch }))
    }

    pub fn limit(input: Arc<LogicalPlan>, skip: usize, fetch: Option<usize>) -> LogicalPlan {
        LogicalPlan::Limit(Limit { input, skip, fetch })
    }

    pub fn union(inputs: Vec<Arc<LogicalPlan>>) -> Result<LogicalPlan> {
        if inputs.is_empty() {
            return Err(WhError::Plan("UNION requires at least one input".into()));
        }
        let first = inputs[0].schema().clone();
        let n = first.len();
        for i in &inputs {
            if i.schema().len() != n {
                return Err(WhError::Plan(format!(
                    "UNION inputs have different column counts ({} vs {})",
                    n,
                    i.schema().len()
                )));
            }
        }
        // compute common types per position, cast inputs where needed
        let mut types = vec![];
        let mut nullables = vec![false; n];
        for c in 0..n {
            let mut t = first.field(c).data_type().clone();
            for i in &inputs {
                let f = i.schema().field(c);
                nullables[c] |= f.is_nullable();
                t = comparison_common(&t, f.data_type()).ok_or_else(|| {
                    WhError::Plan(format!("UNION column {c} has incompatible types {t} and {}", f.data_type()))
                })?;
            }
            types.push(t);
        }
        let mut new_inputs = Vec::with_capacity(inputs.len());
        for i in inputs {
            let s = i.schema().clone();
            let needs_cast = (0..n).any(|c| s.field(c).data_type() != &types[c]);
            if needs_cast {
                let exprs = (0..n)
                    .map(|c| {
                        let col = Expr::Column(s.column(c));
                        if s.field(c).data_type() != &types[c] {
                            col.cast(types[c].clone()).alias(s.field(c).name().clone())
                        } else {
                            col
                        }
                    })
                    .collect();
                new_inputs.push(Arc::new(LogicalPlan::project(i, exprs)?));
            } else {
                new_inputs.push(i);
            }
        }
        let fields = (0..n)
            .map(|c| {
                QualifiedField::new(
                    first.qualified_field(c).qualifier.clone(),
                    Field::new(first.field(c).name(), types[c].clone(), nullables[c]),
                )
            })
            .collect();
        Ok(LogicalPlan::Union(Union { inputs: new_inputs, schema: Arc::new(PlanSchema::new(fields)) }))
    }

    pub fn window(input: Arc<LogicalPlan>, exprs: Vec<Expr>) -> Result<LogicalPlan> {
        let mut fields = input.schema().fields().to_vec();
        for e in &exprs {
            let Expr::Window(w) = e.unalias_ref() else {
                return Err(WhError::Plan(format!("'{e}' is not a window function")));
            };
            w.validate()?;
            for x in w.args.iter().chain(&w.partition_by).chain(w.order_by.iter().map(|o| &o.expr)) {
                if x.contains_agg() || x.contains_window() {
                    return Err(WhError::Plan(format!("aggregates and window functions cannot be nested in '{e}'")));
                }
            }
            fields.push(e.to_field(input.schema())?);
        }
        Ok(LogicalPlan::Window(Window { input, exprs, schema: Arc::new(PlanSchema::new(fields)) }))
    }

    pub fn recursive_query(
        name: &str,
        static_term: Arc<LogicalPlan>,
        recursive_term: Arc<LogicalPlan>,
        work_table: Arc<WorkTable>,
        distinct: bool,
    ) -> Result<LogicalPlan> {
        let (s, r) = (static_term.schema(), recursive_term.schema());
        if s.len() != r.len() {
            return Err(WhError::Plan(format!(
                "recursive CTE '{name}': the recursive term returns {} columns, the base term {}",
                r.len(),
                s.len()
            )));
        }
        let schema = Arc::new(PlanSchema::from_arrow(None, &work_table.schema()));
        Ok(LogicalPlan::RecursiveQuery(RecursiveQuery {
            name: name.to_string(),
            static_term,
            recursive_term,
            work_table,
            distinct,
            fetch: None,
            schema,
        }))
    }

    pub fn subquery_alias(input: Arc<LogicalPlan>, alias: &str) -> LogicalPlan {
        let schema = Arc::new(input.schema().with_qualifier(alias));
        LogicalPlan::SubqueryAlias(SubqueryAlias { input, alias: alias.to_string(), schema })
    }

    pub fn values(schema: SchemaRef, batches: Vec<RecordBatch>) -> LogicalPlan {
        LogicalPlan::Values(Values { schema: Arc::new(PlanSchema::from_arrow(None, &schema)), batches })
    }

    /// A relation with one row and no columns (`SELECT 1`).
    pub fn one_row() -> Result<LogicalPlan> {
        let schema = Arc::new(arrow::datatypes::Schema::empty());
        let batch = RecordBatch::try_new_with_options(
            schema.clone(),
            vec![],
            &arrow::record_batch::RecordBatchOptions::new().with_row_count(Some(1)),
        )?;
        Ok(LogicalPlan::values(schema, vec![batch]))
    }

    // -----------------------------------------------------------------------
    // display
    // -----------------------------------------------------------------------

    fn node_line(&self) -> String {
        let list = |v: &[Expr]| v.iter().map(|e| e.to_string()).collect::<Vec<_>>().join(", ");
        match self {
            LogicalPlan::Scan(s) => {
                let mut line = format!("Scan: {} [{}]", s.table_name, s.source.kind());
                if let Some(q) = &s.qualifier {
                    if q != &s.table_name {
                        let _ = write!(line, " AS {q}");
                    }
                }
                let cols: Vec<String> = s.schema.fields().iter().map(|f| f.name().to_string()).collect();
                let _ = write!(line, " projection=[{}]", cols.join(", "));
                if !s.filters.is_empty() {
                    let _ = write!(line, " pruning_filters=[{}]", list(&s.filters));
                }
                if let Some(f) = s.fetch {
                    let _ = write!(line, " fetch={f}");
                }
                line
            }
            LogicalPlan::Filter(f) => format!("Filter: {}", f.predicate),
            LogicalPlan::Projection(p) => format!("Projection: {}", list(&p.exprs)),
            LogicalPlan::Aggregate(a) => {
                format!("Aggregate: groupBy=[{}], aggr=[{}]", list(&a.group_by), list(&a.aggs))
            }
            LogicalPlan::Join(j) => {
                let on: Vec<String> = j.on.iter().map(|(l, r)| format!("{l} = {r}")).collect();
                let mut s = format!("{:?} Join: on=[{}]", j.join_type, on.join(", "));
                if let Some(f) = &j.filter {
                    let _ = write!(s, " filter={f}");
                }
                if j.on.is_empty() && j.filter.is_none() && j.join_type == JoinType::Inner {
                    s = "Cross Join".to_string();
                }
                s
            }
            LogicalPlan::Sort(s) => {
                let e: Vec<String> = s.exprs.iter().map(|e| e.to_string()).collect();
                match s.fetch {
                    Some(f) => format!("TopK: k={f}, by=[{}]", e.join(", ")),
                    None => format!("Sort: {}", e.join(", ")),
                }
            }
            LogicalPlan::Limit(l) => format!(
                "Limit: skip={}, fetch={}",
                l.skip,
                l.fetch.map(|f| f.to_string()).unwrap_or_else(|| "None".into())
            ),
            LogicalPlan::Union(_) => "Union All".to_string(),
            LogicalPlan::SubqueryAlias(s) => format!("SubqueryAlias: {}", s.alias),
            LogicalPlan::Values(v) => format!(
                "Values: {} rows, {} columns",
                v.batches.iter().map(|b| b.num_rows()).sum::<usize>(),
                v.schema.len()
            ),
            LogicalPlan::Window(w) => format!("Window: {}", list(&w.exprs)),
            LogicalPlan::RecursiveQuery(r) => {
                let mut line = format!("RecursiveQuery: {} [UNION{}]", r.name, if r.distinct { "" } else { " ALL" });
                if let Some(f) = r.fetch {
                    let _ = write!(line, " fetch={f}");
                }
                line
            }
        }
    }

    pub fn display_indent(&self) -> String {
        let mut out = String::new();
        fn go(p: &LogicalPlan, depth: usize, out: &mut String) {
            let _ = writeln!(out, "{}{}", "  ".repeat(depth), p.node_line());
            for i in p.inputs() {
                go(i, depth + 1, out);
            }
        }
        go(self, 0, &mut out);
        out
    }
}

impl fmt::Display for LogicalPlan {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.display_indent())
    }
}
