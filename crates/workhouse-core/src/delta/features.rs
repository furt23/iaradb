//! What a reader of this crate can open: the protocol versions, table
//! features and file kinds it implements.

use super::actions::{Add, Metadata, Protocol};
use crate::error::{Result, WhError};

/// Table features (named in `readerFeatures`) that need no work from a reader here.
const SUPPORTED_READER_FEATURES: &[&str] = &["timestampNtz"];
const MAX_READER_VERSION: i32 = 3;

fn unsupported(what: String) -> WhError {
    WhError::NotSupported(format!("Delta table uses {what}"))
}

/// Refuse a table that needs more than this reader implements, naming the feature.
pub fn check_reader_support(protocol: &Protocol, metadata: &Metadata, files: &[Add]) -> Result<()> {
    if protocol.min_reader_version > MAX_READER_VERSION {
        return Err(unsupported(format!("reader protocol version {} (supported up to {MAX_READER_VERSION})", protocol.min_reader_version)));
    }
    // name every unsupported feature, sorted: the protocol's set has no fixed order
    let mut missing: Vec<&str> = protocol
        .reader_features
        .iter()
        .flatten()
        .map(String::as_str)
        .filter(|f| !SUPPORTED_READER_FEATURES.contains(f))
        .collect();
    if !missing.is_empty() {
        missing.sort_unstable();
        missing.dedup();
        let names = missing.iter().map(|f| format!("'{f}'")).collect::<Vec<_>>().join(", ");
        let (noun, verb) = if missing.len() == 1 { ("feature", "is") } else { ("features", "are") };
        return Err(unsupported(format!("the reader {noun} {names}, which {verb} not supported")));
    }
    if let Some(mode) = metadata.configuration.get("delta.columnMapping.mode")
        && mode != "none"
    {
        return Err(unsupported(format!("column mapping (delta.columnMapping.mode = '{mode}'), which is not supported")));
    }
    if let Some(add) = files.iter().find(|a| a.deletion_vector.is_some()) {
        return Err(unsupported(format!("deletion vectors (on file '{}'), which are not supported", add.file_path())));
    }
    Ok(())
}
