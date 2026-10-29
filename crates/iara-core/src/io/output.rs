//! Where written data goes: a local file or an object (multipart upload).
//!
//! Writes are all-or-nothing. A local file is written under a temporary name
//! beside its destination and renamed into place by [`Output::finish`]; an
//! object only appears when its multipart upload completes. An `Output`
//! dropped without finishing removes its temporary file (aborts its upload),
//! so a failed write leaves nothing behind and keeps what was there before.

use std::fs::File;
use std::io::{BufWriter, Read, Write};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use parquet::file::metadata::ParquetMetaData;

use crate::error::{Result, WhError};
use crate::io::blob::create_parent;
use crate::io::location::Location;
use crate::io::object::write::ObjectWriter;
use crate::io::options::StorageOptions;

/// A file a sink wrote, as it stands after the write succeeded.
#[derive(Debug, Clone)]
pub struct WrittenFile {
    /// the path or URL of the file, in the form it was asked for
    pub path: String,
    /// bytes in the file
    pub size: u64,
    pub rows: u64,
    /// the Hive partition (`column`, value; None = null) the file belongs to
    pub partition_values: Vec<(String, Option<String>)>,
    /// the Parquet footer (row group and column statistics), for Parquet files
    pub metadata: Option<Arc<ParquetMetaData>>,
}

/// A name part no other writer of this process (or, very likely, of another) uses.
pub fn unique_id() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
    format!("{nanos:x}-{}-{}", std::process::id(), COUNTER.fetch_add(1, Ordering::Relaxed))
}

/// A local file written as `<name>.tmp-<id>` and renamed to its name when committed.
pub struct LocalFile {
    file: Option<BufWriter<File>>,
    tmp: PathBuf,
    dest: PathBuf,
    committed: bool,
}

impl LocalFile {
    fn create(dest: PathBuf) -> Result<Self> {
        create_parent(&dest)?;
        let name = dest.file_name().ok_or_else(|| WhError::Plan(format!("'{}' is not a file path", dest.display())))?;
        let tmp = dest.with_file_name(format!("{}.tmp-{}", name.to_string_lossy(), unique_id()));
        let file = BufWriter::with_capacity(1 << 20, File::create(&tmp)?);
        Ok(Self { file: Some(file), tmp, dest, committed: false })
    }

    fn commit(&mut self) -> Result<()> {
        if self.committed {
            return Ok(());
        }
        let mut file = self.file.take().ok_or_else(|| WhError::Execution("file already closed".into()))?;
        file.flush()?;
        drop(file);
        // replaces an existing file (on Windows too, unless something holds it open)
        std::fs::rename(&self.tmp, &self.dest)?;
        self.committed = true;
        Ok(())
    }
}

impl Drop for LocalFile {
    fn drop(&mut self) {
        if self.committed {
            return;
        }
        // close the file (without flushing its buffer) before deleting it
        if let Some(f) = self.file.take() {
            drop(f.into_parts());
        }
        let _ = std::fs::remove_file(&self.tmp);
    }
}

enum Target {
    File(LocalFile),
    Object(ObjectWriter),
}

pub struct Output {
    target: Target,
    bytes: u64,
}

impl Output {
    /// Create (or replace) `path`: a local path or an object store URL. The
    /// file is there under its name only once [`Output::finish`] succeeds.
    pub fn create(path: &str, storage: &StorageOptions) -> Result<Self> {
        let target = match Location::parse(path)? {
            Location::Local(p) => Target::File(LocalFile::create(p)?),
            Location::Object(url) => Target::Object(ObjectWriter::create(&url, storage)?),
        };
        Ok(Self { target, bytes: 0 })
    }

    /// Flush a file and move it into place, complete an upload; returns the bytes written.
    pub fn finish(mut self) -> Result<u64> {
        self.commit()
    }

    /// [`Output::finish`] for an output that cannot be moved (inside a Parquet writer).
    pub fn commit(&mut self) -> Result<u64> {
        match &mut self.target {
            Target::File(f) => f.commit()?,
            Target::Object(o) => o.commit()?,
        }
        Ok(self.bytes)
    }
}

impl Write for Output {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let n = match &mut self.target {
            Target::File(f) => f.file.as_mut().ok_or_else(|| std::io::Error::other("file closed"))?.write(buf)?,
            Target::Object(o) => o.write(buf)?,
        };
        self.bytes += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match &mut self.target {
            Target::File(f) => f.file.as_mut().map_or(Ok(()), |w| w.flush()),
            Target::Object(o) => o.flush(),
        }
    }
}

/// Copy the local file `src` to `path` (a local path or an object store URL)
/// as one all-or-nothing write; returns the bytes copied.
pub fn copy_file(src: &str, path: &str, storage: &StorageOptions) -> Result<u64> {
    let mut input = File::open(src)?;
    let mut out = Output::create(path, storage)?;
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = input.read(&mut buf)?;
        if n == 0 {
            return out.finish();
        }
        out.write_all(&buf[..n])?;
    }
}
