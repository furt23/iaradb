//! A query's result as a lazy record batch reader: the query runs on its own
//! thread and hands batches over a small channel as they are produced, so a
//! consumer in any language reads results larger than memory. Dropping the
//! reader early stops the query.

use std::sync::Arc;
use std::sync::mpsc::{Receiver, sync_channel};

use arrow::datatypes::SchemaRef;
use arrow::error::ArrowError;
use arrow::record_batch::{RecordBatch, RecordBatchReader};
use parking_lot::Mutex;

use crate::LazyFrame;
use crate::error::{Result, WhError};
use crate::exec::query::QueryStats;

/// How the query ended (its profile, or its error), set before the channel
/// closes: a reader at the end of the stream finds it.
pub type Outcome = Arc<Mutex<Option<Result<QueryStats>>>>;

/// Batches in flight between the query and the consumer.
const DEPTH: usize = 4;

pub struct ChannelReader {
    schema: SchemaRef,
    rx: Receiver<Result<RecordBatch>>,
}

impl Iterator for ChannelReader {
    type Item = std::result::Result<RecordBatch, ArrowError>;

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
pub fn start(lf: LazyFrame, outcome: Outcome) -> Result<ChannelReader> {
    let (schema_tx, schema_rx) = sync_channel::<Result<SchemaRef>>(1);
    let (tx, rx) = sync_channel::<Result<RecordBatch>>(DEPTH);
    let slot = outcome.clone();
    std::thread::Builder::new()
        .name("iara-stream".into())
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
