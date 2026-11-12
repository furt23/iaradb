//! Remote storage: option objects, defaults by URL prefix, file listings and
//! request counts.

use std::collections::HashMap;

use napi::{JsValue, ValueType};
use napi::bindgen_prelude::{AsyncTask, Unknown};
use napi_derive::napi;

use iara_core::io::object::{self, StorageRequests};
use iara_core::io::{self, StorageOptions};

use crate::error::{Result, ResExt};
use crate::task::{Job, spawn};

/// A `{key: value}` object as storage options (booleans as `true`/`false`,
/// other values by string conversion; null and undefined values are skipped).
pub fn options(obj: Option<HashMap<String, Unknown<'_>>>) -> Result<StorageOptions> {
    let mut o = StorageOptions::new();
    for (key, v) in obj.into_iter().flatten() {
        let value = match v.get_type().js()? {
            ValueType::Null | ValueType::Undefined => continue,
            // SAFETY: the type was just checked
            ValueType::Boolean => unsafe { v.cast::<bool>() }.js()?.to_string(),
            _ => v.coerce_to_string().and_then(|s| s.into_utf8()).and_then(|s| s.into_owned()).js()?,
        };
        o = o.with(&key, value);
    }
    Ok(o)
}

/// Default options for every URL under `prefix` (null or `{}` removes them).
#[napi]
pub fn set_storage_options(prefix: String, options: Option<HashMap<String, Unknown<'_>>>) -> Result<()> {
    object::set_storage_options(&prefix, self::options(options)?);
    Ok(())
}

#[napi(object)]
pub struct FileEntry {
    pub name: String,
    pub size: i64,
}

/// The files of a path, directory, glob or URL with their sizes in bytes.
#[napi(ts_return_type = "Promise<Array<FileEntry>>")]
pub fn list_files(pattern: String, extension: Option<String>, storage_options: Option<HashMap<String, Unknown<'_>>>) -> Result<AsyncTask<Job<Vec<FileEntry>>>> {
    let opts = options(storage_options)?;
    let extension = extension.unwrap_or_else(|| "parquet".into());
    Ok(spawn(move || {
        let files = io::list_files(&pattern, &extension, &opts).js()?;
        files.iter().map(|f| Ok(FileEntry { name: f.name(), size: f.size().js()? as i64 })).collect()
    }))
}

#[napi(object)]
pub struct Requests {
    pub list: i64,
    pub head: i64,
    pub get: i64,
    /// bytes asked for by GET requests
    pub bytes: i64,
}

pub fn requests(r: &StorageRequests) -> Requests {
    Requests { list: r.list as i64, head: r.head as i64, get: r.get as i64, bytes: r.bytes as i64 }
}

/// Requests this process has made to object stores so far.
#[napi]
pub fn storage_requests() -> Requests {
    requests(&object::storage_requests())
}

/// Forget connections to object stores (e.g. after credentials changed).
#[napi]
pub fn clear_object_stores() {
    object::clear_object_stores();
}
