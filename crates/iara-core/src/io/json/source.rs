//! The parallel JSON scan: NDJSON morsels parse the lines that start in their
//! byte range; an array file is one morsel.

use arrow::datatypes::{Schema, SchemaRef};
use arrow::record_batch::{RecordBatch, RecordBatchOptions};

use super::build::BatchBuilder;
use super::JsonNested;
use super::infer::infer_schema;
use super::parse::{Member, Parser};
use crate::error::Result;
use crate::exec::pipeline::{Emit, Source};
use crate::io::csv::ranges::RangedLines;
use crate::io::parquet::batch_size;

const BOM: &[u8] = b"\xEF\xBB\xBF";

fn without_bom(b: &[u8]) -> &[u8] {
    b.strip_prefix(BOM).unwrap_or(b)
}

/// The non-blank lines of NDJSON text.
fn records(b: &[u8]) -> impl Iterator<Item = &[u8]> {
    b.split(|&c| c == b'\n').filter(|l| !l.iter().all(u8::is_ascii_whitespace))
}

/// The source text of the elements of the array in `b`, at most `max`. When
/// the text is cut short (`truncated`), a broken last element is dropped.
fn array_elements(b: &[u8], max: usize, truncated: bool) -> Result<Vec<&[u8]>> {
    let mut p = Parser::new(b);
    let mut out = vec![];
    let mut more = p.array_open()?;
    while more && out.len() < max {
        match p.skip_value() {
            Ok(s) => out.push(s.as_bytes()),
            Err(_) if truncated => break,
            Err(e) => return Err(e),
        }
        more = match p.array_next() {
            Ok(m) => m,
            Err(_) if truncated => break,
            Err(e) => return Err(e),
        };
    }
    Ok(out)
}

/// The schema of a file's first `max_rows` records.
pub fn infer_file(sample: &[u8], array: bool, truncated: bool, max_rows: usize, nested: JsonNested) -> Result<Schema> {
    let sample = without_bom(sample);
    if array {
        return infer_schema(array_elements(sample, max_rows, truncated)?.into_iter(), max_rows, nested);
    }
    infer_schema(records(sample), max_rows, nested)
}

pub struct JsonSource {
    out_schema: SchemaRef,
    ranges: RangedLines,
    arrays: Vec<bool>,
}

impl JsonSource {
    pub fn new(out_schema: SchemaRef, ranges: RangedLines, arrays: Vec<bool>) -> Self {
        Self { out_schema, ranges, arrays }
    }

    fn empty_batch(&self, rows: usize) -> Result<RecordBatch> {
        let opts = RecordBatchOptions::new().with_row_count(Some(rows));
        Ok(RecordBatch::try_new_with_options(self.out_schema.clone(), vec![], &opts)?)
    }

    fn ndjson(&self, data: &[u8], emit: Emit<'_>) -> Result<()> {
        if self.out_schema.fields().is_empty() {
            // only the number of rows is wanted
            return emit(self.empty_batch(records(data).count())?);
        }
        let mut batch = BatchBuilder::new(self.out_schema.clone())?;
        let mut members: Vec<Member> = vec![];
        // all of it checked at once; invalid text is found again, with its place, string by string
        let utf8 = std::str::from_utf8(data).is_ok();
        for line in records(data) {
            let mut p = Parser::utf8(line, utf8);
            p.object(&mut members).map_err(|e| with_hint(e, line))?;
            if !p.at_end() {
                return Err(with_hint(crate::error::WhError::Execution("invalid JSON: text after the object".into()), line));
            }
            batch.push(&members)?;
            if batch.len() >= batch_size() {
                emit(batch.finish()?)?;
            }
        }
        if !batch.is_empty() {
            emit(batch.finish()?)?;
        }
        Ok(())
    }

    fn array(&self, data: &[u8], emit: Emit<'_>) -> Result<()> {
        let mut batch = BatchBuilder::new(self.out_schema.clone())?;
        let mut members: Vec<Member> = vec![];
        let mut p = Parser::utf8(data, std::str::from_utf8(data).is_ok());
        let mut more = p.array_open()?;
        let mut rows = 0;
        while more {
            p.object(&mut members)?;
            rows += 1;
            if !self.out_schema.fields().is_empty() {
                batch.push(&members)?;
                if batch.len() >= batch_size() {
                    emit(batch.finish()?)?;
                }
            }
            more = p.array_next()?;
        }
        if self.out_schema.fields().is_empty() {
            return emit(self.empty_batch(rows)?);
        }
        if !batch.is_empty() {
            emit(batch.finish()?)?;
        }
        Ok(())
    }
}

/// Say what the line was when it is not an NDJSON record.
fn with_hint(e: crate::error::WhError, line: &[u8]) -> crate::error::WhError {
    let head: String = String::from_utf8_lossy(&line[..line.len().min(60)]).into_owned();
    crate::error::WhError::Execution(format!("{e}; in the record starting {head:?} (NDJSON needs one whole object per line; use format='array' for a JSON array)"))
}

impl Source for JsonSource {
    fn num_morsels(&self) -> usize {
        self.ranges.len()
    }
    fn run_morsel(&self, morsel: usize, emit: Emit<'_>) -> Result<()> {
        let (slice, begin) = self.ranges.lines(morsel)?;
        if slice.is_empty() {
            return Ok(());
        }
        let data = if begin == 0 { without_bom(&slice) } else { &slice[..] };
        if self.arrays[self.ranges.file(morsel)] { self.array(data, emit) } else { self.ndjson(data, emit) }
    }
    fn schema(&self) -> SchemaRef {
        self.out_schema.clone()
    }
    fn describe(&self) -> String {
        format!("JsonScan[files={}, morsels={}]", self.ranges.file_count(), self.ranges.len())
    }
}
