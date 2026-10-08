//! Python bindings for the Workhouse engine.
//!
//! Data crosses the boundary through the Arrow C stream interface
//! (`__arrow_c_stream__`), so exchanging tables with pyarrow, polars, pandas
//! (via pyarrow) or DuckDB is zero-copy. The GIL is released while queries
//! are planned and executed.

use arrow::array::RecordBatchIterator;
use arrow::datatypes::SchemaRef;
use arrow::ffi_stream::{ArrowArrayStreamReader, FFI_ArrowArrayStream};
use arrow::record_batch::{RecordBatch, RecordBatchReader};
use chrono::{NaiveDate, NaiveDateTime};
use pyo3::create_exception;
use pyo3::exceptions::{PyException, PyTypeError, PyValueError};
use pyo3::prelude::*;
use pyo3::types::{PyBool, PyCapsule, PyDict, PyFloat, PyInt, PyString};

use workhouse_core::expr::{AggFunc, Expr, Operator, ScalarFunc, SortExpr, binary, col, count_star};
use workhouse_core::io::csv::{CsvOptions, write_csv_with};
use workhouse_core::io::parquet::write_parquet_with;
use workhouse_core::session::TableEntry;
use workhouse_core::types::parse_data_type;
use workhouse_core::{JoinType, LazyFrame, Scalar, SessionContext, WhError};

mod memory;
mod runtime;
mod storage;
mod stream;
mod window;

#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

create_exception!(_workhouse, WorkhouseError, PyException);
create_exception!(_workhouse, QueryCancelled, WorkhouseError);
create_exception!(_workhouse, StorageError, WorkhouseError);

fn err(e: WhError) -> PyErr {
    match e {
        WhError::Cancelled => QueryCancelled::new_err(e.to_string()),
        WhError::Storage(_) => StorageError::new_err(e.to_string()),
        e => WorkhouseError::new_err(e.to_string()),
    }
}

trait PyResultExt<T> {
    fn py(self) -> PyResult<T>;
}

impl<T> PyResultExt<T> for Result<T, WhError> {
    fn py(self) -> PyResult<T> {
        self.map_err(err)
    }
}

impl<T> PyResultExt<T> for Result<T, arrow::error::ArrowError> {
    fn py(self) -> PyResult<T> {
        self.map_err(|e| err(WhError::Arrow(e)))
    }
}

// ---------------------------------------------------------------------------
// Python values -> scalars
// ---------------------------------------------------------------------------

fn parse_decimal(s: &str) -> PyResult<Scalar> {
    let s = s.trim();
    let neg = s.starts_with('-');
    let body = s.trim_start_matches(['-', '+']);
    let (int_part, frac) = body.split_once('.').unwrap_or((body, ""));
    let digits = format!("{int_part}{frac}");
    let v: i128 = digits.parse().map_err(|_| PyValueError::new_err(format!("invalid decimal '{s}'")))?;
    let v = if neg { -v } else { v };
    let precision = digits.trim_start_matches('0').len().max(frac.len()).clamp(1, 38) as u8;
    Scalar::decimal128(v, precision, frac.len() as i8).py()
}

