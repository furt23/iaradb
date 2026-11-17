//! Python bindings for the Iara engine.
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

use iara_core::expr::{AggFunc, Expr, Operator, ScalarFunc, SortExpr, binary, col, count_star};
use iara_core::io::csv::{CsvOptions, write_csv_with};
use iara_core::io::parquet::{ParquetOptions, write_parquet_with};
use iara_core::session::TableEntry;
use iara_core::types::parse_data_type;
use iara_core::{JoinType, LazyFrame, Scalar, SessionContext, WhError};

mod analyze;
mod delta;
mod file_options;
mod memory;
mod pyobjects;
mod runtime;
mod storage;
mod stream;
mod window;

#[cfg(unix)]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;
#[cfg(not(unix))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

create_exception!(_iara, IaraError, PyException);
create_exception!(_iara, QueryCancelled, IaraError);
create_exception!(_iara, StorageError, IaraError);

fn err(e: WhError) -> PyErr {
    match e {
        WhError::Cancelled => QueryCancelled::new_err(e.to_string()),
        WhError::Storage(_) => StorageError::new_err(e.to_string()),
        e => IaraError::new_err(e.to_string()),
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
    if let Ok(b) = obj.cast::<pyo3::types::PyBytes>() {
        let bytes: &[u8] = b.as_bytes();
        return Ok(Scalar::new(std::sync::Arc::new(arrow::array::BinaryArray::from_vec(vec![bytes]))));
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

/// SQL parameters: a list / tuple (positional), a dict (named) or nothing.
fn sql_params(obj: Option<&Bound<'_, PyAny>>) -> PyResult<iara_core::Params> {
    use iara_core::Params;
    let Some(obj) = obj.filter(|o| !o.is_none()) else {
        return Ok(Params::None);
    };
    if let Ok(d) = obj.cast::<PyDict>() {
        let mut map = std::collections::HashMap::new();
        for (k, v) in d.iter() {
            let key: String = k
                .extract()
                .map_err(|_| PyTypeError::new_err("named SQL parameters need string keys"))?;
            let value = py_scalar(&v).map_err(|e| PyTypeError::new_err(format!("parameter '{key}': {e}")))?;
            map.insert(key, value);
        }
        return Ok(Params::Named(map));
    }
    if obj.is_instance_of::<PyString>() || obj.is_instance_of::<pyo3::types::PyBytes>() {
        return Err(PyTypeError::new_err("SQL parameters must be a list, tuple or dict, not a string or bytes"));
    }
    if obj.is_instance_of::<pyo3::types::PyList>() || obj.is_instance_of::<pyo3::types::PyTuple>() {
        let mut values = vec![];
        for (i, v) in obj.try_iter()?.enumerate() {
            values.push(py_scalar(&v?).map_err(|e| PyTypeError::new_err(format!("parameter {}: {e}", i + 1)))?);
        }
        return Ok(Params::Positional(values));
    }
    Err(PyTypeError::new_err("SQL parameters must be a list, tuple or dict"))
}

// ---------------------------------------------------------------------------
// expressions
// ---------------------------------------------------------------------------

#[pyclass(name = "PyExpr", module = "iara._iara", frozen, skip_from_py_object)]
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
    /// An aggregate over this expression and extra arguments (quantile, max_by, corr ...).
    #[pyo3(signature = (name, extra, distinct=false))]
    fn agg_with(&self, name: &str, extra: Vec<PyRef<'_, PyExpr>>, distinct: bool) -> PyResult<Self> {
        let func = AggFunc::from_name(name).ok_or_else(|| PyValueError::new_err(format!("unknown aggregate '{name}'")))?;
        let mut args = vec![self.inner.clone()];
        args.extend(exprs_of(&extra));
        Ok(wrap(Expr::Agg { func, args, distinct, filter: None, order_by: vec![] }))
    }

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
        Ok(wrap(Expr::Agg { func, args: vec![self.inner.clone()], distinct, filter: None, order_by: vec![] }))
    }

    /// Restrict an aggregate to the rows where `predicate` holds.
    fn agg_filter(&self, predicate: PyRef<'_, PyExpr>) -> PyResult<Self> {
        match self.inner.clone().unalias() {
            Expr::Agg { func, args, distinct, order_by, .. } => Ok(wrap(Expr::Agg {
                func,
                args,
                distinct,
                filter: Some(Box::new(predicate.inner.clone())),
                order_by,
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

struct FrameInner {
    batches: Vec<RecordBatch>,
    idx: Option<std::sync::Arc<[u32]>>,
}

#[pyclass(name = "PyDataFrame", module = "iara._iara", frozen)]
pub struct PyDataFrame {
    schema: SchemaRef,
    inner: parking_lot::Mutex<FrameInner>,
}

impl PyDataFrame {
    fn new(schema: SchemaRef, batches: Vec<RecordBatch>) -> Self {
        Self { schema, inner: parking_lot::Mutex::new(FrameInner { batches, idx: None }) }
    }

    fn from_collected(c: iara_core::session::Collected) -> Self {
        match c {
            iara_core::session::Collected::Batches(schema, batches) => Self::new(schema, batches),
            iara_core::session::Collected::Sorted { schema, batches, idx } => Self {
                schema,
                inner: parking_lot::Mutex::new(FrameInner { batches, idx: Some(idx) }),
            },
        }
    }

    fn batches(&self) -> PyResult<Vec<RecordBatch>> {
        let mut g = self.inner.lock();
        if let Some(idx) = g.idx.take() {
            g.batches = iara_core::exec::sort::gather(&self.schema, &g.batches, &idx, iara_core::exec::pipeline::MORSEL_ROWS).py()?;
        }
        Ok(g.batches.clone())
    }
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
    schema.fields().iter().map(|f| (f.name().clone(), iara_core::nested::type_name(f.data_type()))).collect()
}

#[pymethods]
impl PyDataFrame {
    #[staticmethod]
    fn from_arrow(obj: &Bound<'_, PyAny>) -> PyResult<Self> {
        let (schema, batches) = import_stream(obj)?;
        Ok(Self::new(schema, batches))
    }

    /// A frame from a dict of columns. Lists of plain values (integers, floats, booleans,
    /// strings) are converted here; every other column by pyarrow, as `pyarrow.table` does.
    #[staticmethod]
    fn from_pydict(data: &Bound<'_, PyDict>) -> PyResult<Self> {
        let py = data.py();
        let mut columns: Vec<(String, Option<arrow::array::ArrayRef>)> = Vec::with_capacity(data.len());
        let others = PyDict::new(py);
        for (name, values) in data.iter() {
            let column = pyobjects::column_from_py(&values)?;
            if column.is_none() {
                others.set_item(&name, &values)?;
            }
            columns.push((name.extract()?, column));
        }
        if !others.is_empty() {
            let (schema, batches) = import_stream(&py.import("pyarrow")?.call_method1("table", (others,))?)?;
            let table = arrow::compute::concat_batches(&schema, &batches).py()?;
            for (name, column) in columns.iter_mut().filter(|(_, c)| c.is_none()) {
                *column = table.column_by_name(name).cloned();
            }
        }
        let mut fields = Vec::with_capacity(columns.len());
        let mut arrays = Vec::with_capacity(columns.len());
        for (name, column) in columns {
            let column = column.ok_or_else(|| PyValueError::new_err(format!("column '{name}' could not be converted")))?;
            if arrays.first().is_some_and(|first: &arrow::array::ArrayRef| first.len() != column.len()) {
                return Err(PyValueError::new_err(format!("column '{name}' has {} values, the columns before it {}", column.len(), arrays[0].len())));
            }
            fields.push(arrow::datatypes::Field::new(name, column.data_type().clone(), true));
            arrays.push(column);
        }
        let schema = std::sync::Arc::new(arrow::datatypes::Schema::new(fields));
        let batch = if arrays.is_empty() { RecordBatch::new_empty(schema.clone()) } else { RecordBatch::try_new(schema.clone(), arrays).py()? };
        Ok(Self::new(schema, vec![batch]))
    }

    /// One dict per row of columns given as lists (see [`pyobjects::rows_as_dicts`]).
    #[staticmethod]
    fn rows_as_dicts<'py>(names: &Bound<'py, pyo3::types::PyList>, columns: &Bound<'py, pyo3::types::PyList>) -> PyResult<Bound<'py, pyo3::types::PyList>> {
        pyobjects::rows_as_dicts(names, columns)
    }

    /// Each column as a Python list, or `None` for a column whose type pyarrow converts
    /// (see [`pyobjects`]).
    fn to_pylists<'py>(&self, py: Python<'py>) -> PyResult<Vec<Option<Bound<'py, pyo3::types::PyList>>>> {
        let batches = self.batches()?;
        (0..self.schema.fields().len())
            .map(|c| {
                let chunks: Vec<arrow::array::ArrayRef> = batches.iter().map(|b| b.column(c).clone()).collect();
                if chunks.is_empty() {
                    return Ok(Some(pyo3::types::PyList::empty(py)));
                }
                pyobjects::column_to_py(py, &chunks)
            })
            .collect()
    }

    #[pyo3(signature = (requested_schema=None))]
    fn __arrow_c_stream__<'py>(
        &self,
        py: Python<'py>,
        requested_schema: Option<Bound<'py, PyAny>>,
    ) -> PyResult<Bound<'py, PyCapsule>> {
        let _ = requested_schema;
        let batches = self.batches()?;
        let reader = RecordBatchIterator::new(batches.into_iter().map(Ok), self.schema.clone());
        let stream = FFI_ArrowArrayStream::new(Box::new(reader));
        PyCapsule::new_with_value(py, stream, c"arrow_array_stream")
    }

    fn num_rows(&self) -> usize {
        let g = self.inner.lock();
        match &g.idx {
            Some(idx) => idx.len(),
            None => g.batches.iter().map(|b| b.num_rows()).sum(),
        }
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

    fn num_batches(&self) -> PyResult<usize> {
        Ok(self.batches()?.len())
    }

    #[pyo3(signature = (max_rows=10))]
    fn to_string(&self, max_rows: usize) -> PyResult<String> {
        let head = {
            let g = self.inner.lock();
            match &g.idx {
                Some(idx) => {
                    let end = max_rows.min(idx.len());
                    iara_core::exec::sort::gather(&self.schema, &g.batches, &idx[..end], iara_core::exec::pipeline::MORSEL_ROWS).py()?
                }
                None => iara_core::exec::pipeline::apply_limit(g.batches.clone(), 0, Some(max_rows)),
            }
        };
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

    fn slice(&self, offset: usize, length: usize) -> PyResult<Self> {
        let g = self.inner.lock();
        if let Some(idx) = &g.idx {
            let start = offset.min(idx.len());
            let end = start.saturating_add(length).min(idx.len());
            let batches = iara_core::exec::sort::gather(
                &self.schema,
                &g.batches,
                &idx[start..end],
                iara_core::exec::pipeline::MORSEL_ROWS,
            )
            .py()?;
            return Ok(Self::new(self.schema.clone(), batches));
        }
        let batches = iara_core::exec::pipeline::apply_limit(g.batches.clone(), offset, Some(length));
        Ok(Self::new(self.schema.clone(), batches))
    }

    fn lazy(&self, ctx: PyRef<'_, PySessionContext>) -> PyResult<PyLazyFrame> {
        Ok(PyLazyFrame { inner: ctx.inner.from_batches(self.schema.clone(), self.batches()?).py()? })
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
        let (schema, batches) = (self.schema.clone(), self.batches()?);
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
        let batches = self.batches()?;
        let path = path.to_string();
        let d = delimiter.as_bytes().first().copied().unwrap_or(b',');
        py.detach(move || write_csv_with(&path, &batches, has_header, d, &opts)).py()
    }

    /// Write one JSON object per row (NDJSON).
    #[pyo3(signature = (path, storage_options=None))]
    fn write_ndjson(&self, py: Python<'_>, path: &str, storage_options: Option<&Bound<'_, PyDict>>) -> PyResult<()> {
        let opts = storage::options(storage_options)?;
        let (batches, path) = (self.batches()?, path.to_string());
        py.detach(move || iara_core::io::json::write_json_with(&path, &batches, &opts)).py()
    }
}

// ---------------------------------------------------------------------------
// lazy frames
// ---------------------------------------------------------------------------

#[pyclass(name = "PyLazyFrame", module = "iara._iara", frozen)]
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

    /// One row per element of the list columns, in their place.
    fn explode(&self, columns: Vec<String>) -> PyResult<Self> {
        lf(self.inner.explode(&columns))
    }

    /// The struct columns replaced by one column per field.
    #[pyo3(signature = (columns, separator=None))]
    fn unnest(&self, columns: Vec<String>, separator: Option<String>) -> PyResult<Self> {
        lf(self.inner.unnest(&columns, separator.as_deref()))
    }

    /// The field names of the struct `expr` evaluates to; None when it is not a struct.
    fn struct_fields(&self, expr: PyRef<'_, PyExpr>) -> PyResult<Option<Vec<String>>> {
        self.inner.struct_field_names(&expr.inner).py()
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

    /// Write the result to Parquet as it is produced (Hive-partitioned with
    /// `partition_by`); returns the rows written.
    #[pyo3(signature = (path, compression="zstd", row_group_size=None, storage_options=None, partition_by=None))]
    fn sink_parquet(
        &self,
        py: Python<'_>,
        path: &str,
        compression: &str,
        row_group_size: Option<usize>,
        storage_options: Option<&Bound<'_, PyDict>>,
        partition_by: Option<Vec<String>>,
    ) -> PyResult<usize> {
        let storage = storage::options(storage_options)?;
        let opts = ParquetOptions { compression: compression.to_string(), row_group_size, partition_by: partition_by.unwrap_or_default() };
        let (lf, path) = (self.inner.clone(), path.to_string());
        py.detach(move || lf.sink_parquet(&path, &opts, &storage)).py()
    }

    /// Write the result to a Delta table (a path or object store URL) as it is
    /// produced; returns `{"version", "files", "rows", "skipped"}`. `mode` is
    /// `error`, `append`, `overwrite` or `ignore`; `merge_schema` lets an
    /// append or overwrite add the result's new columns to the table.
    #[pyo3(signature = (path, mode="error", partition_by=None, storage_options=None, merge_schema=false))]
    fn sink_delta<'py>(
        &self,
        py: Python<'py>,
        path: &str,
        mode: &str,
        partition_by: Option<Vec<String>>,
        storage_options: Option<&Bound<'_, PyDict>>,
        merge_schema: bool,
    ) -> PyResult<Bound<'py, PyDict>> {
        let storage = storage::options(storage_options)?;
        let mode = iara_core::delta::WriteMode::parse(mode).py()?;
        let (lf, path, partition_by) = (self.inner.clone(), path.to_string(), partition_by.unwrap_or_default());
        let summary = py.detach(move || iara_core::delta::write_table(&lf, &path, &storage, mode, &partition_by, merge_schema)).py()?;
        let out = PyDict::new(py);
        out.set_item("version", summary.version)?;
        out.set_item("files", summary.files)?;
        out.set_item("rows", summary.rows)?;
        out.set_item("skipped", summary.skipped)?;
        Ok(out)
    }

    /// Write the result to CSV as it is produced; returns the rows written.
    #[pyo3(signature = (path, has_header=true, delimiter=",", storage_options=None))]
    fn sink_csv(&self, py: Python<'_>, path: &str, has_header: bool, delimiter: &str, storage_options: Option<&Bound<'_, PyDict>>) -> PyResult<usize> {
        let opts = storage::options(storage_options)?;
        let (lf, path) = (self.inner.clone(), path.to_string());
        let d = delimiter.as_bytes().first().copied().unwrap_or(b',');
        py.detach(move || lf.sink_csv(&path, has_header, d, &opts)).py()
    }

    /// Write the result as NDJSON while it is produced; returns the rows written.
    #[pyo3(signature = (path, storage_options=None))]
    fn sink_ndjson(&self, py: Python<'_>, path: &str, storage_options: Option<&Bound<'_, PyDict>>) -> PyResult<usize> {
        let opts = storage::options(storage_options)?;
        let (lf, path) = (self.inner.clone(), path.to_string());
        py.detach(move || iara_core::io::json::sink_json(&lf, &path, &opts)).py()
    }

    fn collect(&self, py: Python<'_>) -> PyResult<PyDataFrame> {
        let inner = self.inner.clone();
        let collected = py.detach(move || inner.collect_lazy()).py()?;
        Ok(PyDataFrame::from_collected(collected))
    }

    /// `(DataFrame, profile)`: the result and its per-pipeline run profile.
    fn collect_profiled<'py>(&self, py: Python<'py>) -> PyResult<(PyDataFrame, Bound<'py, pyo3::types::PyDict>)> {
        let inner = self.inner.clone();
        let (collected, stats) = py.detach(move || inner.collect_lazy_profiled()).py()?;
        Ok((PyDataFrame::from_collected(collected), runtime::stats_dict(py, &stats)?))
    }

    /// Run the query measuring every operator (its result is read batch by
    /// batch and discarded): `{plan, profile, rows, requests}`, where `plan`
    /// is the physical plan with a `metrics` dict on each node.
    fn analyze<'py>(&self, py: Python<'py>) -> PyResult<Bound<'py, PyDict>> {
        let plan = self.inner.plan.clone();
        let run = py.detach(move || iara_core::physical::analyze::analyze(&plan)).py()?;
        analyze::analysis_dict(py, &run)
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

#[pyclass(name = "PySessionContext", module = "iara._iara", frozen)]
pub struct PySessionContext {
    inner: SessionContext,
}

fn csv_options(has_header: bool, delimiter: &str, infer_rows: usize, parallel: bool, extra: Option<&Bound<'_, PyDict>>) -> PyResult<CsvOptions> {
    let base = CsvOptions {
        has_header,
        delimiter: delimiter.as_bytes().first().copied().unwrap_or(b','),
        infer_rows,
        parallel,
        ..Default::default()
    };
    file_options::csv_options(extra, base)
}

#[pymethods]
impl PySessionContext {
    /// `default_catalog`: the name of the catalog that registrations belong
    /// to and the session starts in (`main` when not given).
    #[new]
    #[pyo3(signature = (default_catalog=None))]
    fn new(default_catalog: Option<&str>) -> PyResult<Self> {
        let inner = match default_catalog {
            Some(name) => SessionContext::with_default_catalog(name).py()?,
            None => SessionContext::new(),
        };
        Ok(Self { inner })
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

    /// Register a folder of Parquet files or a Delta table (told apart once, when the table loads).
    #[pyo3(signature = (name, path, storage_options=None, lazy=false))]
    fn register_table(&self, py: Python<'_>, name: &str, path: &str, storage_options: Option<&Bound<'_, PyDict>>, lazy: bool) -> PyResult<()> {
        let storage = storage::options(storage_options)?;
        let (ctx, name, path) = (self.inner.clone(), name.to_string(), path.to_string());
        py.detach(move || ctx.register_table_at(&name, &path, &storage, lazy)).py()
    }

    /// Register a Delta table, at its newest version.
    #[pyo3(signature = (name, path, storage_options=None, lazy=false))]
    fn register_delta(&self, py: Python<'_>, name: &str, path: &str, storage_options: Option<&Bound<'_, PyDict>>, lazy: bool) -> PyResult<()> {
        let storage = storage::options(storage_options)?;
        let (ctx, name, path) = (self.inner.clone(), name.to_string(), path.to_string());
        py.detach(move || ctx.register_delta(&name, &path, &storage, None, lazy)).py()
    }

    #[pyo3(signature = (name, path, has_header=true, delimiter=",", infer_rows=10000, parallel=true, storage_options=None, lazy=false, options=None))]
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
        options: Option<&Bound<'_, PyDict>>,
    ) -> PyResult<()> {
        let opts = csv_options(has_header, delimiter, infer_rows, parallel, options)?;
        let storage = storage::options(storage_options)?;
        let (ctx, name, path) = (self.inner.clone(), name.to_string(), path.to_string());
        py.detach(move || ctx.register_csv_with(&name, &path, opts, &storage, lazy)).py()
    }

    /// Register JSON / NDJSON files (a path, folder, glob or URL) as a table.
    #[pyo3(signature = (name, path, options=None, storage_options=None, lazy=false))]
    fn register_json(
        &self,
        py: Python<'_>,
        name: &str,
        path: &str,
        options: Option<&Bound<'_, PyDict>>,
        storage_options: Option<&Bound<'_, PyDict>>,
        lazy: bool,
    ) -> PyResult<()> {
        let opts = file_options::json_options(options)?;
        let storage = storage::options(storage_options)?;
        let (ctx, name, path) = (self.inner.clone(), name.to_string(), path.to_string());
        py.detach(move || iara_core::io::json::register_json(&ctx, &name, &path, opts, &storage, lazy)).py()
    }

    #[pyo3(signature = (path, options=None, storage_options=None))]
    fn read_json(&self, py: Python<'_>, path: &str, options: Option<&Bound<'_, PyDict>>, storage_options: Option<&Bound<'_, PyDict>>) -> PyResult<PyLazyFrame> {
        let opts = file_options::json_options(options)?;
        let storage = storage::options(storage_options)?;
        let (ctx, path) = (self.inner.clone(), path.to_string());
        lf(py.detach(move || iara_core::io::json::read_json(&ctx, &path, opts, &storage)))
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
        self.inner.register_batches(name, schema, batches).py()
    }

    fn register_dataframe(&self, name: &str, df: PyRef<'_, PyDataFrame>) -> PyResult<()> {
        self.inner.register_batches(name, df.schema.clone(), df.batches()?).py()
    }

    fn register_lazy(&self, name: &str, frame: PyRef<'_, PyLazyFrame>) -> PyResult<()> {
        self.inner.register_view(name, frame.inner.plan.clone()).py()
    }

    fn deregister(&self, name: &str) -> bool {
        self.inner.deregister(name)
    }

    fn fork(&self) -> Self {
        Self { inner: self.inner.fork() }
    }

    /// The same tables read through an allow list (`*`, `catalog`, `catalog.schema`, `catalog.schema.table`): queries only, no files, no writes.
    fn restricted(&self, allow: Vec<String>) -> Self {
        Self { inner: self.inner.restricted(allow) }
    }

    /// The tables a restricted session has read so far (`catalog.schema.table`, sorted); none when it is not restricted.
    fn tables_read(&self) -> Vec<String> {
        self.inner.tables_read()
    }

    /// `{location: catalog.schema.table}` of the loaded tables that live in storage.
    fn table_locations(&self) -> std::collections::HashMap<String, String> {
        self.inner.table_locations().into_iter().collect()
    }

    /// Where `CREATE TABLE ... AS` writes tables (None: in memory).
    #[pyo3(signature = (path, storage_options=None))]
    fn set_warehouse(&self, path: Option<&str>, storage_options: Option<&Bound<'_, PyDict>>) -> PyResult<()> {
        self.inner.set_warehouse(path, &storage::options(storage_options)?);
        Ok(())
    }

    fn warehouse(&self) -> Option<String> {
        self.inner.warehouse().map(|(p, _)| p)
    }

    /// Where `CREATE TABLE schema.t AS ...` writes `t/` (None: the warehouse).
    /// `schema` is `s` (of the default catalog) or `c.s`.
    #[pyo3(signature = (schema, path, storage_options=None))]
    fn set_schema_location(&self, schema: &str, path: Option<&str>, storage_options: Option<&Bound<'_, PyDict>>) -> PyResult<()> {
        self.inner.set_schema_location(schema, path, &storage::options(storage_options)?).py()
    }

    fn schema_location(&self, schema: &str) -> Option<String> {
        self.inner.schema_location(schema).map(|(p, _)| p)
    }

    /// The tables' display names: in the default catalog bare in `main` and
    /// `schema.table` elsewhere; in any other catalog `catalog.schema.table`.
    fn tables(&self) -> Vec<String> {
        self.inner.table_names()
    }

    /// The catalogs: the default one first, then the others sorted.
    fn catalogs(&self) -> Vec<String> {
        self.inner.catalogs()
    }

    /// The catalog `USE CATALOG` selected (the default one at first).
    fn current_catalog(&self) -> String {
        self.inner.current_catalog()
    }

    /// The catalog that registrations and `table()` names belong to.
    fn default_catalog(&self) -> String {
        self.inner.default_catalog()
    }

    /// The schemas of a catalog (None: the current one): `main` first, then the others sorted.
    #[pyo3(signature = (catalog=None))]
    fn schemas(&self, catalog: Option<&str>) -> PyResult<Vec<String>> {
        match catalog {
            Some(c) => self.inner.schemas_of(c).py(),
            None => Ok(self.inner.schemas()),
        }
    }

    /// The schema `USE` selected in the current catalog (`main` at first).
    fn current_schema(&self) -> String {
        self.inner.current_schema()
    }

    /// A registered table, named like in `register_*` (relative to the default catalog).
    fn table(&self, py: Python<'_>, name: &str) -> PyResult<PyLazyFrame> {
        // a lazily registered table may be loaded now (remote I/O): without the GIL
        let (ctx, name) = (self.inner.clone(), name.to_string());
        lf(py.detach(move || ctx.table(&name)))
    }

    /// `params`: a list or tuple (`$1`, `$2`, `?`) or a dict (`:name`, `$name`).
    #[pyo3(signature = (query, params=None))]
    fn sql(&self, py: Python<'_>, query: &str, params: Option<&Bound<'_, PyAny>>) -> PyResult<PyLazyFrame> {
        let params = sql_params(params)?;
        let (ctx, q) = (self.inner.clone(), query.to_string());
        lf(py.detach(move || ctx.sql_with(&q, &params)))
    }

    #[pyo3(signature = (path, storage_options=None))]
    fn read_parquet(&self, py: Python<'_>, path: &str, storage_options: Option<&Bound<'_, PyDict>>) -> PyResult<PyLazyFrame> {
        let storage = storage::options(storage_options)?;
        let (ctx, path) = (self.inner.clone(), path.to_string());
        lf(py.detach(move || ctx.read_parquet_with(&path, &storage)))
    }

    /// A Delta table; `timestamp` is milliseconds since the epoch.
    #[pyo3(signature = (path, version=None, timestamp=None, storage_options=None))]
    fn read_delta(
        &self,
        py: Python<'_>,
        path: &str,
        version: Option<u64>,
        timestamp: Option<i64>,
        storage_options: Option<&Bound<'_, PyDict>>,
    ) -> PyResult<PyLazyFrame> {
        use iara_core::delta::VersionSpec;
        let spec = match (version, timestamp) {
            (Some(_), Some(_)) => return Err(PyValueError::new_err("give a version or a timestamp, not both")),
            (Some(v), None) => Some(VersionSpec::Version(v)),
            (None, Some(t)) => Some(VersionSpec::Timestamp(t)),
            (None, None) => None,
        };
        let storage = storage::options(storage_options)?;
        let (ctx, path) = (self.inner.clone(), path.to_string());
        lf(py.detach(move || ctx.read_delta(&path, &storage, spec)))
    }

    #[pyo3(signature = (path, has_header=true, delimiter=",", infer_rows=10000, parallel=true, storage_options=None, options=None))]
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
        options: Option<&Bound<'_, PyDict>>,
    ) -> PyResult<PyLazyFrame> {
        let opts = csv_options(has_header, delimiter, infer_rows, parallel, options)?;
        let storage = storage::options(storage_options)?;
        let (ctx, path) = (self.inner.clone(), path.to_string());
        lf(py.detach(move || ctx.read_csv_with(&path, opts, &storage)))
    }

    fn from_arrow(&self, obj: &Bound<'_, PyAny>) -> PyResult<PyLazyFrame> {
        let (schema, batches) = import_stream(obj)?;
        lf(self.inner.from_batches(schema, batches))
    }

    fn from_dataframe(&self, df: PyRef<'_, PyDataFrame>) -> PyResult<PyLazyFrame> {
        lf(self.inner.from_batches(df.schema.clone(), df.batches()?))
    }
}

#[pyfunction]
fn set_num_threads(n: usize) -> PyResult<()> {
    iara_core::set_num_threads(n).py()
}

#[pyfunction]
fn num_threads() -> usize {
    iara_core::num_threads()
}

#[pymodule]
fn _iara(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyExpr>()?;
    m.add_class::<PyLazyFrame>()?;
    m.add_class::<PyDataFrame>()?;
    m.add_class::<PySessionContext>()?;
    m.add_class::<stream::PyResultStream>()?;
    m.add("IaraError", m.py().get_type::<IaraError>())?;
    m.add("QueryCancelled", m.py().get_type::<QueryCancelled>())?;
    m.add("StorageError", m.py().get_type::<StorageError>())?;
    runtime::register(m)?;
    storage::register(m)?;
    delta::register(m)?;
    memory::register(m)?;
    m.add_function(wrap_pyfunction!(set_num_threads, m)?)?;
    m.add_function(wrap_pyfunction!(num_threads, m)?)?;
    m.add("__version__", env!("CARGO_PKG_VERSION"))?;
    Ok(())
}
