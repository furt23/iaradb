//! A query's result read batch by batch, each as a standalone IPC stream.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use arrow::datatypes::SchemaRef;
use napi::bindgen_prelude::{AsyncTask, Buffer};
use napi_derive::napi;

use iara_core::LazyFrame;
use iara_core::exec::result_stream::{ChannelReader, Outcome, start};

use crate::error::{Result, ResExt, err};
use crate::frame::{SchemaField, schema_list};
use crate::ipc::to_ipc;
use crate::task::{Job, spawn};

struct Shared {
    reader: parking_lot::Mutex<Option<ChannelReader>>,
    /// set by `close()`: it cannot take the reader while a `next()` waits on it
    closed: AtomicBool,
    outcome: Outcome,
}

#[napi]
pub struct JsResultStream {
    shared: Arc<Shared>,
    schema: SchemaRef,
}

impl JsResultStream {
    pub fn open(lf: LazyFrame) -> Result<Self> {
        let outcome = Outcome::default();
        let reader = start(lf, outcome.clone()).js()?;
        let schema = arrow::record_batch::RecordBatchReader::schema(&reader);
        Ok(Self { shared: Arc::new(Shared { reader: parking_lot::Mutex::new(Some(reader)), closed: AtomicBool::new(false), outcome }), schema })
    }
}

#[napi]
impl JsResultStream {
    /// The next batch (with its schema) as an IPC stream; null at the end.
    #[napi(ts_return_type = "Promise<Buffer | null>")]
    pub fn next(&self) -> AsyncTask<Job<Option<Buffer>>> {
        let (s, schema) = (self.shared.clone(), self.schema.clone());
        spawn(move || {
            let mut slot = s.reader.lock();
            if s.closed.load(Ordering::Acquire) {
                *slot = None;
            }
            let Some(reader) = slot.as_mut() else { return Ok(None) };
            let item = reader.next();
            if s.closed.load(Ordering::Acquire) {
                *slot = None;
                return Ok(None);
            }
            match item {
                Some(Ok(batch)) => Ok(Some(Buffer::from(to_ipc(&schema, &[batch])?))),
                None => {
                    *slot = None;
                    Ok(None)
                }
                Some(Err(e)) => {
                    *slot = None;
                    // the engine's own error (cancelled, storage ...) is in the outcome
                    match s.outcome.lock().take() {
                        Some(Err(original)) => Err(err(original)),
                        _ => Err(err(iara_core::WhError::Arrow(e))),
                    }
                }
            }
        })
    }

    /// Stop the query. Without waiting: a `next()` in flight ends the query when it returns.
    #[napi]
    pub fn close(&self) {
        self.shared.closed.store(true, Ordering::Release);
        if let Some(mut slot) = self.shared.reader.try_lock() {
            *slot = None;
        }
    }

    #[napi]
    pub fn schema(&self) -> Vec<SchemaField> {
        schema_list(&self.schema)
    }
}
