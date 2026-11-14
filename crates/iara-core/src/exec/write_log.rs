//! A process-wide log of the tables written, kept while plan recording is on
//! (see [`crate::physical::analyze::record_plans`]), for lineage and for
//! telling whether a table changed.

use std::collections::VecDeque;

use parking_lot::Mutex;

/// How many writes are kept; the oldest go first.
const WRITES_MAX: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableWrite {
    pub location: String,
    /// the Delta version the write made; `None` for plain files
    pub version: Option<u64>,
    pub operation: String,
}

static WRITES: Mutex<VecDeque<TableWrite>> = Mutex::new(VecDeque::new());

/// Note a write to the table at `location`; nothing unless recording is on.
pub fn note_write(location: &str, version: Option<u64>, operation: &str) {
    if !crate::physical::analyze::recording() {
        return;
    }
    let mut writes = WRITES.lock();
    if writes.len() == WRITES_MAX {
        writes.pop_front();
    }
    writes.push_back(TableWrite { location: location.to_string(), version, operation: operation.to_string() });
}

/// The writes noted since the last call, oldest first.
pub fn take_writes() -> Vec<TableWrite> {
    WRITES.lock().drain(..).collect()
}
