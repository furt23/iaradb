//! Window functions.
//!
//! The input is materialised (a pipeline breaker). For every window
//! specification (a distinct PARTITION BY + ORDER BY) the rows are sorted in
//! parallel by (partition keys, order keys), partition and peer-group
//! boundaries are found, and every function of that specification is
//! evaluated partition by partition, partitions in parallel. Results are
//! scattered back, so rows keep their input order.

mod aggregate;
mod frame;
mod layout;
mod partitioned;
mod ranking;
mod sliding;
mod value;

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use arrow::array::{Array, ArrayRef, AsArray};
use arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use arrow::record_batch::{RecordBatch, RecordBatchOptions};

use crate::error::{Result, WhError};
use crate::exec::join::concat_parallel;
use crate::exec::join_spill::{PartitionedSpill, grace_partitions};
use crate::exec::memory::{self, Reservation};
use crate::exec::pipeline::{MORSEL_ROWS, Sink, rechunk};
use crate::expr::{AggFunc, WindowFrame, WindowFunc};
use crate::physical::expr::{PhysExpr, PhysSortExpr};
use layout::Layout;
pub use partitioned::{WindowPartitions, spilled_windows};

/// One window function, compiled.
#[derive(Clone, Debug)]
pub struct WindowFunctionExpr {
    pub func: WindowFunc,
    pub args: Vec<PhysExpr>,
    pub distinct: bool,
    pub filter: Option<PhysExpr>,
    pub ignore_nulls: bool,
    pub frame: WindowFrame,
    pub out_type: DataType,
    pub name: String,
}

impl WindowFunctionExpr {
    /// A constant integer argument (`ntile(4)`, `lag(x, 2)`); `None` if NULL.
    fn literal_arg(&self, i: usize) -> Result<Option<i64>> {
        match self.args.get(i) {
            Some(PhysExpr::Literal(s)) => Ok(s.as_i64()),
            _ => Err(WhError::NotSupported(format!("argument {} of {}() must be a constant", i + 1, self.func.name()))),
        }
    }
}

/// Window functions sharing a partitioning and an ordering.
#[derive(Clone, Debug)]
pub struct WindowSpec {
    pub partition_by: Vec<PhysExpr>,
    pub order_by: Vec<PhysSortExpr>,
    /// (output column, function)
    pub funcs: Vec<(usize, WindowFunctionExpr)>,
}

impl WindowSpec {
    pub fn describe(&self) -> String {
        let mut parts = vec![];
        if !self.partition_by.is_empty() {
            parts.push(format!(
                "partition=[{}]",
                self.partition_by.iter().map(|e| e.to_string()).collect::<Vec<_>>().join(", ")
            ));
        }
        if !self.order_by.is_empty() {
            let keys: Vec<String> = self
                .order_by
                .iter()
                .map(|k| format!("{} {}", k.expr, if k.descending { "DESC" } else { "ASC" }))
                .collect();
            parts.push(format!("order=[{}]", keys.join(", ")));
        }
        let funcs: Vec<&str> = self.funcs.iter().map(|(_, f)| f.name.as_str()).collect();
        parts.push(format!("funcs=[{}]", funcs.join(", ")));
        parts.join(" ")
    }
}

/// Rows (in sorted order) with a non-null value (when `values` is given)
/// that pass the filter (when `filter` is given).
fn valid_rows(values: Option<&ArrayRef>, filter: Option<&ArrayRef>, layout: &Layout) -> Result<Vec<bool>> {
    let nulls = values.and_then(|v| v.logical_nulls());
    let mask = filter.map(|f| f.as_boolean().clone());
    Ok((0..layout.n)
        .map(|i| {
            let r = layout.row(i);
            nulls.as_ref().is_none_or(|n| n.is_valid(r)) && mask.as_ref().is_none_or(|m| m.is_valid(r) && m.value(r))
        })
        .collect())
}

fn evaluate_function(f: &WindowFunctionExpr, batch: &RecordBatch, layout: &Layout) -> Result<ArrayRef> {
    use WindowFunc::*;
    match f.func {
        RowNumber | Rank | DenseRank | PercentRank | CumeDist | Ntile => ranking::evaluate(f, layout),
        Lag | Lead => value::offset(f, batch, layout),
        FirstValue | LastValue | NthValue | Agg(AggFunc::First | AggFunc::Last) => value::frame_value(f, batch, layout),
        Agg(_) => aggregate::evaluate(f, batch, layout),
    }
}

/// The windows of a query, evaluated over a batch holding whole partitions.
#[derive(Clone)]
pub struct WindowEval {
    pub specs: Vec<WindowSpec>,
    /// output schema: the input columns, then one column per function
    pub schema: SchemaRef,
}

