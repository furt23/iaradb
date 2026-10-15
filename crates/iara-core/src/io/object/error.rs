//! object_store errors as engine errors (never carrying credentials).

use crate::error::WhError;

pub fn storage_err(e: object_store::Error, what: &str) -> WhError {
    use object_store::Error as E;
    WhError::Storage(match &e {
        E::NotFound { .. } => format!("{what}: not found"),
        E::PermissionDenied { .. } | E::Unauthenticated { .. } => format!("{what}: access denied ({e})"),
        _ => format!("{what}: {e}"),
    })
}