fn py_scalar(obj: &Bound<'_, PyAny>) -> PyResult<Scalar> {
    let py = obj.py();
    if obj.is_none() {
        return Ok(Scalar::null());
    }
    if obj.is_instance_of::<PyBool>() {
        return Ok(Scalar::boolean(obj.extract::<bool>()?));
    }
    if obj.is_instance_of::<PyInt>() {
        if let Ok(v) = obj.extract::<i64>() {
            return Ok(Scalar::int64(v));
        }
        return Ok(Scalar::uint64(obj.extract::<u64>()?));
    }
    if obj.is_instance_of::<PyFloat>() {
        return Ok(Scalar::float64(obj.extract::<f64>()?));
    }
    if obj.is_instance_of::<PyString>() {
        return Ok(Scalar::utf8(&obj.extract::<String>()?));
    }
    let datetime = py.import("datetime")?;
    if obj.is_instance(&datetime.getattr("datetime")?)? {
        if !obj.getattr("tzinfo")?.is_none() {
            let ts: f64 = obj.call_method0("timestamp")?.extract()?;
            return Ok(Scalar::timestamp_us((ts * 1e6).round() as i64, Some("UTC".into())));
        }
        let g = |n: &str| -> PyResult<u32> { obj.getattr(n)?.extract::<u32>() };
        let d = NaiveDate::from_ymd_opt(obj.getattr("year")?.extract::<i32>()?, g("month")?, g("day")?)
            .ok_or_else(|| PyValueError::new_err("invalid datetime"))?;
        let t: NaiveDateTime = d
            .and_hms_micro_opt(g("hour")?, g("minute")?, g("second")?, g("microsecond")?)
            .ok_or_else(|| PyValueError::new_err("invalid datetime"))?;
        return Ok(Scalar::timestamp_us(t.and_utc().timestamp_micros(), None));
    }
    if obj.is_instance(&datetime.getattr("date")?)? {
        let d = NaiveDate::from_ymd_opt(
            obj.getattr("year")?.extract::<i32>()?,
            obj.getattr("month")?.extract::<u32>()?,
            obj.getattr("day")?.extract::<u32>()?,
        )
        .ok_or_else(|| PyValueError::new_err("invalid date"))?;
        let days = (d - NaiveDate::from_ymd_opt(1970, 1, 1).unwrap()).num_days() as i32;
        return Ok(Scalar::date32(days));
    }
    let tname: String = obj.get_type().name()?.extract()?;
    if tname == "Decimal" {
        return parse_decimal(&obj.str()?.extract::<String>()?);
    }
    if obj.hasattr("item")? {
        // numpy scalar
        let item = obj.call_method0("item")?;
        if !item.is(obj) {
            return py_scalar(&item);
        }
    }
    Err(PyTypeError::new_err(format!("cannot convert Python value of type '{tname}' to a literal")))
}

// ---------------------------------------------------------------------------
// expressions
// ---------------------------------------------------------------------------

#[pyclass(name = "PyExpr", module = "workhouse._workhouse", frozen, skip_from_py_object)]
#[derive(Clone)]
pub struct PyExpr {
    inner: Expr,
}

