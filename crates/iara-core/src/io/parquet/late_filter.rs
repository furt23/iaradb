//! Filtering while decoding: the columns a scan's filters read are decoded
//! first, and the other columns only for the rows that pass. A selective
//! filter over a wide table (`WHERE CounterID = 62` with 105 columns kept)
//! then decodes a fraction of the data. A top k's running bound
//! ([`TopKBound`]) is one more such filter, tested first: once it is tight,
//! a `WHERE URL LIKE '%google%' ORDER BY EventTime LIMIT 10` decodes `URL`
//! for the few rows early enough to make the top k. The same goes for a hash
//! join's build keys ([`JoinKeyFilter`]): the scan of the probe table drops
//! the rows whose key is not in the build table before decoding the rest.
//!
//! The filter above the scan still runs (this only drops rows early).
//! Whether it pays depends on more than the share of rows kept: the filter
//! columns are decoded twice, and scattered survivors turn into a selection
//! that skips little. So the scan measures: the first row groups alternate
//! between filtering early and not, then each row group takes the mode with
//! the lower recent time per byte it reads (decode plus the operators
//! above; per byte, as row groups of long and short strings differ), trying
//! the other one now and then in case the data (or the bound) changes.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use arrow::array::{AsArray, BooleanArray};
use arrow::datatypes::SchemaRef;
use arrow::error::ArrowError;
use arrow::record_batch::RecordBatch;
use parking_lot::Mutex;
use parquet::arrow::ProjectionMask;
use parquet::arrow::arrow_reader::{ArrowPredicate, ArrowPredicateFn, RowFilter};
use parquet::schema::types::SchemaDescriptor;

use crate::exec::join_filter::JoinKeyFilter;
use crate::exec::topk_bound::TopKBound;
use crate::expr::{Expr, conjunction, split_conjunction};
use crate::io::{ScanBound, ScanJoinKeys};
use crate::physical::expr::{PhysExpr, create_physical_expr, null_as_false};
use crate::schema::{Column, PlanSchema};

/// Row groups each mode runs before the scan compares them.
const EXPLORE: u64 = 3;
/// Row groups until the slower mode runs once more; the gap doubles each
/// time (up to [`MAX_GAP`]) and starts over when the faster mode changes.
const RECHECK: u64 = 16;
const MAX_GAP: u64 = 256;
/// Weight of a row group's time in its mode's running average.
const RECENT: f64 = 0.2;
/// The other mode takes over once it is this much cheaper (noise from
/// other work on the machine does not flip the choice).
const MARGIN: f64 = 0.85;

pub struct LateFilter {
    /// the scan's filters in stages (see [`Stage`]). A row's later columns
    /// are decoded only if it passed the earlier stages (`p_size = 15 AND
    /// p_type LIKE '%BRASS'` decodes `p_type` for the rows of size 15).
    filters: Vec<Stage>,
    /// a top k's bound on a column of the table
    bound: Option<(usize, Arc<TopKBound>)>,
    /// hash joins' build keys, on columns of the table
    joins: Vec<(usize, Arc<JoinKeyFilter>)>,
    timing: Timing,
}

/// The conjuncts of the scan's filters over one set of columns.
struct Stage {
    /// the columns (of the table, = of the files) it reads, ascending
    columns: Vec<usize>,
    /// over those columns
    predicate: Arc<PhysExpr>,
    /// the conjuncts on fixed-width columns: they run first
    fixed: bool,
    /// size of its columns in the files
    bytes: u64,
    /// rows it tested and rows it kept, so far
    seen: Arc<AtomicU64>,
    kept: Arc<AtomicU64>,
}

impl Stage {
    /// Stages run by ascending rank: what a stage costs (the bytes of its
    /// columns) over the share of rows it drops, the order that decodes the
    /// least when the stages drop rows independently. `Title LIKE
    /// '%Google%' AND URL NOT LIKE '%.google.%' AND SearchPhrase <> ''`
    /// starts with the small search phrases, then the titles (few have
    /// the word) and reads the URLs of what is left.
    fn rank(&self) -> f64 {
        if self.fixed {
            return 0.0;
        }
        let seen = self.seen.load(Ordering::Relaxed);
        // before any row: as if it kept half
        let kept = if seen == 0 { 0.5 } else { self.kept.load(Ordering::Relaxed) as f64 / seen as f64 };
        (self.bytes.max(1) as f64) / (1.0 - kept).max(0.01)
    }
}

