//! Delta tables: what the log says about one.

use std::collections::HashMap;

use napi::bindgen_prelude::{AsyncTask, Unknown};
use napi_derive::napi;

use crate::error::{Result, ResExt, invalid};
use crate::storage::options;
use crate::task::{Job, spawn};

#[napi(object)]
pub struct DeltaInfo {
    pub version: i64,
    pub num_files: i64,
    pub size_bytes: i64,
    pub partition_columns: Vec<String>,
    pub not_null_columns: Vec<String>,
    /// milliseconds since the epoch
    pub created_at: Option<i64>,
    /// milliseconds since the epoch
    pub last_modified: i64,
    pub description: Option<String>,
}

/// The Delta table at `path` (a folder or URL), at its newest version.
#[napi(ts_return_type = "Promise<DeltaInfo>")]
pub fn delta_info(path: String, storage_options: Option<HashMap<String, Unknown<'_>>>) -> Result<AsyncTask<Job<DeltaInfo>>> {
    let opts = options(storage_options)?;
    Ok(spawn(move || {
        let d = iara_core::delta::ops::detail::detail(&path, &opts).js()?;
        Ok(DeltaInfo {
            version: d.version as i64,
            num_files: d.num_files as i64,
            size_bytes: d.size_in_bytes as i64,
            partition_columns: d.partition_columns,
            not_null_columns: d.not_null_columns,
            created_at: d.created_at,
            last_modified: d.last_modified,
            description: d.description,
        })
    }))
}

#[napi(object)]
pub struct DeltaCommit {
    pub version: i64,
    /// milliseconds since the epoch
    pub timestamp: i64,
    pub operation: Option<String>,
    pub operation_parameters: HashMap<String, String>,
    pub operation_metrics: HashMap<String, String>,
    pub engine_info: Option<String>,
}

/// The commits of the Delta table at `path`, newest first (at most `limit`).
#[napi(ts_return_type = "Promise<Array<DeltaCommit>>")]
pub fn delta_history(path: String, storage_options: Option<HashMap<String, Unknown<'_>>>, limit: Option<i64>) -> Result<AsyncTask<Job<Vec<DeltaCommit>>>> {
    let opts = options(storage_options)?;
    let limit = limit.map(|l| usize::try_from(l).map_err(|_| invalid("the limit cannot be negative"))).transpose()?;
    Ok(spawn(move || {
        let entries = iara_core::delta::ops::history::history(&path, &opts, limit).js()?;
        Ok(entries
            .into_iter()
            .map(|e| DeltaCommit {
                version: e.version as i64,
                timestamp: e.timestamp_ms,
                operation: e.operation,
                operation_parameters: e.operation_parameters.into_iter().collect(),
                operation_metrics: e.operation_metrics.into_iter().collect(),
                engine_info: e.engine_info,
            })
            .collect())
    }))
}