fn exprs_of(v: &[PyRef<'_, PyExpr>]) -> Vec<Expr> {
    v.iter().map(|e| e.inner.clone()).collect()
}

fn wrap(e: Expr) -> PyExpr {
    PyExpr { inner: e }
}

#[pymethods]
impl PyExpr {
    #[staticmethod]
    fn col(name: &str) -> Self {
        wrap(col(name))
    }

    #[staticmethod]
    fn lit(value: &Bound<'_, PyAny>) -> PyResult<Self> {
        Ok(wrap(Expr::Literal(py_scalar(value)?)))
    }

    #[staticmethod]
    #[pyo3(signature = (qualifier=None))]
    fn wildcard(qualifier: Option<String>) -> Self {
        wrap(Expr::Wildcard { qualifier })
    }

    #[staticmethod]
    fn count_star() -> Self {
        wrap(count_star())
    }

    fn binary(&self, op: &str, other: PyRef<'_, PyExpr>) -> PyResult<Self> {
        let op = match op {
            "+" => Operator::Plus,
            "-" => Operator::Minus,
            "*" => Operator::Multiply,
            "/" => Operator::Divide,
            "%" => Operator::Modulo,
            "==" => Operator::Eq,
            "!=" => Operator::NotEq,
            "<" => Operator::Lt,
            "<=" => Operator::LtEq,
            ">" => Operator::Gt,
            ">=" => Operator::GtEq,
            "and" => Operator::And,
            "or" => Operator::Or,
            "||" => Operator::StringConcat,
            o => return Err(PyValueError::new_err(format!("unknown operator '{o}'"))),
        };
        Ok(wrap(binary(self.inner.clone(), op, other.inner.clone())))
    }

    fn not_(&self) -> Self {
        wrap(self.inner.clone().not())
    }

    fn neg(&self) -> Self {
        wrap(Expr::Negative(Box::new(self.inner.clone())))
    }

    fn is_null(&self) -> Self {
        wrap(self.inner.clone().is_null())
    }

    fn is_not_null(&self) -> Self {
        wrap(self.inner.clone().is_not_null())
    }

    fn alias(&self, name: &str) -> Self {
        wrap(self.inner.clone().alias(name))
    }

    #[pyo3(signature = (dtype, strict=true))]
    fn cast(&self, dtype: &str, strict: bool) -> PyResult<Self> {
        let to = parse_data_type(dtype).py()?;
        Ok(wrap(Expr::Cast { expr: Box::new(self.inner.clone()), to, try_cast: !strict }))
    }

    #[pyo3(signature = (name, distinct=false))]
    fn agg(&self, name: &str, distinct: bool) -> PyResult<Self> {
        let (func, distinct) = match name {
            "n_unique" | "count_distinct" => (AggFunc::Count, true),
            n => (
                AggFunc::from_name(n).ok_or_else(|| PyValueError::new_err(format!("unknown aggregate '{n}'")))?,
                distinct,
            ),
        };
        Ok(wrap(Expr::Agg { func, args: vec![self.inner.clone()], distinct, filter: None }))
    }

    /// Restrict an aggregate to the rows where `predicate` holds.
    fn agg_filter(&self, predicate: PyRef<'_, PyExpr>) -> PyResult<Self> {
        match self.inner.clone().unalias() {
            Expr::Agg { func, args, distinct, .. } => Ok(wrap(Expr::Agg {
                func,
                args,
                distinct,
                filter: Some(Box::new(predicate.inner.clone())),
            })),
            _ => Err(PyValueError::new_err("filter() on a non-aggregate expression")),
        }
    }

    #[staticmethod]
    fn func(name: &str, args: Vec<PyRef<'_, PyExpr>>) -> PyResult<Self> {
        let f = ScalarFunc::from_name(name).ok_or_else(|| PyValueError::new_err(format!("unknown function '{name}'")))?;
        Ok(wrap(Expr::Function { func: f, args: exprs_of(&args) }))
    }

    #[pyo3(signature = (values, negated=false))]
    fn is_in(&self, values: Vec<PyRef<'_, PyExpr>>, negated: bool) -> Self {
        wrap(Expr::InList { expr: Box::new(self.inner.clone()), list: exprs_of(&values), negated })
    }

    #[pyo3(signature = (pattern, negated=false, case_insensitive=false))]
    fn like(&self, pattern: &str, negated: bool, case_insensitive: bool) -> Self {
        wrap(Expr::Like {
            expr: Box::new(self.inner.clone()),
            pattern: Box::new(Expr::Literal(Scalar::utf8(pattern))),
            negated,
            case_insensitive,
        })
    }

    #[staticmethod]
    #[pyo3(signature = (whens, otherwise=None))]
    fn case(whens: Vec<(PyRef<'_, PyExpr>, PyRef<'_, PyExpr>)>, otherwise: Option<PyRef<'_, PyExpr>>) -> Self {
        wrap(Expr::Case {
            when_then: whens.iter().map(|(w, t)| (w.inner.clone(), t.inner.clone())).collect(),
            otherwise: otherwise.map(|o| Box::new(o.inner.clone())),
        })
    }

    fn output_name(&self) -> String {
        self.inner.output_name()
    }

    fn root_name(&self) -> Option<String> {
        self.inner.root_name()
    }

    fn is_column(&self) -> bool {
        matches!(self.inner, Expr::Column(_))
    }

    fn is_alias(&self) -> bool {
        matches!(self.inner, Expr::Alias(..))
    }

    fn is_literal(&self) -> bool {
        matches!(self.inner, Expr::Literal(_))
    }

    fn contains_agg(&self) -> bool {
        self.inner.contains_agg()
    }

    fn contains_window(&self) -> bool {
        self.inner.contains_window()
    }

    /// A window function (`rank`, `lag`, `row_number`, ... or an aggregate)
    /// whose partitioning comes from a later `over()`.
    #[staticmethod]
    #[pyo3(signature = (name, args, order_by=vec![], descending=vec![], frame=None))]
    fn window(
        name: &str,
        args: Vec<PyRef<'_, PyExpr>>,
        order_by: Vec<PyRef<'_, PyExpr>>,
        descending: Vec<bool>,
        frame: Option<window::FrameSpec>,
    ) -> PyResult<Self> {
        window::function(name, exprs_of(&args), exprs_of(&order_by), &descending, frame).py().map(wrap)
    }

    /// Turn the aggregates / window functions in this expression into window
    /// expressions over `partition_by` (ordered by `order_by`).
    #[pyo3(signature = (partition_by, order_by=vec![], descending=vec![], nulls_last=vec![], frame=None))]
    fn over(
        &self,
        partition_by: Vec<PyRef<'_, PyExpr>>,
        order_by: Vec<PyRef<'_, PyExpr>>,
        descending: Vec<bool>,
        nulls_last: Vec<bool>,
        frame: Option<window::FrameSpec>,
    ) -> PyResult<Self> {
        let e = self.inner.clone();
        window::over(e, exprs_of(&partition_by), exprs_of(&order_by), &descending, &nulls_last, frame).py().map(wrap)
    }

    fn __repr__(&self) -> String {
        self.inner.to_string()
    }
}

// ---------------------------------------------------------------------------
// data frames
// ---------------------------------------------------------------------------

#[pyclass(name = "PyDataFrame", module = "workhouse._workhouse", frozen)]
pub struct PyDataFrame {
    schema: SchemaRef,
    batches: Vec<RecordBatch>,
}

fn import_stream(obj: &Bound<'_, PyAny>) -> PyResult<(SchemaRef, Vec<RecordBatch>)> {
    let obj = if obj.hasattr("__arrow_c_stream__")? {
        obj.clone()
    } else {
        // pandas & co: go through pyarrow
        let pa = obj.py().import("pyarrow")?;
        if obj.hasattr("to_arrow")? {
            obj.call_method0("to_arrow")?
        } else {
            pa.getattr("Table")?.call_method1("from_pandas", (obj,))?
        }
    };
    let capsule = obj.call_method1("__arrow_c_stream__", (obj.py().None(),))?;
    let capsule = capsule.cast::<PyCapsule>()?;
    let ptr = capsule.pointer_checked(Some(c"arrow_array_stream"))?;
    // SAFETY: the capsule holds a valid ArrowArrayStream; from_raw moves it out
    let reader = unsafe { ArrowArrayStreamReader::from_raw(ptr.as_ptr() as *mut FFI_ArrowArrayStream) }.py()?;
    let schema = reader.schema();
    let batches = reader.collect::<Result<Vec<_>, _>>().py()?;
    Ok((schema, batches))
}

fn schema_list(schema: &arrow::datatypes::Schema) -> Vec<(String, String)> {
    schema.fields().iter().map(|f| (f.name().clone(), f.data_type().to_string())).collect()
}

#[pymethods]
impl PyDataFrame {
    #[staticmethod]
    fn from_arrow(obj: &Bound<'_, PyAny>) -> PyResult<Self> {
        let (schema, batches) = import_stream(obj)?;
        Ok(Self { schema, batches })
    }

    #[pyo3(signature = (requested_schema=None))]
    fn __arrow_c_stream__<'py>(
        &self,
        py: Python<'py>,
        requested_schema: Option<Bound<'py, PyAny>>,
    ) -> PyResult<Bound<'py, PyCapsule>> {
        let _ = requested_schema;
        let reader = RecordBatchIterator::new(self.batches.clone().into_iter().map(Ok), self.schema.clone());
        let stream = FFI_ArrowArrayStream::new(Box::new(reader));
        PyCapsule::new_with_value(py, stream, c"arrow_array_stream")
    }

    fn num_rows(&self) -> usize {
        self.batches.iter().map(|b| b.num_rows()).sum()
    }

    fn num_columns(&self) -> usize {
        self.schema.fields().len()
    }

    fn columns(&self) -> Vec<String> {
        self.schema.fields().iter().map(|f| f.name().clone()).collect()
    }

    fn schema(&self) -> Vec<(String, String)> {
        schema_list(&self.schema)
    }

    fn num_batches(&self) -> usize {
        self.batches.len()
    }

    #[pyo3(signature = (max_rows=10))]
    fn to_string(&self, max_rows: usize) -> PyResult<String> {
        let head = workhouse_core::exec::pipeline::apply_limit(self.batches.clone(), 0, Some(max_rows));
        let table = if head.is_empty() {
            arrow::util::pretty::pretty_format_batches(&[RecordBatch::new_empty(self.schema.clone())]).py()?
        } else {
            arrow::util::pretty::pretty_format_batches(&head).py()?
        };
        let n = self.num_rows();
        let mut s = format!("shape: ({}, {})\n{}", n, self.schema.fields().len(), table);
        if n > max_rows {
            s.push_str(&format!("\n... {} more rows", n - max_rows));
        }
        Ok(s)
    }

    fn slice(&self, offset: usize, length: usize) -> Self {
        Self {
            schema: self.schema.clone(),
            batches: workhouse_core::exec::pipeline::apply_limit(self.batches.clone(), offset, Some(length)),
        }
    }

    fn lazy(&self, ctx: PyRef<'_, PySessionContext>) -> PyResult<PyLazyFrame> {
        Ok(PyLazyFrame { inner: ctx.inner.from_batches(self.schema.clone(), self.batches.clone()).py()? })
    }

    #[pyo3(signature = (path, compression="zstd", row_group_size=None, storage_options=None))]
    fn write_parquet(
        &self,
        py: Python<'_>,
        path: &str,
        compression: &str,
        row_group_size: Option<usize>,
        storage_options: Option<&Bound<'_, PyDict>>,
    ) -> PyResult<()> {
        let opts = storage::options(storage_options)?;
        let (schema, batches) = (self.schema.clone(), self.batches.clone());
        let (path, compression) = (path.to_string(), compression.to_string());
        py.detach(move || write_parquet_with(&path, schema, &batches, &compression, row_group_size, &opts)).py()
    }

    #[pyo3(signature = (path, has_header=true, delimiter=",", storage_options=None))]
    fn write_csv(
        &self,
        py: Python<'_>,
        path: &str,
        has_header: bool,
        delimiter: &str,
        storage_options: Option<&Bound<'_, PyDict>>,
    ) -> PyResult<()> {
        let opts = storage::options(storage_options)?;
        let batches = self.batches.clone();
        let path = path.to_string();
        let d = delimiter.as_bytes().first().copied().unwrap_or(b',');
        py.detach(move || write_csv_with(&path, &batches, has_header, d, &opts)).py()
    }
}

