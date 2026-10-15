//! Finding the JSON files a path names: a file, glob, URL, or a folder
//! holding `.ndjson`, `.jsonl` or `.json` files.

use std::collections::BTreeMap;

use crate::error::{Result, WhError};
use crate::io::blob::DataFile;
use crate::io::list_files;
use crate::io::options::StorageOptions;

pub const EXTENSIONS: [&str; 3] = ["ndjson", "jsonl", "json"];

pub fn list_json_files(pattern: &str, storage: &StorageOptions) -> Result<Vec<DataFile>> {
    let mut found = BTreeMap::new();
    let mut first_error = None;
    for ext in EXTENSIONS {
        match list_files(pattern, ext, storage) {
            Ok(files) => found.extend(files.into_iter().map(|f| (f.name(), f))),
            // a folder without files of this extension
            Err(WhError::Plan(m)) if m.contains("files found at") => {
                first_error.get_or_insert(WhError::Plan(format!("no .ndjson, .jsonl or .json files found at '{pattern}'")));
            }
            Err(e) => return Err(e),
        }
    }
    if found.is_empty() {
        return Err(first_error.expect("an error when nothing was found"));
    }
    Ok(found.into_values().collect())
}
