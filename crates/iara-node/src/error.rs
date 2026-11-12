//! Engine errors as JS errors whose `code` tells their kind
//! (`QueryCancelled`, `StorageError`, `IaraError`).

use iara_core::WhError;
use napi::Error;

pub type Result<T, E = Error<String>> = std::result::Result<T, E>;

pub fn err(e: WhError) -> Error<String> {
    let code = match e {
        WhError::Cancelled => "QueryCancelled",
        WhError::Storage(_) => "StorageError",
        _ => "IaraError",
    };
    Error::new(code.to_string(), e.to_string())
}

/// A bad argument.
pub fn invalid(msg: impl ToString) -> Error<String> {
    Error::new("IaraError".to_string(), msg)
}

pub trait ResExt<T> {
    fn js(self) -> Result<T>;
}

impl<T> ResExt<T> for Result<T, WhError> {
    fn js(self) -> Result<T> {
        self.map_err(err)
    }
}

impl<T> ResExt<T> for Result<T, arrow::error::ArrowError> {
    fn js(self) -> Result<T> {
        self.map_err(|e| err(WhError::Arrow(e)))
    }
}

impl<T> ResExt<T> for napi::Result<T> {
    fn js(self) -> Result<T> {
        self.map_err(|e| invalid(e.reason))
    }
}

/// A count or offset from JS (a number) as `usize`.
pub fn count(v: i64, what: &str) -> Result<usize> {
    usize::try_from(v).map_err(|_| invalid(format!("{what} cannot be negative")))
}
