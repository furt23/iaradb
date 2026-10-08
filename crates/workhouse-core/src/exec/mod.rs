//! Execution: pipelines, operators and sinks.

pub mod accumulators;
pub mod agg_spill;
pub mod aggregate;
pub mod groupby;
pub mod join;
pub mod join_spill;
pub mod memory;
pub mod merge;
pub mod ops;
pub mod packed_sort;
pub mod pipeline;
pub mod query;
pub mod recursive;
pub mod sort;
pub mod spill;
pub mod stream;
pub mod window;