// ---------------------------------------------------------------------------
// lazy frames
// ---------------------------------------------------------------------------

#[pyclass(name = "PyLazyFrame", module = "workhouse._workhouse", frozen)]
pub struct PyLazyFrame {
    inner: LazyFrame,
}

fn lf(r: Result<LazyFrame, WhError>) -> PyResult<PyLazyFrame> {
    Ok(PyLazyFrame { inner: r.py()? })
}

#[pymethods]
impl PyLazyFrame {
    fn filter(&self, predicate: PyRef<'_, PyExpr>) -> PyResult<Self> {
        lf(self.inner.filter(predicate.inner.clone()))
    }

    fn select(&self, exprs: Vec<PyRef<'_, PyExpr>>) -> PyResult<Self> {
        lf(self.inner.select(exprs_of(&exprs)))
    }

    fn with_columns(&self, exprs: Vec<PyRef<'_, PyExpr>>) -> PyResult<Self> {
        lf(self.inner.with_columns(exprs_of(&exprs)))
    }

    fn group_by_agg(&self, keys: Vec<PyRef<'_, PyExpr>>, aggs: Vec<PyRef<'_, PyExpr>>) -> PyResult<Self> {
        lf(self.inner.aggregate(exprs_of(&keys), exprs_of(&aggs)))
    }

