//! Expanding a table's path, directory, glob or URL into its data files.

use std::path::PathBuf;

use crate::error::{Result, WhError};
use crate::io::blob::DataFile;
use crate::io::location::Location;
use crate::io::object;
use crate::io::options::StorageOptions;

/// The files `pattern` names (local or remote), sorted.
pub fn list_files(pattern: &str, extension: &str, options: &StorageOptions) -> Result<Vec<DataFile>> {
    match Location::parse(pattern)? {
        Location::Local(_) => Ok(expand_paths(pattern, extension)?.into_iter().map(DataFile::Local).collect()),
        Location::Object(url) => Ok(object::list::list(&url, extension, options)?.into_iter().map(DataFile::Object).collect()),
    }
}

/// Expand a local path, directory or glob pattern into a sorted list of files.
pub fn expand_paths(pattern: &str, extension: &str) -> Result<Vec<PathBuf>> {
    let p = PathBuf::from(pattern);
    let mut out: Vec<PathBuf> = if p.is_dir() {
        let mut v = vec![];
        let mut stack = vec![p];
        while let Some(d) = stack.pop() {
            for e in std::fs::read_dir(&d)? {
                let path = e?.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case(extension)) {
                    v.push(path);
                }
            }
        }
        v
    } else if pattern.contains(['*', '?', '[']) {
        glob::glob(pattern)
            .map_err(|e| WhError::Plan(format!("invalid glob '{pattern}': {e}")))?
            .filter_map(|r| r.ok())
            .filter(|p| p.is_file())
            .collect()
    } else if p.is_file() {
        vec![p]
    } else {
        return Err(WhError::Plan(format!("path '{pattern}' does not exist")));
    };
    out.sort();
    if out.is_empty() {
        return Err(WhError::Plan(format!("no .{extension} files found at '{pattern}'")));
    }
    Ok(out)
}
