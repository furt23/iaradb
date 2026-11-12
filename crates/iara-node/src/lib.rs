//! Node.js bindings for the Iara engine.
//!
//! Data crosses the boundary as Arrow IPC streams (a `Buffer` each). Anything
//! that can read files or run a query returns a Promise and runs off the JS
//! thread; building plans and reading metadata is synchronous.

mod delta;
mod error;
mod expr;
mod file_options;
mod frame;
mod ipc;
mod lazy;
mod memory;
mod runtime;
mod scalar;
mod session;
mod storage;
mod stream;
mod task;
mod window;

#[cfg(unix)]
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;
#[cfg(not(unix))]
#[global_allocator]
static GLOBAL: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[napi_derive::napi]
pub fn version() -> &'static str {
    env!("CARGO_PKG_VERSION")
}

#[napi_derive::napi]
pub fn set_num_threads(n: i64) -> error::Result<()> {
    use error::ResExt;
    iara_core::set_num_threads(usize::try_from(n).map_err(|_| error::invalid("the number of threads cannot be negative"))?).js()
}

#[napi_derive::napi]
pub fn num_threads() -> i64 {
    iara_core::num_threads() as i64
}