/// Which mode the next row groups take (0 = decode everything, 1 = filter
/// early), from the running average of each mode's time per byte read.
#[derive(Default)]
struct Timing {
    decisions: AtomicU64,
    state: Mutex<TimingState>,
}

#[derive(Default)]
struct TimingState {
    started: [u64; 2],
    cost: [Option<f64>; 2],
    /// the faster mode, and when (in decisions) the slower one runs next
    best: Option<usize>,
    next_check: u64,
    gap: u64,
}

impl Timing {
    fn choose(&self) -> usize {
        let d = self.decisions.fetch_add(1, Ordering::Relaxed);
        let mut s = self.state.lock();
        let mode = match s.cost {
            _ if d < 2 * EXPLORE => (d % 2) as usize,
            [Some(off), Some(on)] => {
                let best = match s.best {
                    Some(b) if s.cost[1 - b].is_some_and(|c| c >= MARGIN * s.cost[b].unwrap_or(f64::MAX)) => b,
                    _ => (on < off) as usize,
                };
                if s.best != Some(best) {
                    s.best = Some(best);
                    s.gap = RECHECK;
                    s.next_check = d + RECHECK;
                }
                if d >= s.next_check {
                    s.next_check = d + s.gap;
                    s.gap = (s.gap * 2).min(MAX_GAP);
                    1 - best
                } else {
                    best
                }
            }
            // a mode with no finished row group yet: the one started less
            _ => (s.started[1] < s.started[0]) as usize,
        };
        s.started[mode] += 1;
        mode
    }

    fn record(&self, mode: usize, bytes: u64, took: Duration) {
        if bytes == 0 {
            return;
        }
        let ns = took.as_nanos() as f64 / bytes as f64;
        let mut s = self.state.lock();
        // the slower mode runs only now and then: its last row group says
        // more than its average, which is from before the data (or a top
        // k's bound) changed
        let rechecked = s.best == Some(1 - mode);
        let avg = &mut s.cost[mode];
        *avg = Some(match *avg {
            Some(a) if !rechecked => a * (1.0 - RECENT) + ns * RECENT,
            _ => ns,
        });
    }
}

/// The columns an expression over the table reads, ascending (None: one is
/// not in the table).
fn table_columns(table_schema: &SchemaRef, e: &Expr) -> Option<Vec<usize>> {
    let mut columns = vec![];
    for c in e.column_refs() {
        let i = table_schema.index_of(&c.name).ok()?;
        if !columns.contains(&i) {
            columns.push(i);
        }
    }
    columns.sort_unstable();
    Some(columns)
}