    #[pyo3(signature = (other, left_on, right_on, how="inner", suffix="_right"))]
    fn join(
        &self,
        other: PyRef<'_, PyLazyFrame>,
        left_on: Vec<PyRef<'_, PyExpr>>,
        right_on: Vec<PyRef<'_, PyExpr>>,
        how: &str,
        suffix: &str,
    ) -> PyResult<Self> {
        if how == "cross" {
            return lf(self.inner.cross_join(&other.inner, suffix));
        }
        let jt = JoinType::parse(how).py()?;
        lf(self.inner.join(&other.inner, exprs_of(&left_on), exprs_of(&right_on), jt, suffix))
    }

    fn sort(&self, by: Vec<PyRef<'_, PyExpr>>, descending: Vec<bool>, nulls_last: Vec<bool>) -> PyResult<Self> {
        let sorts = by
            .iter()
            .enumerate()
            .map(|(i, e)| {
                let desc = descending.get(i).copied().unwrap_or(false);
                let nl = nulls_last.get(i).copied().unwrap_or(false);
                SortExpr::new(e.inner.clone(), desc, !nl)
            })
            .collect();
        lf(self.inner.sort(sorts))
    }

    #[pyo3(signature = (offset, length=None))]
    fn slice(&self, offset: usize, length: Option<usize>) -> Self {
        Self { inner: self.inner.slice(offset, length) }
    }

