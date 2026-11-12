//! A query's result as a lazy Arrow C stream, so a consumer (pyarrow, polars,
//! DuckDB, a file writer) reads results larger than memory.

use arrow::ffi_stream::FFI_ArrowArrayStream;
use pyo3::prelude::*;
use pyo3::types::{PyCapsule, PyDict};

use iara_core::LazyFrame;
use iara_core::exec::result_stream::{ChannelReader, Outcome, start};

use crate::runtime::stats_dict;
use crate::{PyResultExt, err};

/// A started query whose result is read once, as an Arrow C stream.
#[pyclass(name = "PyResultStream", module = "iara._iara")]
pub struct PyResultStream {
    reader: parking_lot::Mutex<Option<ChannelReader>>,
    outcome: Outcome,
}

impl PyResultStream {
    pub fn open(py: Python<'_>, lf: LazyFrame) -> PyResult<Self> {
        let outcome = Outcome::default();
        let o = outcome.clone();
        let reader = py.detach(move || start(lf, o)).py()?;
        Ok(Self { reader: parking_lot::Mutex::new(Some(reader)), outcome })
    }
}

#[pymethods]
impl PyResultStream {
    #[pyo3(signature = (requested_schema=None))]
    fn __arrow_c_stream__<'py>(&self, py: Python<'py>, requested_schema: Option<Bound<'py, PyAny>>) -> PyResult<Bound<'py, PyCapsule>> {
        let _ = requested_schema;
        let reader = self.reader.lock().take().ok_or_else(|| pyo3::exceptions::PyRuntimeError::new_err("the result stream was already read"))?;
        PyCapsule::new_with_value(py, FFI_ArrowArrayStream::new(Box::new(reader)), c"arrow_array_stream")
    }

    /// The run profile once the stream was read to its end (None before).
    fn profile<'py>(&self, py: Python<'py>) -> PyResult<Option<Bound<'py, PyDict>>> {
        match self.outcome.lock().as_ref() {
            Some(Ok(stats)) => stats_dict(py, stats).map(Some),
            _ => Ok(None),
        }
    }

    /// Raise the query's error, if it failed (as its own exception type:
    /// ``QueryCancelled``, ``StorageError`` ...).
    fn check(&self) -> PyResult<()> {
        let mut outcome = self.outcome.lock();
        match outcome.take() {
            Some(Err(e)) => Err(err(e)),
            other => {
                *outcome = other;
                Ok(())
            }
        }
    }
}
