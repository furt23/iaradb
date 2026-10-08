use arrow::error::ArrowError;
use parquet::errors::ParquetError;

/// Unified error type of the engine.
#[derive(Debug, thiserror::Error)]
pub enum WhError {
    #[error("Arrow error: {0}")]
    Arrow(#[from] ArrowError),
    #[error("Parquet error: {0}")]
    Parquet(#[from] ParquetError),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
    /// Remote storage (object store) failures: not found, access denied, network.
    #[error("Storage error: {0}")]
    Storage(String),
    #[error("SQL error: {0}")]
    Sql(String),
    #[error("Planning error: {0}")]
    Plan(String),
    #[error("Column not found: {0}")]
    ColumnNotFound(String),
    #[error("Execution error: {0}")]
    Execution(String),
    #[error("Not supported: {0}")]
    NotSupported(String),
    #[error("Query cancelled")]
    Cancelled,
}

pub type Result<T, E = WhError> = std::result::Result<T, E>;

#[macro_export]
macro_rules! plan_err {
    ($($arg:tt)*) => { Err($crate::error::WhError::Plan(format!($($arg)*))) };
}

#[macro_export]
macro_rules! exec_err {
    ($($arg:tt)*) => { Err($crate::error::WhError::Execution(format!($($arg)*))) };
}

#[macro_export]
macro_rules! not_supported {
    ($($arg:tt)*) => { Err($crate::error::WhError::NotSupported(format!($($arg)*))) };
}