    fn distinct(&self) -> PyResult<Self> {
        lf(self.inner.distinct())
    }

    fn union(&self, others: Vec<PyRef<'_, PyLazyFrame>>) -> PyResult<Self> {
        let o: Vec<LazyFrame> = others.iter().map(|x| x.inner.clone()).collect();
        lf(self.inner.union(&o))
    }

    fn drop(&self, names: Vec<String>) -> PyResult<Self> {
        lf(self.inner.drop(&names))
    }

    fn rename(&self, mapping: Vec<(String, String)>) -> PyResult<Self> {
        lf(self.inner.rename(&mapping))
    }

    fn alias(&self, name: &str) -> Self {
        Self { inner: self.inner.alias(name) }
    }

    #[pyo3(signature = (optimized=true))]
    fn explain(&self, py: Python<'_>, optimized: bool) -> PyResult<String> {
        let inner = self.inner.clone();
        py.detach(move || inner.explain(optimized)).py()
    }

    fn columns(&self) -> Vec<String> {
        self.inner.schema().fields().iter().map(|f| f.name().to_string()).collect()
    }

    fn schema(&self) -> Vec<(String, String)> {
        schema_list(self.inner.schema().arrow_schema())
    }

    /// The result as a lazy Arrow C stream (read once, batch by batch).
    fn stream(&self, py: Python<'_>) -> PyResult<stream::PyResultStream> {
        stream::PyResultStream::open(py, self.inner.clone())
    }

    /// Write the result to Parquet as it is produced; returns the rows written.
    #[pyo3(signature = (path, compression="zstd", row_group_size=None, storage_options=None))]
    fn sink_parquet(
        &self,
        py: Python<'_>,
        path: &str,
        compression: &str,
        row_group_size: Option<usize>,
        storage_options: Option<&Bound<'_, PyDict>>,
    ) -> PyResult<usize> {
        let opts = storage::options(storage_options)?;
        let (lf, path, compression) = (self.inner.clone(), path.to_string(), compression.to_string());
        py.detach(move || lf.sink_parquet(&path, &compression, row_group_size, &opts)).py()
    }

    /// Write the result to CSV as it is produced; returns the rows written.
    #[pyo3(signature = (path, has_header=true, delimiter=",", storage_options=None))]
    fn sink_csv(&self, py: Python<'_>, path: &str, has_header: bool, delimiter: &str, storage_options: Option<&Bound<'_, PyDict>>) -> PyResult<usize> {
        let opts = storage::options(storage_options)?;
        let (lf, path) = (self.inner.clone(), path.to_string());
        let d = delimiter.as_bytes().first().copied().unwrap_or(b',');
        py.detach(move || lf.sink_csv(&path, has_header, d, &opts)).py()
    }

