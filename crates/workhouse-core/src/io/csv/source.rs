//! The parallel CSV scan over byte ranges: each morsel parses the lines
//! that start inside its range. Remote ranges are fetched with a margin past
//! their end (prefetched ahead of the workers), extended when the last line
//! runs longer.

use std::io::Cursor;
use std::sync::Arc;

use arrow::csv::ReaderBuilder;
use arrow::datatypes::SchemaRef;
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use bytes::{Bytes, BytesMut};
use parquet::file::reader::ChunkReader;

use super::CsvOptions;
use super::lines::line_start;
use crate::error::Result;
use crate::exec::pipeline::{Emit, Source};
use crate::exec::query::QueryHandle;
use crate::io::blob::Blob;
use crate::io::object::prefetch::{self, FetchJob, Prefetcher};
use crate::io::parquet::batch_size;

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

pub struct CsvSource {
    pub files: Arc<Vec<Blob>>,
    pub schema: SchemaRef,
    pub out_schema: SchemaRef,
    pub projection: Option<Vec<usize>>,
    pub ranges: Vec<ByteRange>,
    pub options: CsvOptions,
    prefetch: Option<Prefetcher>,
    cancel: Option<Arc<QueryHandle>>,
}

impl CsvSource {
    pub fn new(files: Arc<Vec<Blob>>, schema: SchemaRef, projection: Option<Vec<usize>>, ranges: Vec<ByteRange>, options: CsvOptions) -> Result<Self> {
        let out_schema = match &projection {
            Some(p) => Arc::new(schema.project(p)?),
            None => schema.clone(),
        };
        let prefetch = prefetcher(&files, &ranges);
        Ok(Self { files, schema, out_schema, projection, ranges, options, prefetch, cancel: crate::exec::query::current() })
    }

    /// The lines of morsel `i` (starting at file offset `.1`).
    fn lines(&self, i: usize) -> Result<(Bytes, usize)> {
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

    fn emit_batches(&self, slice: Bytes, at_file_start: bool, emit: Emit<'_>) -> Result<()> {
        let mut b = ReaderBuilder::new(self.schema.clone())
            .with_header(self.options.has_header && at_file_start)
            .with_delimiter(self.options.delimiter)
            .with_batch_size(batch_size());
        if let Some(p) = &self.projection {
            b = b.with_projection(p.clone());
        }
        for batch in b.build_buffered(Cursor::new(slice))? {
            let batch = batch?;
            if batch.num_columns() == 0 {
                let opts = RecordBatchOptions::new().with_row_count(Some(batch.num_rows()));
                emit(RecordBatch::try_new_with_options(self.out_schema.clone(), vec![], &opts)?)?;
            } else {
                emit(batch)?;
            }
        }
        Ok(())
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

impl Source for CsvSource {
    fn num_morsels(&self) -> usize {
        self.ranges.len()
    }
    fn run_morsel(&self, morsel: usize, emit: Emit<'_>) -> Result<()> {
        let (slice, begin) = self.lines(morsel)?;
        if slice.is_empty() {
            return Ok(());
        }
        self.emit_batches(slice, begin == 0, emit)
    }
    fn schema(&self) -> SchemaRef {
        self.out_schema.clone()
    }
    fn describe(&self) -> String {
        format!("CsvScan[files={}, morsels={}]", self.files.len(), self.ranges.len())
    }
}
