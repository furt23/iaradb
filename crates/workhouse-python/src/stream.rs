//! A query's result as a lazy Arrow C stream: the query runs on its own
//! thread and hands batches over a small channel as they are produced, so
//! a consumer (pyarrow, polars, DuckDB, a file writer) reads results larger
//! than memory. Dropping the stream early stops the query.

use std::sync::Arc;
use std::sync::mpsc::{Receiver, sync_channel};

use arrow::datatypes::SchemaRef;
use arrow::error::ArrowError;
use arrow::ffi_stream::FFI_ArrowArrayStream;
use arrow::record_batch::{RecordBatch, RecordBatchReader};
use pyo3::prelude::*;
use pyo3::types::{PyCapsule, PyDict};

use workhouse_core::exec::query::QueryStats;
use workhouse_core::{LazyFrame, WhError};

use crate::runtime::stats_dict;
use crate::{PyResultExt, err};

/// How the query ended (its profile, or its error), set before the channel
/// closes: a reader at the end of the stream finds it.
type Outcome = Arc<parking_lot::Mutex<Option<Result<QueryStats, WhError>>>>;

/// Batches in flight between the query and the consumer.
const DEPTH: usize = 4;

struct ChannelReader {
    schema: SchemaRef,
    rx: Receiver<Result<RecordBatch, WhError>>,
}

impl Iterator for ChannelReader {
    type Item = Result<RecordBatch, ArrowError>;

    fn next(&mut self) -> Option<Self::Item> {
        // the sender closes the channel when the query ends
        self.rx.recv().ok().map(|r| r.map_err(|e| ArrowError::ExternalError(Box::new(e))))
    }
}

impl RecordBatchReader for ChannelReader {
    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }
}

/// Start the query; returns once its schema is known.
fn start(lf: LazyFrame, outcome: Outcome) -> Result<ChannelReader, WhError> {
    let (schema_tx, schema_rx) = sync_channel::<Result<SchemaRef, WhError>>(1);
    let (tx, rx) = sync_channel::<Result<RecordBatch, WhError>>(DEPTH);
    let slot = outcome.clone();
    std::thread::Builder::new()
        .name("workhouse-stream".into())
        .spawn(move || {
            let mut started = false;
            let result = lf.stream(
                &mut |schema| {
                    started = true;
                    let _ = schema_tx.send(Ok(schema.clone()));
                    Ok(())
                },
                &mut |b| tx.send(Ok(b)).map_err(|_| WhError::Cancelled),
            );
            let failed = result.as_ref().err().map(|e| WhError::Execution(e.to_string()));
            *slot.lock() = Some(result.map(|(_, stats)| stats));
            match failed {
                // planning failed: the error goes where the schema was expected
                Some(e) if !started => drop(schema_tx.send(Err(e))),
                // the reader sees the error (unless it went away: then nobody does)
                Some(e) => drop(tx.send(Err(e))),
                None => {}
            }
        })
        .map_err(|e| WhError::Execution(format!("could not start the query thread: {e}")))?;
    match schema_rx.recv() {
        Ok(Ok(schema)) => Ok(ChannelReader { schema, rx }),
        // the query's own error (its message went through the channel)
        Ok(Err(e)) => Err(match outcome.lock().take() {
            Some(Err(original)) => original,
            _ => e,
        }),
        Err(_) => Err(WhError::Execution("the query thread ended unexpectedly".into())),
    }
}

/// A started query whose result is read once, as an Arrow C stream.
#[pyclass(name = "PyResultStream", module = "workhouse._workhouse")]
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
