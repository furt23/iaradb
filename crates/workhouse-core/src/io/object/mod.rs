//! Object stores (S3, in-memory) behind the synchronous, morsel-driven
//! engine: requests run on a small tokio runtime of their own and worker
//! threads block on them (cancellably) or consume what a prefetcher fetched
//! ahead.

pub mod error;
pub mod file;
pub mod list;
pub mod prefetch;
pub mod registry;
pub mod runtime;
pub mod write;

pub use file::ObjectFile;
pub use registry::{clear_object_stores, memory_store, set_storage_options, storage_options_for};
pub use runtime::{block_on, block_on_cancellable};