/// The input of window functions: all of it in memory, or (under the memory
/// limit) partitioned to disk by the shared PARTITION BY keys.
pub struct WindowSink {
    eval: WindowEval,
    /// set when the windows share PARTITION BY keys (the input can spill)
    partition_keys: Option<Vec<PhysExpr>>,
    spill: Option<PartitionedSpill>,
    spilling: AtomicBool,
}

pub struct WindowLocal {
    batches: Vec<(usize, usize, RecordBatch)>,
    reservation: Reservation,
}

/// A window's result: batches, or disk partitions evaluated one by one.
pub enum Windowed {
    Batches(Vec<RecordBatch>),
    Partitions(WindowPartitions),
}

impl Windowed {
    pub fn into_batches(self) -> Result<Vec<RecordBatch>> {
        match self {
            Windowed::Batches(b) => Ok(b),
            Windowed::Partitions(p) => p.into_batches(),
        }
    }
}

impl WindowSink {
    pub fn new(specs: Vec<WindowSpec>, schema: SchemaRef) -> Self {
        let partition_keys = partitioned::common_partition(&specs);
        let eval = WindowEval { specs, schema };
        let spill = partition_keys.as_ref().map(|_| PartitionedSpill::new(eval.input_schema(), grace_partitions()));
        Self { eval, partition_keys, spill, spilling: AtomicBool::new(false) }
    }

    fn spill_batch(&self, b: &RecordBatch) -> Result<()> {
        let keys = self.partition_keys.as_ref().expect("partitioned").iter().map(|e| e.evaluate_array(b)).collect::<Result<Vec<_>>>()?;
        self.spill.as_ref().expect("partitioned").write(b, &keys)
    }

    fn spill_local(&self, local: &mut WindowLocal) -> Result<()> {
        for (_, _, b) in local.batches.drain(..) {
            self.spill_batch(&b)?;
        }
        local.reservation.free();
        Ok(())
    }
}

impl WindowEval {
    fn input_schema(&self) -> SchemaRef {
        let funcs: usize = self.specs.iter().map(|s| s.funcs.len()).sum();
        let n_in = self.schema.fields().len() - funcs;
        Arc::new(Schema::new(self.schema.fields()[..n_in].to_vec()))
    }

    pub fn evaluate(&self, batch: &RecordBatch) -> Result<RecordBatch> {
        let n_in = batch.num_columns();
        let n_win = self.schema.fields().len() - n_in;
        let mut window_cols: Vec<Option<ArrayRef>> = vec![None; n_win];
        for spec in &self.specs {
            if let Some(q) = crate::exec::query::current() {
                q.check()?;
            }
            let layout = Layout::new(batch, &spec.partition_by, &spec.order_by)?;
            for (pos, f) in &spec.funcs {
                let mut a = evaluate_function(f, batch, &layout)?;
                if a.data_type() != &f.out_type {
                    a = arrow::compute::cast(&a, &f.out_type)?;
                }
                window_cols[pos - n_in] = Some(a);
            }
        }
        // the input part follows the batches as they arrive
        let mut fields: Vec<Arc<Field>> = batch.schema().fields().iter().cloned().collect();
        fields.extend(self.schema.fields()[n_in..].iter().cloned());
        let mut cols = batch.columns().to_vec();
        for c in window_cols {
            cols.push(c.ok_or_else(|| WhError::Execution("window column was not computed".into()))?);
        }
        let opts = RecordBatchOptions::new().with_row_count(Some(batch.num_rows()));
        Ok(RecordBatch::try_new_with_options(Arc::new(Schema::new(fields)), cols, &opts)?)
    }
}

impl WindowEval {
    /// Input columns the windows read (keys, arguments, filters).
    fn read_columns(&self) -> Vec<usize> {
        let mut cols = vec![];
        for spec in &self.specs {
            spec.partition_by.iter().for_each(|e| e.collect_columns(&mut cols));
            spec.order_by.iter().for_each(|k| k.expr.collect_columns(&mut cols));
            for (_, f) in &spec.funcs {
                f.args.iter().for_each(|e| e.collect_columns(&mut cols));
                if let Some(e) = &f.filter {
                    e.collect_columns(&mut cols);
                }
            }
        }
        cols.sort_unstable();
        cols.dedup();
        cols
    }

