//! Byte ranges of line-oriented files (CSV, NDJSON), cut at line boundaries
//! when read. Remote ranges are fetched with a margin past their end
//! (prefetched ahead of the workers), extended when the last line runs longer.

use std::sync::Arc;

use bytes::{Bytes, BytesMut};
use parquet::file::reader::ChunkReader;

use super::lines::line_start;
use crate::error::Result;
use crate::exec::query::QueryHandle;
use crate::io::blob::Blob;
use crate::io::object::prefetch::{self, FetchJob, Prefetcher};

/// Bytes fetched past a remote range's end to finish its last line (at
/// most; small ranges get a margin of their own size).
const MARGIN: usize = 1 << 20;

#[derive(Debug, Clone)]
pub struct ByteRange {
    pub file: usize,
    pub start: usize,
    pub end: usize,
}

impl ByteRange {
    /// The window fetched for a remote range: from the byte before it (to
    /// see whether a line starts at `start`) to a margin past its end.
    fn window(&self, file_len: usize) -> std::ops::Range<usize> {
        self.start.saturating_sub(1)..(self.end + self.margin()).min(file_len)
    }

    fn margin(&self) -> usize {
        (self.end - self.start).clamp(1, MARGIN)
    }
}

/// Split the files into ranges: one per file, or about `chunk_bytes` each
/// (by default enough ranges for every thread, 4 to 32 MiB locally and 8 to
/// 64 MiB remotely: every worker holds a range's rows while it parses them,
/// so a large file is cut finer, not into larger ranges). `starts[i]` is
/// where the data of file `i` begins.
pub fn plan(files: &[Blob], parallel: bool, chunk_bytes: Option<usize>, starts: &[usize]) -> Vec<ByteRange> {
    let threads = rayon::current_num_threads();
    let total: u64 = files.iter().map(|f| f.len()).sum();
    let remote = files.iter().any(|f| f.object().is_some());
    // remote ranges are larger: fewer requests, each worth its latency
    let (min, max) = if remote { (8 << 20, 64 << 20) } else { (4 << 20, 32 << 20) };
    let chunk = chunk_bytes.unwrap_or((total as usize / (threads * 4)).clamp(min, max)).max(1);
    let mut ranges = vec![];
    for (fi, f) in files.iter().enumerate() {
        let len = f.len() as usize;
        let mut start = starts.get(fi).copied().unwrap_or(0).min(len);
        if !parallel {
            ranges.push(ByteRange { file: fi, start, end: len });
            continue;
        }
        while start < len {
            let end = (start + chunk).min(len);
            ranges.push(ByteRange { file: fi, start, end });
            start = end;
        }
    }
    ranges
}

/// The first lines of a file: all of a mapped file, a prefix cut at a line
/// end for a remote one.
pub fn sample(file: &Blob, remote_bytes: u64) -> Result<Bytes> {
    let len = file.len();
    if let Blob::Mapped(b) = file {
        return Ok(b.clone());
    }
    let s = file.read_range(0..len.min(remote_bytes), None)?;
    if s.len() as u64 == len {
        return Ok(s);
    }
    let end = memchr::memrchr(b'\n', &s).map_or(s.len(), |i| i + 1);
    Ok(s.slice(..end))
}

/// Offset just past the first `n` lines of `d` (its end when it has fewer).
pub fn skip_lines(d: &[u8], n: usize) -> usize {
    let mut pos = 0;
    for _ in 0..n {
        match memchr::memchr(b'\n', &d[pos..]) {
            Some(i) => pos += i + 1,
            None => return d.len(),
        }
    }
    pos
}

/// The lines of each range of a set of files.
pub struct RangedLines {
    files: Arc<Vec<Blob>>,
    ranges: Vec<ByteRange>,
    starts: Vec<usize>,
    prefetch: Option<Prefetcher>,
    cancel: Option<Arc<QueryHandle>>,
}

impl RangedLines {
    pub fn new(files: Arc<Vec<Blob>>, ranges: Vec<ByteRange>, starts: Vec<usize>) -> Self {
        let prefetch = prefetcher(&files, &ranges);
        Self { files, ranges, starts, prefetch, cancel: crate::exec::query::current() }
    }

    pub fn len(&self) -> usize {
        self.ranges.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ranges.is_empty()
    }

    /// The file range `i` reads.
    pub fn file(&self, i: usize) -> usize {
        self.ranges[i].file
    }

    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    /// Whether `offset` is where the data of range `i`'s file begins.
    pub fn at_data_start(&self, i: usize, offset: usize) -> bool {
        offset == self.starts.get(self.ranges[i].file).copied().unwrap_or(0)
    }

    /// The lines of morsel `i` and the file offset they start at.
    pub fn lines(&self, i: usize) -> Result<(Bytes, usize)> {
        let r = &self.ranges[i];
        let blob = &self.files[r.file];
        let len = blob.len() as usize;
        if let Blob::Mapped(d) = blob {
            let begin = line_start(d, 0, r.start, len).expect("whole file");
            let end = line_start(d, 0, r.end, len).expect("whole file");
            return Ok((d.slice(begin..end.max(begin)), begin));
        }
        let w = r.window(len);
        let mut data = match &self.prefetch {
            Some(p) => p.take(i, self.cancel.as_deref())?.chunks.get_bytes(w.start as u64, w.len())?,
            None => blob.read_range(w.start as u64..w.end as u64, self.cancel.as_deref())?,
        };
        let base = w.start;
        loop {
            let stop = base + data.len();
            let begin = line_start(&data, base, r.start, len);
            match (begin, line_start(&data, base, r.end, len)) {
                (Some(b), Some(e)) => return Ok((data.slice(b - base..e.max(b) - base), b)),
                // no line starts in the range: it is inside a line begun earlier
                (None, _) if stop > r.end => return Ok((Bytes::new(), r.start)),
                _ => {
                    let next = (stop + data.len().max(r.margin())).min(len);
                    let more = blob.read_range(stop as u64..next as u64, self.cancel.as_deref())?;
                    let mut joined = BytesMut::from(&data[..]);
                    joined.extend_from_slice(&more);
                    data = joined.freeze();
                }
            }
        }
    }
}

fn prefetcher(files: &[Blob], ranges: &[ByteRange]) -> Option<Prefetcher> {
    let window = prefetch::window();
    if window == 0 || !files.iter().any(|f| f.object().is_some()) {
        return None;
    }
    let jobs = ranges.iter().map(|r| {
        let o = files[r.file].object()?;
        let w = r.window(o.size as usize);
        Some(FetchJob { file: o.clone(), ranges: vec![w.start as u64..w.end as u64] })
    });
    Some(Prefetcher::new(jobs.collect::<Option<Vec<_>>>()?, window))
}
