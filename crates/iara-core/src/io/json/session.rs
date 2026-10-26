//! JSON entry points on the session: reading, registering and sinking.

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};

use parking_lot::Mutex;

use super::{JsonOptions, JsonSink, JsonTable};
use crate::error::Result;
use crate::io::StorageOptions;
use crate::session::{LazyFrame, SessionContext};

/// Scan JSON files (a path, folder, glob or URL).
pub fn read_json(ctx: &SessionContext, path: &str, options: JsonOptions, storage: &StorageOptions) -> Result<LazyFrame> {
    ctx.check_files()?;
    ctx.scan_provider(path, Arc::new(JsonTable::try_new_with(path, options, storage)?))
}

/// Register JSON files as a table; with `lazy`, they are listed on first use.
pub fn register_json(ctx: &SessionContext, name: &str, path: &str, options: JsonOptions, storage: &StorageOptions, lazy: bool) -> Result<()> {
    let (path, storage) = (path.to_string(), storage.clone());
    ctx.register_loader(name, lazy, move || Ok(Arc::new(JsonTable::try_new_with(&path, options.clone(), &storage)?)))
}

/// Write the result as NDJSON while it is produced; returns the rows written.
pub fn sink_json(lf: &LazyFrame, path: &str, storage: &StorageOptions) -> Result<usize> {
    let sink = Mutex::new(None::<JsonSink>);
    let rows = AtomicUsize::new(0);
    lf.stream(
        &mut |_| {
            *sink.lock() = Some(JsonSink::create(path, storage)?);
            Ok(())
        },
        &mut |b| {
            rows.fetch_add(b.num_rows(), Ordering::Relaxed);
            sink.lock().as_mut().expect("writer").write(&b)
        },
    )?;
    sink.into_inner().expect("writer").finish()?;
    Ok(rows.into_inner())
}
