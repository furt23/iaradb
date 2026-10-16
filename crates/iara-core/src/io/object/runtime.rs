//! The I/O runtime: a few tokio threads that drive every remote request.

use std::future::Future;
use std::sync::OnceLock;
use std::time::Duration;

use tokio::runtime::Runtime;

use crate::error::{Result, WhError};
use crate::exec::query::QueryHandle;

/// Threads of the I/O runtime (`IARA_IO_THREADS`, default 4): requests
/// are network bound, a few threads keep many of them in flight.
pub fn io_threads() -> usize {
    std::env::var("IARA_IO_THREADS").ok().and_then(|v| v.parse().ok()).filter(|&n| n > 0).unwrap_or(4)
}

pub fn runtime() -> &'static Runtime {
    static RT: OnceLock<Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(io_threads())
            .thread_name("iara-io")
            .enable_all()
            .build()
            .expect("failed to start the I/O runtime")
    })
}

/// Run a future to completion from a (non-runtime) engine thread.
pub fn block_on<F: Future>(fut: F) -> F::Output {
    runtime().block_on(fut)
}

/// Like [`block_on`], but gives up with `Cancelled` once the query is
/// cancelled (checked every 50 ms), dropping the in-flight requests.
pub fn block_on_cancellable<T>(fut: impl Future<Output = Result<T>>, cancel: Option<&QueryHandle>) -> Result<T> {
    let Some(q) = cancel else {
        return block_on(fut);
    };
    block_on(async {
        tokio::select! {
            r = fut => r,
            _ = cancelled(q) => Err(WhError::Cancelled),
        }
    })
}

pub async fn cancelled(q: &QueryHandle) {
    while !q.is_cancelled() {
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
