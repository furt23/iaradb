//! Session context (catalog) and the lazy DataFrame API.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::datatypes::SchemaRef;
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use parking_lot::RwLock;

use crate::error::{Result, WhError};
use crate::exec::query::{QueryStats, with_query};
use crate::expr::{Expr, SortExpr};
use crate::io::TableProvider;
use crate::io::csv::{CsvOptions, CsvTable};
use crate::io::memory::MemTable;
use crate::io::options::StorageOptions;
use crate::io::parquet::ParquetTable;
use crate::logical::{JoinType, LogicalPlan};
use crate::optimizer::optimize;
use crate::physical::planner::{PhysicalPlan, PlanNode, create_physical_plan, execute, execute_stream};
use crate::schema::{Column, PlanSchema, PlanSchemaRef};

#[derive(Clone, Debug)]
pub enum TableEntry {
    Table(Arc<dyn TableProvider>),
    View(Arc<LogicalPlan>),
}

type Loader = Box<dyn Fn() -> Result<Arc<dyn TableProvider>> + Send + Sync>;

/// A table loaded on first use (its files listed, footers read): a
/// workspace registers all its tables up front without touching storage,
/// and one that cannot be read fails only the queries that use it.
pub struct DeferredTable {
    load: Loader,
    loaded: parking_lot::Mutex<Option<Arc<dyn TableProvider>>>,
}

impl DeferredTable {
    pub fn new(load: impl Fn() -> Result<Arc<dyn TableProvider>> + Send + Sync + 'static) -> Self {
        Self { load: Box::new(load), loaded: parking_lot::Mutex::new(None) }
    }

    /// The table, loading it if needed. Failures are not remembered: a later
    /// use retries (credentials or network may have been fixed meanwhile).
    pub fn resolve(&self) -> Result<Arc<dyn TableProvider>> {
        let mut loaded = self.loaded.lock();
        if let Some(t) = loaded.as_ref() {
            return Ok(t.clone());
        }
        let t = (self.load)()?;
        *loaded = Some(t.clone());
        Ok(t)
    }

    pub fn is_loaded(&self) -> bool {
        self.loaded.lock().is_some()
    }
}

#[derive(Clone)]
enum Slot {
    Entry(TableEntry),
    Deferred(Arc<DeferredTable>),
}

#[derive(Default)]
pub struct SessionState {
    tables: RwLock<HashMap<String, Slot>>,
}

#[derive(Clone, Default)]
pub struct SessionContext {
    state: Arc<SessionState>,
}

impl SessionContext {
    pub fn new() -> Self {
        Self::default()
    }

    /// A new context starting with this one's tables (providers are shared,
    /// so cached metadata and statistics are reused); later registrations on
    /// either side are independent.
    pub fn fork(&self) -> Self {
        let tables = self.state.tables.read().clone();
        Self { state: Arc::new(SessionState { tables: RwLock::new(tables) }) }
    }

    fn insert(&self, name: &str, slot: Slot) {
        self.state.tables.write().insert(name.to_ascii_lowercase(), slot);
    }

    pub fn register_table(&self, name: &str, provider: Arc<dyn TableProvider>) {
        self.insert(name, Slot::Entry(TableEntry::Table(provider)));
    }

    pub fn register_view(&self, name: &str, plan: Arc<LogicalPlan>) {
        self.insert(name, Slot::Entry(TableEntry::View(plan)));
    }

    /// Register a table built by `load`: now, or on first use when `lazy`.
    pub fn register_loader(
        &self,
        name: &str,
        lazy: bool,
        load: impl Fn() -> Result<Arc<dyn TableProvider>> + Send + Sync + 'static,
    ) -> Result<()> {
        if lazy {
            self.insert(name, Slot::Deferred(Arc::new(DeferredTable::new(load))));
        } else {
            self.register_table(name, load()?);
        }
        Ok(())
    }

    pub fn deregister(&self, name: &str) -> bool {
        self.state.tables.write().remove(&name.to_ascii_lowercase()).is_some()
    }