impl LateFilter {
    /// For a scan of `projection` with `filters`, a top k's `bound` and hash
    /// joins' `joins` keys: None when the filters cannot be compiled, or
    /// when the tests read every projected column and there is little to
    /// skip: one test alone, or filters only (their columns are decoded
    /// twice for the rows they keep, often most). A bound or join keys next
    /// to another test drop most rows before its columns are decoded. The
    /// join keys it uses are marked as attached. `bytes` is the size of a table column
    /// in the files (any unit).
    pub fn new(
        table_schema: &SchemaRef,
        projection: &[usize],
        filters: &[Expr],
        bound: Option<&ScanBound>,
        joins: &[ScanJoinKeys],
        bytes: &dyn Fn(usize) -> u64,
    ) -> Option<Self> {
        let compile = |predicate: Expr, fixed: bool| -> Option<Stage> {
            // scan filters name the table's columns; drop their qualifiers
            let predicate = predicate
                .transform_up(&mut |e| match e {
                    Expr::Column(c) => Ok(Expr::Column(Column::from_name(c.name))),
                    other => Ok(other),
                })
                .ok()?;
            let columns = table_columns(table_schema, &predicate)?;
            let schema = PlanSchema::from_arrow(None, &table_schema.project(&columns).ok()?);
            let predicate = Arc::new(create_physical_expr(&predicate, &schema).ok()?);
            let bytes = columns.iter().map(|&c| bytes(c)).sum();
            Some(Stage { columns, predicate, fixed, bytes, seen: Default::default(), kept: Default::default() })
        };
        // the conjuncts on fixed-width columns together (a column is decoded
        // once per stage), then those on other columns by column set; one
        // that does not compile is left to the filter above the scan
        let conjuncts = conjunction(filters.iter().cloned()).map(|p| split_conjunction(&p)).unwrap_or_default();
        let fixed = |e: &Expr| {
            table_columns(table_schema, e).is_some_and(|cols| cols.iter().all(|&c| table_schema.field(c).data_type().primitive_width().is_some()))
        };
        let mut stages: Vec<(Option<Vec<usize>>, Vec<Expr>)> = vec![(None, vec![])];
        for c in conjuncts {
            if fixed(&c) {
                stages[0].1.push(c);
                continue;
            }
            let cols = table_columns(table_schema, &c);
            match stages.iter_mut().skip(1).find(|(k, _)| *k == cols) {
                Some((_, es)) => es.push(c),
                None => stages.push((cols, vec![c])),
            }
        }
        let filters: Vec<Stage> = stages
            .into_iter()
            .enumerate()
            .filter_map(|(i, (_, es))| Some((i, conjunction(es.into_iter())?)))
            .filter_map(|(i, p)| compile(p, i == 0))
            .collect();
        let bound = bound.map(|b| (b.column, b.bound.clone()));
        let joins: Vec<_> = joins.iter().map(|j| (j.column, j.keys.clone())).collect();
        let read = |p: &usize| {
            filters.iter().any(|s| s.columns.contains(p))
                || bound.as_ref().is_some_and(|(c, _)| c == p)
                || joins.iter().any(|(c, _)| c == p)
        };
        let tests = filters.len() + bound.is_some() as usize + joins.len();
        let skips = tests > 1 && (bound.is_some() || !joins.is_empty());
        if tests == 0 || !skips && projection.iter().all(read) {
            return None;
        }
        joins.iter().for_each(|(_, keys)| keys.attach());
        Some(Self { filters, bound, joins, timing: Timing::default() })
    }

    /// The columns hash joins' keys are tested on.
    pub fn join_columns(&self) -> Vec<&str> {
        self.joins.iter().map(|(_, keys)| keys.column()).collect()
    }

    /// Whether there is nothing to test yet: no filters and no bound, and the
    /// build side of each join is not done (its keys are tested once it is).
    pub fn idle(&self) -> bool {
        self.filters.is_empty() && self.bound.is_none() && !self.joins.iter().any(|(_, keys)| keys.is_set())
    }

    /// Whether to filter while decoding the next row group: a [`Mode`] to
    /// report the row group's time to.
    pub fn choose(&self) -> Mode {
        Mode(self.timing.choose())
    }

    /// Record how long a row group took in `mode`: `bytes` is what it reads
    /// (the uncompressed size of its column chunks).
    pub fn finished(&self, mode: Mode, bytes: u64, took: Duration) {
        self.timing.record(mode.0, bytes, took);
    }

    pub fn row_filter(&self, schema: &SchemaDescriptor) -> RowFilter {
        let mut predicates: Vec<Box<dyn ArrowPredicate>> = vec![];
        // the bound first: one cheap comparison that, once tight, drops most rows
        if let Some((column, bound)) = &self.bound {
            let bound = bound.clone();
            let mask = ProjectionMask::roots(schema, [*column]);
            predicates.push(Box::new(ArrowPredicateFn::new(mask, move |batch: RecordBatch| -> Result<BooleanArray, ArrowError> {
                Ok(bound.mask(batch.column(0)).unwrap_or_else(|| keep_all(&batch)))
            })));
        }
        // then the joins' keys: a hash probe per row, and most rows go
        for (column, keys) in &self.joins {
            let keys = keys.clone();
            let mask = ProjectionMask::roots(schema, [*column]);
            predicates.push(Box::new(ArrowPredicateFn::new(mask, move |batch: RecordBatch| -> Result<BooleanArray, ArrowError> {
                Ok(keys.mask(batch.column(0)).unwrap_or_else(|| keep_all(&batch)))
            })));
        }
        let mut stages: Vec<&Stage> = self.filters.iter().collect();
        stages.sort_by(|a, b| a.rank().total_cmp(&b.rank()));
        for stage in stages {
            let mask = ProjectionMask::roots(schema, stage.columns.iter().copied());
            let (predicate, seen, kept) = (stage.predicate.clone(), stage.seen.clone(), stage.kept.clone());
            predicates.push(Box::new(ArrowPredicateFn::new(mask, move |batch: RecordBatch| -> Result<BooleanArray, ArrowError> {
                // an error here is left to the filter above the scan
                let keep = match predicate.evaluate_array(&batch) {
                    Ok(a) if a.data_type() == &arrow::datatypes::DataType::Boolean => null_as_false(a.as_boolean()),
                    _ => keep_all(&batch),
                };
                seen.fetch_add(keep.len() as u64, Ordering::Relaxed);
                kept.fetch_add(keep.true_count() as u64, Ordering::Relaxed);
                Ok(keep)
            })));
        }
        RowFilter::new(predicates)
    }
}

