//! Workhouse Engine: a parallel, vectorized query engine over Apache Arrow.
//!
//! ```text
//!  SQL ──┐                        ┌─> constant folding
//!        ├─> LogicalPlan ─> optimizer ─> predicate / projection / limit pushdown
//!  API ──┘                        └─> join key extraction, top-k
//!              │
//!              v
//!        PhysicalPlan ─> morsel-driven pipelines on a work-stealing pool
//!                         (fused scan->filter->project->probe chains feeding
//!                          parallel sinks: hash aggregate, join build, sort)
//! ```

pub mod catalog_names;
pub mod delta;
pub mod error;
pub mod exec;
pub mod expr;
pub mod hash;
pub mod io;
pub mod logical;
pub mod nested;
pub mod optimizer;
pub mod physical;
pub mod scalar;
pub mod schema;
pub mod session;
pub mod sql;
pub mod types;
pub mod window;

pub use error::{Result, WhError};
pub use expr::{Expr, SortExpr, col, lit};
pub use logical::{JoinType, LogicalPlan};
pub use scalar::Scalar;
pub use session::{LazyFrame, SessionContext};
pub use sql::Params;

/// Configure the size of the global worker pool (must be called before the
/// first query runs).
pub fn set_num_threads(n: usize) -> Result<()> {
    rayon::ThreadPoolBuilder::new()
        .num_threads(n)
        .thread_name(|i| format!("workhouse-{i}"))
        .build_global()
        .map_err(|e| WhError::Execution(format!("thread pool already initialised: {e}")))
}

pub fn num_threads() -> usize {
    rayon::current_num_threads()
}
