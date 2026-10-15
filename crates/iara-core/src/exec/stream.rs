//! Streaming results: a query's batches handed out in order while it runs,
//! instead of being collected (writing large results to files, reading
//! them batch by batch from Python).
//!
//! [`StreamSink`] is the order-preserving end of a pipeline: a morsel's
//! batches are emitted as soon as every earlier morsel was, so only morsels
//! that finished ahead of their turn wait in memory.

use std::collections::BTreeMap;

use arrow::record_batch::RecordBatch;
use parking_lot::Mutex;

use crate::error::Result;
use crate::exec::pipeline::Sink;

/// Where streamed batches go.
pub type Emitter<'a> = &'a mut (dyn FnMut(RecordBatch) -> Result<()> + Send);

struct Order<'a> {
    emit: Emitter<'a>,
    /// finished morsels waiting for earlier ones
    waiting: BTreeMap<usize, Vec<RecordBatch>>,
    next: usize,
    /// LIMIT: rows still to skip / to emit
    skip: usize,
    left: Option<usize>,
}

impl Order<'_> {
    fn send(&mut self, b: RecordBatch) -> Result<()> {
        let n = b.num_rows();
        if n == 0 || self.left == Some(0) {
            return Ok(());
        }
        let start = self.skip.min(n);
        self.skip -= start;
        let len = self.left.map_or(n - start, |l| l.min(n - start));
        if len == 0 {
            return Ok(());
        }
        if let Some(l) = &mut self.left {
            *l -= len;
        }
        (self.emit)(if start == 0 && len == n { b } else { b.slice(start, len) })
    }

    fn release(&mut self) -> Result<()> {
        while let Some(batches) = self.waiting.remove(&self.next) {
            for b in batches {
                self.send(b)?;
            }
            self.next += 1;
        }
        Ok(())
    }
}

pub struct StreamSink<'a> {
    order: Mutex<Order<'a>>,
}

pub struct StreamLocal {
    morsel: Vec<RecordBatch>,
    /// batches pushed after all morsels (operators' trailing output)
    trailing: Vec<RecordBatch>,
}

impl<'a> StreamSink<'a> {
    pub fn new(emit: Emitter<'a>, skip: usize, fetch: Option<usize>) -> Self {
        Self { order: Mutex::new(Order { emit, waiting: BTreeMap::new(), next: 0, skip, left: fetch }) }
    }
}

impl Sink for StreamSink<'_> {
    type Local = StreamLocal;
    type Output = ();

    fn make_local(&self) -> StreamLocal {
        StreamLocal { morsel: vec![], trailing: vec![] }
    }

    fn push(&self, local: &mut StreamLocal, morsel: usize, batch: RecordBatch) -> Result<()> {
        if morsel == usize::MAX {
            local.trailing.push(batch);
        } else {
            local.morsel.push(batch);
        }
        Ok(())
    }

    fn morsel_done(&self, local: &mut StreamLocal, morsel: usize) -> Result<()> {
        let batches = std::mem::take(&mut local.morsel);
        let mut o = self.order.lock();
        o.waiting.insert(morsel, batches);
        o.release()
    }

    fn should_stop(&self) -> bool {
        self.order.lock().left == Some(0)
    }

    fn finalize(&self, locals: Vec<StreamLocal>) -> Result<()> {
        let mut o = self.order.lock();
        // morsels a stopped pipeline never ran leave gaps: emit what is left in order
        let rest: Vec<Vec<RecordBatch>> = std::mem::take(&mut o.waiting).into_values().collect();
        for b in rest.into_iter().flatten() {
            o.send(b)?;
        }
        for b in locals.into_iter().flat_map(|l| l.trailing) {
            o.send(b)?;
        }
        Ok(())
    }
}
