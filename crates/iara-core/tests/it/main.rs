//! Integration tests, built as one binary: a binary per file would each link the whole engine.
//! Tests that depend on process-wide state (the memory limit, storage request counters) stay
//! in their own files next to this directory, so they run in a process of their own.

mod support;

mod agg_pushdown;
mod aggregates_p1;
mod analyze;
mod csv_multiline;
mod delta_maintenance;
mod delta_dml;
mod delta_write;
mod datasets;
mod delta_read;
mod functions_p1;
mod join_residual;
mod json_io;
mod json_nested;
mod lists;
mod object_io;
mod remote_requests;
mod safe_writes;
mod schemas;
mod spill;
mod sql_delta;
mod sql_delta_dml;
mod streaming;
mod sql_fixes;
mod sql_params;
mod structs;
mod sum_overflow;
