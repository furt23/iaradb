//! The bytes of a data file: a memory-mapped local file, or an object read
//! by ranges. Readers see either through [`RangeChunks`], a sparse view of
//! a file holding just the byte ranges fetched for it.

use std::ops::Range;
use std::path::{Path, PathBuf};

use bytes::{Buf, Bytes};
use parquet::errors::ParquetError;
use parquet::file::reader::{ChunkReader, Length};

use crate::error::Result;
use crate::exec::query::QueryHandle;
use crate::io::object::ObjectFile;

/// A file named by a table's path or URL.
#[derive(Debug, Clone)]
pub enum DataFile {
    Local(PathBuf),
    Object(ObjectFile),
}

impl DataFile {
    /// Path or URL, for messages and listings.
    pub fn name(&self) -> String {
        match self {
            DataFile::Local(p) => p.display().to_string(),
            DataFile::Object(o) => o.url.to_string(),
        }
    }

    pub fn size(&self) -> Result<u64> {
        Ok(match self {
            DataFile::Local(p) => std::fs::metadata(p)?.len(),
            DataFile::Object(o) => o.size,
        })
    }
}

/// The bytes of a data file: mapped (local) or fetched on demand (remote).
pub enum Blob {
    Mapped(Bytes),
    Object(ObjectFile),
}

impl Blob {
    pub fn open(file: DataFile) -> Result<Blob> {
        Ok(match file {
            DataFile::Local(p) => Blob::Mapped(map_local(&p)?),
            DataFile::Object(o) => Blob::Object(o),
        })
    }

    pub fn len(&self) -> u64 {
        match self {
            Blob::Mapped(b) => b.len() as u64,
            Blob::Object(o) => o.size,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    pub fn object(&self) -> Option<&ObjectFile> {
        match self {
            Blob::Object(o) => Some(o),
            Blob::Mapped(_) => None,
        }
    }

    pub fn read_range(&self, range: Range<u64>, cancel: Option<&QueryHandle>) -> Result<Bytes> {
        match self {
            Blob::Mapped(b) => Ok(b.slice(range.start as usize..range.end as usize)),
            Blob::Object(o) => o.read_range(range, cancel),
        }
    }

    /// The bytes of `ranges` (a mapped file serves all of itself).
    pub fn read(&self, ranges: &[Range<u64>], cancel: Option<&QueryHandle>) -> Result<RangeChunks> {
        match self {
            Blob::Mapped(b) => Ok(RangeChunks::whole(b.clone())),
            Blob::Object(o) => {
                let bytes = o.read_ranges(ranges, cancel)?;
                Ok(RangeChunks::new(o.size, ranges.iter().map(|r| r.start).zip(bytes).collect()))
            }
        }
    }
}

/// Create the parent directory of a file about to be written.
pub fn create_parent(path: &Path) -> Result<()> {
    if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
        std::fs::create_dir_all(parent)?;
    }
    Ok(())
}

/// Memory-map a local file (zero copy; empty files map to empty bytes).
pub fn map_local(path: &Path) -> Result<Bytes> {
    let f = std::fs::File::open(path)?;
    if f.metadata()?.len() == 0 {
        return Ok(Bytes::new());
    }
    // SAFETY: read-only mapping; files are expected not to be truncated while scanned
    let m = unsafe { memmap2::Mmap::map(&f)? };
    Ok(Bytes::from_owner(m))
}

/// Some byte ranges of a file of length `len`, sorted by offset and not
/// overlapping. Reads must fall inside one range.
#[derive(Debug, Clone)]
pub struct RangeChunks {
    len: u64,
    ranges: Vec<(u64, Bytes)>,
}

impl RangeChunks {
    /// A whole file in memory.
    pub fn whole(data: Bytes) -> Self {
        Self { len: data.len() as u64, ranges: vec![(0, data)] }
    }

    pub fn new(len: u64, mut ranges: Vec<(u64, Bytes)>) -> Self {
        ranges.sort_by_key(|(o, _)| *o);
        Self { len, ranges }
    }

    /// Bytes held (not the file length).
    pub fn held(&self) -> usize {
        self.ranges.iter().map(|(_, b)| b.len()).sum()
    }

    /// The held bytes from `start` to the end of its range.
    fn tail(&self, start: u64) -> parquet::errors::Result<Bytes> {
        let i = self.ranges.partition_point(|(o, _)| *o <= start);
        if i > 0 {
            let (o, b) = &self.ranges[i - 1];
            if start - o <= b.len() as u64 {
                return Ok(b.slice((start - o) as usize..));
            }
        }
        Err(ParquetError::General(format!("byte {start} was not fetched")))
    }
}

impl Length for RangeChunks {
    fn len(&self) -> u64 {
        self.len
    }
}

impl ChunkReader for RangeChunks {
    type T = bytes::buf::Reader<Bytes>;

    fn get_read(&self, start: u64) -> parquet::errors::Result<Self::T> {
        Ok(self.tail(start)?.reader())
    }

    fn get_bytes(&self, start: u64, length: usize) -> parquet::errors::Result<Bytes> {
        let t = self.tail(start)?;
        if t.len() < length {
            return Err(ParquetError::General(format!("bytes {start}..{} were not fetched", start + length as u64)));
        }
        Ok(t.slice(..length))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_inside_fetched_ranges_only() {
        let r = RangeChunks::new(100, vec![(50, Bytes::from_static(b"0123456789")), (10, Bytes::from_static(b"abcde"))]);
        assert_eq!(r.get_bytes(12, 3).unwrap(), Bytes::from_static(b"cde"));
        assert_eq!(r.get_bytes(55, 5).unwrap(), Bytes::from_static(b"56789"));
        assert!(r.get_bytes(55, 6).is_err());
        assert!(r.get_bytes(0, 1).is_err());
        assert!(r.get_bytes(30, 1).is_err());
        assert_eq!(r.len(), 100);
        assert_eq!(r.held(), 15);
    }
}