    fn collect(&self, py: Python<'_>) -> PyResult<PyDataFrame> {
        let inner = self.inner.clone();
        let (schema, batches) = py.detach(move || inner.collect()).py()?;
        Ok(PyDataFrame { schema, batches })
    }

    /// `(DataFrame, profile)`: the result and its per-pipeline run profile.
    fn collect_profiled<'py>(&self, py: Python<'py>) -> PyResult<(PyDataFrame, Bound<'py, pyo3::types::PyDict>)> {
        let inner = self.inner.clone();
        let (schema, batches, stats) = py.detach(move || inner.collect_profiled()).py()?;
        Ok((PyDataFrame { schema, batches }, runtime::stats_dict(py, &stats)?))
    }

    /// The physical plan as nested dicts `{name, detail, role, children}`.
    fn plan_tree<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, pyo3::types::PyDict>> {
        let inner = self.inner.clone();
        let tree = py.detach(move || inner.plan_tree()).py()?;
        runtime::plan_dict(py, &tree)
    }
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

#[pyclass(name = "PySessionContext", module = "workhouse._workhouse", frozen)]
pub struct PySessionContext {
    inner: SessionContext,
}

fn csv_options(has_header: bool, delimiter: &str, infer_rows: usize, parallel: bool) -> CsvOptions {
    CsvOptions {
        has_header,
        delimiter: delimiter.as_bytes().first().copied().unwrap_or(b','),
        infer_rows,
        parallel,
        ..Default::default()
    }
}

#[pymethods]
impl PySessionContext {
    #[new]
    fn new() -> Self {
        Self { inner: SessionContext::new() }
    }

    /// Register a Parquet path, directory, glob or URL; with `lazy`, files are
    /// listed (and footers read) on first use instead of now.
    #[pyo3(signature = (name, path, storage_options=None, lazy=false))]
    fn register_parquet(
        &self,
        py: Python<'_>,
        name: &str,
        path: &str,
        storage_options: Option<&Bound<'_, PyDict>>,
        lazy: bool,
    ) -> PyResult<()> {
        let storage = storage::options(storage_options)?;
        let (ctx, name, path) = (self.inner.clone(), name.to_string(), path.to_string());
        py.detach(move || ctx.register_parquet_with(&name, &path, &storage, lazy)).py()
    }

    #[pyo3(signature = (name, path, has_header=true, delimiter=",", infer_rows=10000, parallel=true, storage_options=None, lazy=false))]
    #[allow(clippy::too_many_arguments)]
    fn register_csv(
        &self,
        py: Python<'_>,
        name: &str,
        path: &str,
        has_header: bool,
        delimiter: &str,
        infer_rows: usize,
        parallel: bool,
        storage_options: Option<&Bound<'_, PyDict>>,
        lazy: bool,
    ) -> PyResult<()> {
        let opts = csv_options(has_header, delimiter, infer_rows, parallel);
        let storage = storage::options(storage_options)?;
        let (ctx, name, path) = (self.inner.clone(), name.to_string(), path.to_string());
        py.detach(move || ctx.register_csv_with(&name, &path, opts, &storage, lazy)).py()
    }

    /// Whether a registered table was loaded (False: lazy, not used yet).
    fn is_loaded(&self, name: &str) -> Option<bool> {
        self.inner.is_loaded(name)
    }

    /// `[(column, min, max, nulls, exact), ...]` from file metadata (loads a
    /// lazy table); empty when the table has no such statistics.
    #[allow(clippy::type_complexity)]
    fn column_stats(&self, py: Python<'_>, name: &str) -> PyResult<Vec<(String, Option<String>, Option<String>, u64, bool)>> {
        let (ctx, name) = (self.inner.clone(), name.to_string());
        let entry = py.detach(move || ctx.lookup(&name)).py()?;
        let stats = match entry {
            Some(TableEntry::Table(t)) => t.column_stats().unwrap_or_default(),
            _ => vec![],
        };
        Ok(stats.into_iter().map(|s| (s.column, s.min, s.max, s.nulls, s.exact)).collect())
    }