fn keep_all(batch: &RecordBatch) -> BooleanArray {
    BooleanArray::from(vec![true; batch.num_rows()])
}

/// How a row group is decoded: filtering early or not.
#[derive(Clone, Copy, Debug)]
pub struct Mode(usize);

impl Mode {
    pub fn early(self) -> bool {
        self.0 == 1
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stages_run_by_size_and_rows_dropped() {
        use crate::expr::{col, lit};
        use crate::scalar::Scalar;
        use arrow::datatypes::{DataType, Field, Schema};
        let field = |n: &str, t: DataType| Field::new(n, t, false);
        let schema: SchemaRef = Arc::new(Schema::new(vec![
            field("title", DataType::Utf8View),
            field("id", DataType::Int64),
            field("phrase", DataType::Utf8View),
            field("other", DataType::Int64),
        ]));
        let text = |s: &str| lit(Scalar::utf8(s));
        let filters = [col("title").not_eq(text("x")), col("phrase").not_eq(text("")), col("id").gt(lit(Scalar::int64(3)))];
        let sizes = [900, 8, 100, 8];
        let late = LateFilter::new(&schema, &[0, 1, 2, 3], &filters, None, &[], &|c| sizes[c]).unwrap();
        let order = || {
            let mut stages: Vec<&Stage> = late.filters.iter().collect();
            stages.sort_by(|a, b| a.rank().total_cmp(&b.rank()));
            stages.iter().map(|s| s.columns.clone()).collect::<Vec<_>>()
        };
        // the fixed-width column, then the strings by size
        assert_eq!(order(), vec![vec![1], vec![2], vec![0]]);
        // the small string keeps every row, the large one 1 in 100: the large one pays first
        for s in &late.filters {
            s.seen.store(1000, Ordering::Relaxed);
            s.kept.store(if s.columns == [0] { 10 } else { 1000 }, Ordering::Relaxed);
        }
        assert_eq!(order(), vec![vec![1], vec![0], vec![2]]);
    }

    #[test]
    fn explores_both_modes_then_keeps_the_faster() {
        let t = Timing::default();
        let first: Vec<usize> = (0..2 * EXPLORE).map(|_| t.choose()).collect();
        assert_eq!(first.iter().filter(|&&m| m == 1).count() as u64, EXPLORE);
        // early filtering at a tenth of the cost per row
        t.record(0, 1000, Duration::from_nanos(10_000));
        t.record(1, 1000, Duration::from_nanos(1_000));
        let next: Vec<usize> = (0..40).map(|_| t.choose()).collect();
        // rechecks after 16, then 32 more row groups
        assert_eq!(next.iter().filter(|&&m| m == 0).count(), 2, "{next:?}");
        // the data changes: early filtering turns slow, and loses its place
        for _ in 0..8 {
            t.record(1, 1000, Duration::from_nanos(50_000));
        }
        let later: Vec<usize> = (0..40).map(|_| t.choose()).collect();
        assert_eq!(later.iter().filter(|&&m| m == 1).count(), 2, "{later:?}");
        // a top k's bound tightens: one row group filtered early at its new cost wins it back
        t.record(1, 1000, Duration::from_nanos(500));
        assert_eq!(t.choose(), 1);
    }
}
