//! The files of a Parquet table.
//!
//! Most tables open every file when they are created (its footer, for a
//! remote file). A remote table in Hive-style partition folders
//! (`year=2024/...`) opens only its first file, for the schema; the others
//! when a scan needs them or statistics ask for all. Files that partition
//! filters skip then never cost a footer request.

use std::sync::{Arc, OnceLock};

use arrow::datatypes::Schema;

use super::file::{self, ParquetFile};
use crate::error::{Result, WhError};
use crate::io::DataFile;
use crate::io::object::ObjectFile;
use crate::io::partition;

struct Entry {
    /// path or URL
    name: String,
    /// listed size (bytes)
    size: u64,
    /// where to open it (`None`: a file that is open already)
    source: Option<DataFile>,
    file: OnceLock<Arc<ParquetFile>>,
}

pub struct TableFiles {
    /// shared with the scans that open the files themselves
    entries: Arc<Vec<Entry>>,
    /// the first file, whose schema the others must match
    first: Arc<ParquetFile>,
    /// files may differ from each other (a Delta table: the scan projects
    /// each onto the table's columns), so they are not compared
    conform: bool,
}

impl std::fmt::Debug for TableFiles {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "TableFiles({} files, {} open)", self.entries.len(), self.opened().len())
    }
}

/// Whether the listed files should open lazily: remote, several, and in
/// partition folders.
fn wants_lazy(pattern: &str, listed: &[DataFile]) -> bool {
    let remote = listed.iter().all(|f| matches!(f, DataFile::Object(_)));
    if !remote || listed.len() < 2 {
        return false;
    }
    let names: Vec<String> = listed.iter().map(|f| f.name()).collect();
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    matches!(partition::detect(pattern, &names, &Schema::empty()), Ok(Some(_)))
}

impl TableFiles {
    /// Open the `listed` files of the table `pattern` (all of them, or just the first).
    pub fn open(pattern: &str, listed: Vec<DataFile>) -> Result<Self> {
        if !wants_lazy(pattern, &listed) {
            return Self::eager(file::open_files(listed)?);
        }
        let objects: Vec<ObjectFile> = listed.into_iter().filter_map(|f| if let DataFile::Object(o) = f { Some(o) } else { None }).collect();
        let first = file::open_files(vec![DataFile::Object(objects[0].clone())])?.remove(0);
        let entries = objects
            .into_iter()
            .enumerate()
            .map(|(i, o)| Entry {
                name: o.url.to_string(),
                size: o.size,
                source: Some(DataFile::Object(o)),
                file: if i == 0 { OnceLock::from(first.clone()) } else { OnceLock::new() },
            })
            .collect::<Vec<_>>();
        Ok(Self { entries: Arc::new(entries), first, conform: false })
    }

    /// The `listed` files (with their sizes), only the first opened now: a file whose footer
    /// no scan needs is never read. The files need not share a schema.
    pub fn listed(listed: Vec<(DataFile, u64)>) -> Result<Self> {
        let first = file::open_files(vec![listed[0].0.clone()])?.remove(0);
        let entries = listed
            .into_iter()
            .enumerate()
            .map(|(i, (f, size))| Entry {
                name: f.name(),
                size,
                source: Some(f),
                file: if i == 0 { OnceLock::from(first.clone()) } else { OnceLock::new() },
            })
            .collect::<Vec<_>>();
        Ok(Self { entries: Arc::new(entries), first, conform: true })
    }

    /// Files opened already, in order; they must share one schema.
    fn eager(files: Vec<Arc<ParquetFile>>) -> Result<Self> {
        let first = files[0].clone();
        for f in &files[1..] {
            check_schema(&first, f)?;
        }
        let entries: Vec<Entry> = files.into_iter().map(|f| Entry { name: f.name.clone(), size: f.blob.len(), source: None, file: OnceLock::from(f) }).collect();
        Ok(Self { entries: Arc::new(entries), first, conform: false })
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn first(&self) -> &Arc<ParquetFile> {
        &self.first
    }

    /// Paths or URLs of every file, open or not.
    pub fn names(&self) -> Vec<&str> {
        self.entries.iter().map(|e| e.name.as_str()).collect()
    }

    /// The files open so far, in order.
    pub fn opened(&self) -> Vec<Arc<ParquetFile>> {
        self.entries.iter().filter_map(|e| e.file.get().cloned()).collect()
    }

    pub fn all_opened(&self) -> bool {
        self.entries.iter().all(|e| e.file.get().is_some())
    }

    /// Every file, opening the missing ones.
    pub fn all(&self) -> Result<Vec<Arc<ParquetFile>>> {
        self.select(&vec![true; self.entries.len()])
    }

    /// The files marked in `keep`, opening the missing ones (concurrently).
    pub fn select(&self, keep: &[bool]) -> Result<Vec<Arc<ParquetFile>>> {
        let missing: Vec<usize> = (0..self.entries.len()).filter(|&i| keep[i] && self.entries[i].file.get().is_none()).collect();
        if !missing.is_empty() {
            let sources = missing.iter().map(|&i| self.entries[i].source.clone().expect("a file that is not open has a source"));
            let opened = file::open_files(sources.collect())?;
            for (&i, f) in missing.iter().zip(opened) {
                if !self.conform {
                    check_schema(&self.first, &f)?;
                }
                let _ = self.entries[i].file.set(f);
            }
        }
        Ok(self.entries.iter().zip(keep).filter(|(_, k)| **k).filter_map(|(e, _)| e.file.get().cloned()).collect())
    }

    /// The list of the files, for a scan that opens them itself. `None`: a table whose
    /// files are open already.
    pub fn list(&self) -> Option<FileList> {
        self.conform.then(|| FileList(self.entries.clone()))
    }

    /// Listed size of a file.
    pub fn size(&self, i: usize) -> u64 {
        self.entries[i].size
    }

    /// Rows of the table: exact once every file is open, else estimated from
    /// the first file and the listed sizes.
    pub fn rows(&self) -> usize {
        let rows = |f: &Arc<ParquetFile>| f.meta.metadata().file_metadata().num_rows() as usize;
        if self.all_opened() {
            return self.entries.iter().filter_map(|e| e.file.get()).map(rows).sum();
        }
        let total: u64 = self.entries.iter().map(|e| e.size).sum();
        let per_byte = rows(&self.first) as f64 / self.first.blob.len().max(1) as f64;
        (per_byte * total as f64).round() as usize
    }
}

/// The files of a table that lists them (each has a place to open it from).
#[derive(Clone)]
pub struct FileList(Arc<Vec<Entry>>);

impl FileList {
    pub fn source(&self, i: usize) -> &DataFile {
        self.0[i].source.as_ref().expect("a listed file has a source")
    }

    /// Path or URL.
    pub fn name(&self, i: usize) -> &str {
        &self.0[i].name
    }

    pub fn size(&self, i: usize) -> u64 {
        self.0[i].size
    }
}

/// The file must have the table's columns.
fn check_schema(first: &ParquetFile, f: &ParquetFile) -> Result<()> {
    let (a, b) = (first.meta.schema(), f.meta.schema());
    let same = a.fields().len() == b.fields().len() && a.fields().iter().zip(b.fields()).all(|(x, y)| x.name() == y.name() && crate::nested::canonical_type(x.data_type()) == crate::nested::canonical_type(y.data_type()));
    if same { Ok(()) } else { Err(WhError::Plan(format!("schema of {} differs from {}", f.name, first.name))) }
}
