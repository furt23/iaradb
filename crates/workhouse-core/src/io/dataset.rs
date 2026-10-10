//! Folder tables (a directory or object prefix of Parquet files): where one
//! lives, whether a folder holds data, and replacing one.

use crate::error::{Result, WhError};
use crate::io::location::{Location, has_glob};
use crate::io::object;
use crate::io::options::StorageOptions;

/// Where a folder table lives, for writes into it.
#[derive(Debug, Clone)]
pub struct TableLocation {
    pub path: String,
    pub storage: StorageOptions,
    /// its Hive partition columns (new rows go to their folders)
    pub partition_by: Vec<String>,
}

/// A path that names a folder of files (not a glob nor one file).
pub fn is_folder(path: &str) -> bool {
    let p = path.trim_end_matches(['/', '\\']);
    !has_glob(p) && !p.to_ascii_lowercase().ends_with(".parquet")
}

/// `folder/name` with the folder's own separator.
pub fn join(folder: &str, name: &str) -> String {
    let sep = if folder.contains('\\') && !folder.contains("://") { '\\' } else { '/' };
    format!("{}{sep}{name}", folder.trim_end_matches(['/', '\\']))
}

/// Whether the folder exists and holds any file.
pub fn holds_data(path: &str, storage: &StorageOptions) -> Result<bool> {
    match Location::parse(path)? {
        Location::Local(p) => Ok(p.is_dir() && std::fs::read_dir(&p)?.next().is_some()),
        Location::Object(url) => object::remove::any_under(&url, storage),
    }
}

/// Delete a folder table's data (the folder itself, for local paths).
pub fn remove(path: &str, storage: &StorageOptions) -> Result<()> {
    if !is_folder(path) {
        return Err(WhError::Plan(format!("'{path}' is not a folder: only folder tables can be replaced")));
    }
    match Location::parse(path)? {
        Location::Local(p) => {
            if p.exists() {
                std::fs::remove_dir_all(&p)?;
            }
            Ok(())
        }
        Location::Object(url) => object::remove::remove_under(&url, storage).map(|_| ()),
    }
}