    pub fn register_parquet(&self, name: &str, path: &str) -> Result<()> {
        self.register_parquet_with(name, path, &StorageOptions::default(), false)
    }

    pub fn register_parquet_with(&self, name: &str, path: &str, storage: &StorageOptions, lazy: bool) -> Result<()> {
        let (path, storage) = (path.to_string(), storage.clone());
        self.register_loader(name, lazy, move || Ok(Arc::new(ParquetTable::try_new_with(&path, &storage)?)))
    }

    pub fn register_csv(&self, name: &str, path: &str, options: CsvOptions) -> Result<()> {
        self.register_csv_with(name, path, options, &StorageOptions::default(), false)
    }

    pub fn register_csv_with(&self, name: &str, path: &str, options: CsvOptions, storage: &StorageOptions, lazy: bool) -> Result<()> {
        let (path, storage) = (path.to_string(), storage.clone());
        self.register_loader(name, lazy, move || Ok(Arc::new(CsvTable::try_new_with(&path, options.clone(), &storage)?)))
    }

    pub fn register_batches(&self, name: &str, schema: SchemaRef, batches: Vec<RecordBatch>) {
        self.register_table(name, Arc::new(MemTable::new(schema, batches)));
    }

    pub fn table_names(&self) -> Vec<String> {
        let mut v: Vec<String> = self.state.tables.read().keys().cloned().collect();
        v.sort();
        v
    }

    /// A registered table or view (loading a deferred table).
    pub fn lookup(&self, name: &str) -> Result<Option<TableEntry>> {
        let slot = self.state.tables.read().get(&name.to_ascii_lowercase()).cloned();
        Ok(match slot {
            None => None,
            Some(Slot::Entry(e)) => Some(e),
            Some(Slot::Deferred(d)) => Some(TableEntry::Table(d.resolve()?)),
        })
    }

    /// Whether a registered table is loaded (`Some(false)`: deferred, not
    /// used yet); `None` if there is no such table.
    pub fn is_loaded(&self, name: &str) -> Option<bool> {
        self.state.tables.read().get(&name.to_ascii_lowercase()).map(|s| match s {
            Slot::Entry(_) => true,
            Slot::Deferred(d) => d.is_loaded(),
        })
    }

    pub fn scan_provider(&self, name: &str, provider: Arc<dyn TableProvider>) -> Result<LazyFrame> {
        Ok(LazyFrame::new(Arc::new(LogicalPlan::scan(name, None, provider, None, vec![], None)?), self.clone()))
    }

    pub fn read_parquet(&self, path: &str) -> Result<LazyFrame> {
        self.read_parquet_with(path, &StorageOptions::default())
    }

    pub fn read_parquet_with(&self, path: &str, storage: &StorageOptions) -> Result<LazyFrame> {
        self.scan_provider(path, Arc::new(ParquetTable::try_new_with(path, storage)?))
    }

    pub fn read_csv(&self, path: &str, options: CsvOptions) -> Result<LazyFrame> {
        self.read_csv_with(path, options, &StorageOptions::default())
    }

    pub fn read_csv_with(&self, path: &str, options: CsvOptions, storage: &StorageOptions) -> Result<LazyFrame> {
        self.scan_provider(path, Arc::new(CsvTable::try_new_with(path, options, storage)?))
    }

    pub fn from_batches(&self, schema: SchemaRef, batches: Vec<RecordBatch>) -> Result<LazyFrame> {
        self.scan_provider("memory", Arc::new(MemTable::new(schema, batches)))
    }

    pub fn table(&self, name: &str) -> Result<LazyFrame> {
        match self.lookup(name)? {
            Some(TableEntry::Table(t)) => Ok(LazyFrame::new(
                Arc::new(LogicalPlan::scan(name, Some(name.to_string()), t, None, vec![], None)?),
                self.clone(),
            )),
            Some(TableEntry::View(p)) => {
                Ok(LazyFrame::new(Arc::new(LogicalPlan::subquery_alias(p, name)), self.clone()))
            }
            None => Err(WhError::Plan(format!("table '{name}' not found"))),
        }
    }