    fn register_arrow(&self, name: &str, obj: &Bound<'_, PyAny>) -> PyResult<()> {
        let (schema, batches) = import_stream(obj)?;
        self.inner.register_batches(name, schema, batches);
        Ok(())
    }

    fn register_dataframe(&self, name: &str, df: PyRef<'_, PyDataFrame>) {
        self.inner.register_batches(name, df.schema.clone(), df.batches.clone());
    }

    fn register_lazy(&self, name: &str, frame: PyRef<'_, PyLazyFrame>) {
        self.inner.register_view(name, frame.inner.plan.clone());
    }

    fn deregister(&self, name: &str) -> bool {
        self.inner.deregister(name)
    }

    fn fork(&self) -> Self {
        Self { inner: self.inner.fork() }
    }

    fn tables(&self) -> Vec<String> {
        self.inner.table_names()
    }

    fn table(&self, py: Python<'_>, name: &str) -> PyResult<PyLazyFrame> {
        // a lazily registered table may be loaded now (remote I/O): without the GIL
        let (ctx, name) = (self.inner.clone(), name.to_string());
        lf(py.detach(move || ctx.table(&name)))
    }

    fn sql(&self, py: Python<'_>, query: &str) -> PyResult<PyLazyFrame> {
        let (ctx, q) = (self.inner.clone(), query.to_string());
        lf(py.detach(move || ctx.sql(&q)))
    }

    #[pyo3(signature = (path, storage_options=None))]
    fn read_parquet(&self, py: Python<'_>, path: &str, storage_options: Option<&Bound<'_, PyDict>>) -> PyResult<PyLazyFrame> {
        let storage = storage::options(storage_options)?;
        let (ctx, path) = (self.inner.clone(), path.to_string());
        lf(py.detach(move || ctx.read_parquet_with(&path, &storage)))
    }

    #[pyo3(signature = (path, has_header=true, delimiter=",", infer_rows=10000, parallel=true, storage_options=None))]
    #[allow(clippy::too_many_arguments)]
    fn read_csv(
        &self,
        py: Python<'_>,
        path: &str,
        has_header: bool,
        delimiter: &str,
        infer_rows: usize,
        parallel: bool,
        storage_options: Option<&Bound<'_, PyDict>>,
    ) -> PyResult<PyLazyFrame> {
        let opts = csv_options(has_header, delimiter, infer_rows, parallel);
        let storage = storage::options(storage_options)?;
        let (ctx, path) = (self.inner.clone(), path.to_string());
        lf(py.detach(move || ctx.read_csv_with(&path, opts, &storage)))
    }

    fn from_arrow(&self, obj: &Bound<'_, PyAny>) -> PyResult<PyLazyFrame> {
        let (schema, batches) = import_stream(obj)?;
        lf(self.inner.from_batches(schema, batches))
    }

    fn from_dataframe(&self, df: PyRef<'_, PyDataFrame>) -> PyResult<PyLazyFrame> {
        lf(self.inner.from_batches(df.schema.clone(), df.batches.clone()))
    }
}

#[pyfunction]
fn set_num_threads(n: usize) -> PyResult<()> {
    workhouse_core::set_num_threads(n).py()
}

#[pyfunction]
fn num_threads() -> usize {
    workhouse_core::num_threads()
}

#[pymodule]
fn _workhouse(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyExpr>()?;
    m.add_class::<PyLazyFrame>()?;
    m.add_class::<PyDataFrame>()?;
    m.add_class::<PySessionContext>()?;
    m.add_class::<stream::PyResultStream>()?;
    m.add("WorkhouseError", m.py().get_type::<WorkhouseError>())?;
    m.add("QueryCancelled", m.py().get_type::<QueryCancelled>())?;
    m.add("StorageError", m.py().get_type::<StorageError>())?;
    runtime::register(m)?;
    storage::register(m)?;
    memory::register(m)?;
    m.add_function(wrap_pyfunction!(set_num_threads, m)?)?;
    m.add_function(wrap_pyfunction!(num_threads, m)?)?;
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}
