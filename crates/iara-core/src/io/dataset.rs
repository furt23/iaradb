//! Folder tables (a directory or object prefix of Parquet files): where one
//! lives, whether a folder holds data, and replacing one. A replacement
//! writes the new files first, then deletes exactly the files the folder held
//! before ([`list_files`], [`remove_files`]), so a failed write loses nothing.

use crate::error::{Result, WhError};
use crate::io::location::{Location, ObjectUrl, has_glob};
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

/// Whether a name is a writer's unfinished file (`<name>.tmp-<id>`).
fn is_temporary(name: &str) -> bool {
    name.contains(".tmp-")
}

/// Every file in a folder table (all folders below it, any extension), sorted;
/// none if the folder does not exist. Unfinished files of a running write
/// (`.tmp-`) are left out.
pub fn list_files(path: &str, storage: &StorageOptions) -> Result<Vec<String>> {
    if !is_folder(path) {
        return Err(WhError::Plan(format!("'{path}' is not a folder: only folder tables can be replaced")));
    }
    let mut files = match Location::parse(path)? {
        Location::Local(root) => {
            let mut files = vec![];
            let mut pending = vec![root];
            while let Some(dir) = pending.pop() {
                let Ok(entries) = std::fs::read_dir(&dir) else { continue };
                for entry in entries {
                    let entry = entry?;
                    let p = entry.path();
                    if entry.file_type()?.is_dir() {
                        pending.push(p);
                    } else if !is_temporary(&entry.file_name().to_string_lossy()) {
                        files.push(p.display().to_string());
                    }
                }
            }
            files
        }
        Location::Object(url) => object::remove::list_under(&url, storage)?
            .into_iter()
            .filter(|u| !is_temporary(u.key.rsplit('/').next().unwrap_or("")))
            .map(|u| u.to_string())
            .collect(),
    };
    files.sort();
    Ok(files)
}

/// Delete these files (paths or URLs, as [`list_files`] gives them); one that
/// is already gone is no error. Stops at the first failure.
pub fn remove_files(files: &[String], storage: &StorageOptions) -> Result<()> {
    let mut objects: Vec<ObjectUrl> = vec![];
    for f in files {
        match Location::parse(f)? {
            Location::Local(p) => match std::fs::remove_file(&p) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
                _ => {}
            },
            Location::Object(url) => objects.push(url),
        }
    }
    object::remove::remove_objects(&objects, storage)
}

/// Remove the empty folders below a local folder (not the folder itself): what
/// deleting the files of a partitioned table leaves. Objects have no folders.
pub fn prune_empty_dirs(path: &str) {
    if let Ok(Location::Local(root)) = Location::parse(path) {
        fn prune(dir: &std::path::Path) {
            let Ok(entries) = std::fs::read_dir(dir) else { return };
            for e in entries.flatten() {
                if e.file_type().is_ok_and(|t| t.is_dir()) {
                    prune(&e.path());
                    // fails (and so keeps the folder) unless it is empty
                    let _ = std::fs::remove_dir(e.path());
                }
            }
        }
        prune(&root);
    }
}