    pub fn sql(&self, query: &str) -> Result<LazyFrame> {
        let plan = crate::sql::plan_sql(self, query)?;
        Ok(LazyFrame::new(Arc::new(plan), self.clone()))
    }
}

/// Rewrite expressions that mix aggregates and group keys into
/// `Aggregate(group_by, aggs)` + expressions over its output.
pub struct AggregateRewrite {
    pub plan: LogicalPlan,
    pub exprs: Vec<Expr>,
}

pub fn plan_aggregate(input: Arc<LogicalPlan>, group_by: Vec<Expr>, exprs: Vec<Expr>) -> Result<AggregateRewrite> {
    let in_schema = input.schema().clone();
    // name non-column group expressions
    let group_by: Vec<Expr> = group_by
        .into_iter()
        .map(|g| match g {
            Expr::Column(_) | Expr::Alias(..) => g,
            other => {
                let n = other.output_name();
                other.alias(n)
            }
        })
        .collect();
    let mut aggs: Vec<Expr> = vec![];
    let mut agg_names: Vec<String> = vec![];
    // collect aggregate calls
    for e in &exprs {
        e.visit(&mut |x| {
            if let Expr::Agg { .. } = x {
                let name = x.to_string();
                if !agg_names.contains(&name) {
                    agg_names.push(name.clone());
                    aggs.push(x.clone().alias(name));
                }
                return false;
            }
            true
        });
    }
    let plan = LogicalPlan::aggregate(input, group_by.clone(), aggs)?;
    let out_schema = plan.schema().clone();
    let group_cols: Vec<(Expr, Expr)> = group_by
        .iter()
        .enumerate()
        .map(|(i, g)| (g.clone().unalias(), Expr::Column(out_schema.column(i))))
        .collect();
    let rewritten = exprs
        .into_iter()
        .map(|e| {
            let name = e.output_name();
            let had_alias = matches!(e, Expr::Alias(..));
            let r = e.unalias().transform_down(&mut |x| {
                if let Some((_, c)) = group_cols.iter().find(|(g, _)| *g == x) {
                    return Ok((c.clone(), false));
                }
                if let Expr::Agg { .. } = &x {
                    return Ok((Expr::Column(Column::from_name(x.to_string())), false));
                }
                Ok((x, true))
            })?;
            // verify every column now refers to the aggregate output
            for c in r.column_refs() {
                if !out_schema.has_column(&c) {
                    let exists_below = in_schema.has_column(&c);
                    return Err(WhError::Plan(if exists_below {
                        format!("column '{c}' must appear in GROUP BY or be used in an aggregate function")
                    } else {
                        format!("column '{c}' not found")
                    }));
                }
            }
            let keep_name = had_alias || !matches!(r, Expr::Column(_)) || r.output_name() != name;
            Ok(if keep_name { r.alias(name) } else { r })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(AggregateRewrite { plan, exprs: rewritten })
}

#[derive(Clone)]
pub struct LazyFrame {
    pub plan: Arc<LogicalPlan>,
    ctx: SessionContext,
}

fn qualify(e: Expr, alias: &str) -> Result<Expr> {
    e.transform_up(&mut |x| match x {
        Expr::Column(c) if c.relation.is_none() => Ok(Expr::Column(Column::new(Some(alias.to_string()), c.name))),
        o => Ok(o),
    })
}

impl LazyFrame {
    pub fn new(plan: Arc<LogicalPlan>, ctx: SessionContext) -> Self {
        Self { plan, ctx }
    }

    pub fn context(&self) -> &SessionContext {
        &self.ctx
    }

    fn wrap(&self, plan: LogicalPlan) -> LazyFrame {
        LazyFrame::new(Arc::new(plan), self.ctx.clone())
    }

    pub fn schema(&self) -> &PlanSchemaRef {
        self.plan.schema()
    }

    pub fn filter(&self, predicate: Expr) -> Result<LazyFrame> {
        if predicate.contains_agg() {
            return Err(WhError::Plan("aggregates are not allowed in filter(); use group_by().agg()".into()));
        }
        if predicate.contains_window() {
            // evaluate the windows, filter on them, then drop the helper columns
            let (plan, mut p) = crate::window::plan_windows(self.plan.clone(), vec![predicate])?;
            let filtered = LogicalPlan::filter(Arc::new(plan), p.remove(0).unalias())?;
            let keep = self.schema().fields().iter().map(|f| Expr::Column(f.column())).collect();
            return Ok(self.wrap(LogicalPlan::project(Arc::new(filtered), keep)?));
        }
        Ok(self.wrap(LogicalPlan::filter(self.plan.clone(), predicate)?))
    }

    pub fn select(&self, exprs: Vec<Expr>) -> Result<LazyFrame> {
        if exprs.iter().any(|e| e.contains_window()) {
            let (plan, exprs) = crate::window::plan_windows(self.plan.clone(), exprs)?;
            return LazyFrame::new(Arc::new(plan), self.ctx.clone()).select(exprs);
        }
        if exprs.iter().any(|e| e.contains_agg()) {
            let r = plan_aggregate(self.plan.clone(), vec![], exprs)?;
            return Ok(self.wrap(LogicalPlan::project(Arc::new(r.plan), r.exprs)?));
        }
        Ok(self.wrap(LogicalPlan::project(self.plan.clone(), exprs)?))
    }

    pub fn with_columns(&self, exprs: Vec<Expr>) -> Result<LazyFrame> {
        let schema = self.plan.schema();
        let mut out: Vec<Expr> = vec![];
        let mut used = vec![false; exprs.len()];
        for f in schema.fields() {
            match exprs.iter().position(|e| e.output_name() == *f.name()) {
                Some(i) => {
                    used[i] = true;
                    out.push(exprs[i].clone().alias(f.name()));
                }
                None => out.push(Expr::Column(f.column())),
            }
        }
        for (i, e) in exprs.into_iter().enumerate() {
            if !used[i] {
                out.push(e);
            }
        }
        self.select(out)
    }

    pub fn aggregate(&self, group_by: Vec<Expr>, aggs: Vec<Expr>) -> Result<LazyFrame> {
        let mut exprs: Vec<Expr> = group_by
            .iter()
            .map(|g| match g {
                Expr::Alias(_, n) => Expr::Column(Column::from_name(n.clone())),
                e => e.clone(),
            })
            .collect();
        exprs.extend(aggs);
        let r = plan_aggregate(self.plan.clone(), group_by, exprs)?;
        Ok(self.wrap(LogicalPlan::project(Arc::new(r.plan), r.exprs)?))
    }

    pub fn join(
        &self,
        other: &LazyFrame,
        left_on: Vec<Expr>,
        right_on: Vec<Expr>,
        how: JoinType,
        suffix: &str,
    ) -> Result<LazyFrame> {
        if left_on.len() != right_on.len() {
            return Err(WhError::Plan("left_on and right_on must have the same length".into()));
        }
        let l = Arc::new(LogicalPlan::subquery_alias(self.plan.clone(), "__l"));
        let r = Arc::new(LogicalPlan::subquery_alias(other.plan.clone(), "__r"));
        let on = left_on
            .into_iter()
            .zip(right_on)
            .map(|(a, b)| Ok((qualify(a, "__l")?, qualify(b, "__r")?)))
            .collect::<Result<Vec<_>>>()?;
        let right_keys: Vec<String> = on
            .iter()
            .filter_map(|(_, r)| match r {
                Expr::Column(c) => Some(c.name.clone()),
                _ => None,
            })
            .collect();
        let joined = Arc::new(LogicalPlan::join(l.clone(), r.clone(), on, None, how)?);
        let mut exprs = vec![];
        let left_names: Vec<String> = self.schema().fields().iter().map(|f| f.name().to_string()).collect();
        for n in &left_names {
            exprs.push(Expr::Column(Column::new(Some("__l".into()), n.clone())).alias(n.clone()));
        }
        if !matches!(how, JoinType::Semi | JoinType::Anti) {
            let drop_keys = matches!(how, JoinType::Inner | JoinType::Left);
            for f in other.schema().fields() {
                let n = f.name().to_string();
                if drop_keys && right_keys.contains(&n) {
                    continue;
                }
                let out = if left_names.contains(&n) { format!("{n}{suffix}") } else { n.clone() };
                exprs.push(Expr::Column(Column::new(Some("__r".into()), n)).alias(out));
            }
        }
        Ok(self.wrap(LogicalPlan::project(joined, exprs)?))
    }

    pub fn cross_join(&self, other: &LazyFrame, suffix: &str) -> Result<LazyFrame> {
        self.join(other, vec![], vec![], JoinType::Inner, suffix)
    }

    pub fn sort(&self, by: Vec<SortExpr>) -> Result<LazyFrame> {
        Ok(self.wrap(LogicalPlan::sort(self.plan.clone(), by, None)?))
    }

    pub fn limit(&self, n: usize) -> LazyFrame {
        self.wrap(LogicalPlan::limit(self.plan.clone(), 0, Some(n)))
    }

    pub fn slice(&self, offset: usize, len: Option<usize>) -> LazyFrame {
        self.wrap(LogicalPlan::limit(self.plan.clone(), offset, len))
    }

    pub fn distinct(&self) -> Result<LazyFrame> {
        let cols: Vec<Expr> = self.schema().fields().iter().map(|f| Expr::Column(f.column())).collect();
        Ok(self.wrap(LogicalPlan::aggregate(self.plan.clone(), cols, vec![])?))
    }

    pub fn union(&self, others: &[LazyFrame]) -> Result<LazyFrame> {
        let mut inputs = vec![self.plan.clone()];
        inputs.extend(others.iter().map(|o| o.plan.clone()));
        Ok(self.wrap(LogicalPlan::union(inputs)?))
    }

    pub fn drop(&self, names: &[String]) -> Result<LazyFrame> {
        let exprs: Vec<Expr> = self
            .schema()
            .fields()
            .iter()
            .filter(|f| !names.iter().any(|n| n == f.name()))
            .map(|f| Expr::Column(f.column()))
            .collect();
        self.select(exprs)
    }

    pub fn rename(&self, mapping: &[(String, String)]) -> Result<LazyFrame> {
        let exprs: Vec<Expr> = self
            .schema()
            .fields()
            .iter()
            .map(|f| match mapping.iter().find(|(from, _)| from == f.name()) {
                Some((_, to)) => Expr::Column(f.column()).alias(to.clone()),
                None => Expr::Column(f.column()),
            })
            .collect();
        self.select(exprs)
    }

    pub fn alias(&self, name: &str) -> LazyFrame {
        self.wrap(LogicalPlan::subquery_alias(self.plan.clone(), name))
    }

    pub fn optimized_plan(&self) -> Result<LogicalPlan> {
        optimize(&self.plan)
    }

    pub fn physical_plan(&self) -> Result<PhysicalPlan> {
        create_physical_plan(&self.optimized_plan()?)
    }

    pub fn explain(&self, optimized: bool) -> Result<String> {
        if !optimized {
            return Ok(self.plan.display_indent());
        }
        let opt = self.optimized_plan()?;
        let phys = create_physical_plan(&opt)?;
        Ok(format!(
            "== Optimized logical plan ==\n{}\n== Physical plan ==\n{}",
            opt.display_indent(),
            phys.display_indent()
        ))
    }

    /// The physical plan as a tree (for display).
    pub fn plan_tree(&self) -> Result<PlanNode> {
        Ok(self.physical_plan()?.tree())
    }

    pub fn collect(&self) -> Result<(SchemaRef, Vec<RecordBatch>)> {
        execute_logical(&self.plan)
    }

    /// The result batch by batch, in order, while the query runs (nothing is
    /// collected); returns its schema and run profile.
    pub fn stream(
        &self,
        start: &mut dyn FnMut(&SchemaRef) -> Result<()>,
        emit: &mut (dyn FnMut(RecordBatch) -> Result<()> + Send),
    ) -> Result<(SchemaRef, QueryStats)> {
        stream_logical(&self.plan, start, emit)
    }

    /// Write the result to Parquet (a local path or an object store URL) as it is
    /// produced; returns the number of rows written.
    pub fn sink_parquet(&self, path: &str, compression: &str, row_group_size: Option<usize>, storage: &crate::io::StorageOptions) -> Result<usize> {
        use crate::io::parquet::ParquetSink;
        let sink = parking_lot::Mutex::new(None::<ParquetSink>);
        let rows = std::sync::atomic::AtomicUsize::new(0);
        self.stream(
            &mut |schema| {
                *sink.lock() = Some(ParquetSink::create(path, schema.clone(), compression, row_group_size, storage)?);
                Ok(())
            },
            &mut |b| {
                rows.fetch_add(b.num_rows(), std::sync::atomic::Ordering::Relaxed);
                sink.lock().as_mut().expect("writer").write(&b)
            },
        )?;
        sink.into_inner().expect("writer").finish()?;
        Ok(rows.into_inner())
    }

    /// Write the result to CSV as it is produced; returns the number of rows written.
    pub fn sink_csv(&self, path: &str, has_header: bool, delimiter: u8, storage: &crate::io::StorageOptions) -> Result<usize> {
        use crate::io::csv::CsvSink;
        let sink = parking_lot::Mutex::new(None::<CsvSink>);
        let rows = std::sync::atomic::AtomicUsize::new(0);
        self.stream(
            &mut |_| {
                *sink.lock() = Some(CsvSink::create(path, has_header, delimiter, storage)?);
                Ok(())
            },
            &mut |b| {
                rows.fetch_add(b.num_rows(), std::sync::atomic::Ordering::Relaxed);
                sink.lock().as_mut().expect("writer").write(&b)
            },
        )?;
        sink.into_inner().expect("writer").finish()?;
        Ok(rows.into_inner())
    }

    /// Collect, also returning the per-pipeline profile of the run.
    pub fn collect_profiled(&self) -> Result<(SchemaRef, Vec<RecordBatch>, QueryStats)> {
        with_query(|q| {
            let (schema, batches) = execute_logical(&self.plan)?;
            Ok((schema, batches, q.stats()))
        })
    }
}

/// Optimize, plan and run a logical plan as a (cancellable, observable) query.
pub fn execute_logical(plan: &LogicalPlan) -> Result<(SchemaRef, Vec<RecordBatch>)> {
    with_query(|_| execute_logical_inner(plan))
}

fn execute_logical_inner(plan: &LogicalPlan) -> Result<(SchemaRef, Vec<RecordBatch>)> {
    let opt = optimize(plan)?;
    let phys = create_physical_plan(&opt)?;
    let batches = execute(&phys)?;
    let schema = final_schema(opt.schema(), &phys.schema());
    let batches = batches.into_iter().map(|b| conform(b, &schema)).filter_map(Result::transpose).collect::<Result<Vec<_>>>()?;
    Ok((schema, batches))
}

/// A result batch as the query's final schema says (None: drop it, empty).
fn conform(b: RecordBatch, schema: &SchemaRef) -> Result<Option<RecordBatch>> {
    if b.num_rows() == 0 && !schema.fields().is_empty() {
        return Ok(None);
    }
    // results should not pin the (large) buffers they were sliced from
    let b = crate::exec::ops::compact_batch_views(b)?;
    if b.schema() == *schema {
        return Ok(Some(b));
    }
    let cols = b
        .columns()
        .iter()
        .zip(schema.fields())
        .map(|(c, f)| if c.data_type() == f.data_type() { Ok(c.clone()) } else { arrow::compute::cast(c, f.data_type()) })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(RecordBatch::try_new_with_options(schema.clone(), cols, &RecordBatchOptions::new().with_row_count(Some(b.num_rows())))?))
}

/// Run a plan as a (cancellable, observable) query, streaming its result:
/// `start` gets the result's schema first, then `emit` every batch in order.
pub fn stream_logical(
    plan: &LogicalPlan,
    start: &mut dyn FnMut(&SchemaRef) -> Result<()>,
    emit: &mut (dyn FnMut(RecordBatch) -> Result<()> + Send),
) -> Result<(SchemaRef, QueryStats)> {
    with_query(|q| {
        let opt = optimize(plan)?;
        let phys = create_physical_plan(&opt)?;
        let schema = final_schema(opt.schema(), &phys.schema());
        start(&schema)?;
        let mut out = |b: RecordBatch| -> Result<()> {
            match conform(b, &schema)? {
                Some(b) => emit(b),
                None => Ok(()),
            }
        };
        execute_stream(&phys, &mut out)?;
        Ok((schema, q.stats()))
    })
}

/// A common table expression that is referenced more than once: computed a
/// single time (on first scan) and shared by every reference, so all of them
/// observe exactly the same rows (and the work is not repeated).
#[derive(Debug)]
pub struct MaterializedCte {
    name: String,
    plan: Arc<LogicalPlan>,
    cache: parking_lot::Mutex<Option<Arc<MemTable>>>,
}

impl MaterializedCte {
    pub fn new(name: &str, plan: Arc<LogicalPlan>) -> Self {
        Self { name: name.to_string(), plan, cache: parking_lot::Mutex::new(None) }
    }

    fn table(&self) -> Result<Arc<MemTable>> {
        let mut guard = self.cache.lock();
        if let Some(t) = guard.as_ref() {
            return Ok(t.clone());
        }
        let (schema, batches) = execute_logical(&self.plan)?;
        let schema = Arc::new(arrow::datatypes::Schema::new(
            schema
                .fields()
                .iter()
                .zip(self.plan.schema().fields())
                .map(|(f, l)| f.as_ref().clone().with_name(l.name()))
                .collect::<Vec<_>>(),
        ));
        let batches = batches
            .into_iter()
            .map(|b| RecordBatch::try_new_with_options(schema.clone(), b.columns().to_vec(), &RecordBatchOptions::new().with_row_count(Some(b.num_rows()))))
            .collect::<Result<Vec<_>, _>>()?;
        let t = Arc::new(MemTable::new(schema, batches));
        *guard = Some(t.clone());
        Ok(t)
    }
}

impl TableProvider for MaterializedCte {
    fn schema(&self) -> SchemaRef {
        let s = self.plan.schema().arrow_schema();
        Arc::new(arrow::datatypes::Schema::new(
            s.fields().iter().map(|f| f.as_ref().clone().with_nullable(true)).collect::<Vec<_>>(),
        ))
    }
    fn num_rows(&self) -> Option<usize> {
        Some(crate::physical::planner::estimate_rows(&self.plan) as usize)
    }
    fn kind(&self) -> &'static str {
        "materialized cte"
    }
    fn create_source(
        &self,
        projection: Option<&[usize]>,
        filters: &[Expr],
        fetch: Option<usize>,
    ) -> Result<Arc<dyn crate::exec::pipeline::Source>> {
        let _ = &self.name;
        self.table()?.create_source(projection, filters, fetch)
    }
}

fn final_schema(logical: &PlanSchema, physical: &SchemaRef) -> SchemaRef {
    let fields: Vec<_> = logical
        .fields()
        .iter()
        .zip(physical.fields())
        .map(|(l, p)| arrow::datatypes::Field::new(l.name(), p.data_type().clone(), true))
        .collect();
    Arc::new(arrow::datatypes::Schema::new(fields))
}