    /// Evaluate over input batches (in input order): only the columns the
    /// windows read are put together, and the output takes them from there
    /// (the input batches keep only the other columns, so no column is held
    /// twice); the window columns are cut back along the input batches.
    fn evaluate_batches(&self, batches: Vec<RecordBatch>) -> Result<Vec<RecordBatch>> {
        let schema = batches[0].schema();
        let n: usize = batches.iter().map(|b| b.num_rows()).sum();
        let read = self.read_columns();
        let concat_cols = concat_parallel(
            &Arc::new(schema.project(&read)?),
            &batches.iter().map(|b| b.project(&read)).collect::<Result<Vec<_>, _>>()?,
        )?;
        // the input batches without the columns just put together
        let rows: Vec<usize> = batches.iter().map(|b| b.num_rows()).collect();
        let rest: Vec<Vec<Option<ArrayRef>>> = batches
            .into_iter()
            .map(|b| b.columns().iter().enumerate().map(|(i, c)| (!read.contains(&i)).then(|| c.clone())).collect())
            .collect();
        // unread columns stand in as (unallocated) NULL columns
        let mut fields = Vec::with_capacity(schema.fields().len());
        let mut cols = Vec::with_capacity(schema.fields().len());
        for (i, f) in schema.fields().iter().enumerate() {
            match read.iter().position(|&r| r == i) {
                Some(k) => {
                    fields.push(f.clone());
                    cols.push(concat_cols.column(k).clone());
                }
                None => {
                    fields.push(Arc::new(Field::new(f.name(), DataType::Null, true)));
                    cols.push(Arc::new(arrow::array::NullArray::new(n)) as ArrayRef);
                }
            }
        }
        let narrow = RecordBatch::try_new_with_options(Arc::new(Schema::new(fields)), cols, &RecordBatchOptions::new().with_row_count(Some(n)))?;
        let evaluated = self.evaluate(&narrow)?;
        drop(narrow);
        let n_in = schema.fields().len();
        let window_cols = &evaluated.columns()[n_in..];
        let mut out_fields: Vec<Arc<Field>> = schema.fields().iter().cloned().collect();
        out_fields.extend(self.schema.fields()[n_in..].iter().cloned());
        let out_schema = Arc::new(Schema::new(out_fields));
        let mut out = Vec::with_capacity(rest.len());
        let mut at = 0;
        for (b, rows) in rest.into_iter().zip(rows) {
            let mut cols: Vec<ArrayRef> = b
                .into_iter()
                .enumerate()
                .map(|(i, c)| c.unwrap_or_else(|| concat_cols.column(read.iter().position(|&r| r == i).expect("read column")).slice(at, rows)))
                .collect();
            cols.extend(window_cols.iter().map(|c| c.slice(at, rows)));
            out.push(RecordBatch::try_new_with_options(out_schema.clone(), cols, &RecordBatchOptions::new().with_row_count(Some(rows)))?);
            at += rows;
        }
        Ok(rechunk(out, MORSEL_ROWS))
    }
}

impl Sink for WindowSink {
    type Local = WindowLocal;
    type Output = Windowed;

    fn make_local(&self) -> Self::Local {
        WindowLocal { batches: vec![], reservation: memory::pool().reservation() }
    }

    fn push(&self, local: &mut Self::Local, morsel: usize, batch: RecordBatch) -> Result<()> {
        if batch.num_rows() == 0 {
            return Ok(());
        }
        if self.spilling.load(Ordering::Relaxed) {
            self.spill_local(local)?; // another thread hit the limit
            return self.spill_batch(&batch);
        }
        // the input, its sorted layout and the window columns
        let batch = crate::exec::batch_mem::compact(batch)?;
        let bytes = crate::exec::batch_mem::batch_bytes(&batch) * 3;
        if !local.reservation.try_grow(bytes) {
            if self.spill.is_some() {
                self.spilling.store(true, Ordering::Relaxed);
                self.spill_local(local)?;
                return self.spill_batch(&batch);
            }
            local.reservation.grow(bytes); // no shared partitioning: it has to fit
        }
        let seq = local.batches.len();
        local.batches.push((morsel, seq, batch));
        Ok(())
    }

    fn finalize(&self, mut locals: Vec<Self::Local>) -> Result<Windowed> {
        if self.spilling.load(Ordering::Relaxed) {
            for l in &mut locals {
                self.spill_local(l)?;
            }
            let files = self.spill.as_ref().expect("partitioned").finish()?;
            return Ok(Windowed::Partitions(WindowPartitions::new(self.eval.clone(), self.eval.input_schema(), files)));
        }
        // the reservations stay held until the windows are evaluated
        let mut held = Vec::with_capacity(locals.len());
        let mut all: Vec<(usize, usize, RecordBatch)> = vec![];
        for l in locals {
            all.extend(l.batches);
            held.push(l.reservation);
        }
        // input order: by morsel, then by arrival within the morsel
        all.sort_unstable_by_key(|(m, s, _)| (*m, *s));
        let batches: Vec<RecordBatch> = all.into_iter().map(|(_, _, b)| b).collect();
        if batches.is_empty() {
            return Ok(Windowed::Batches(vec![]));
        }
        Ok(Windowed::Batches(self.eval.evaluate_batches(batches)?))
    }
}
