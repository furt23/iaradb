//! Late materialization over plain Parquet tables: a scan that also emits
//! each row's position (its file and row number), and the reading of other
//! columns for given positions. `SELECT * ... WHERE ... ORDER BY x LIMIT k`
//! then filters and sorts on the few columns it needs and decodes the other
//! columns of the k winning rows only (see [`crate::physical::late`]).

use std::collections::BTreeMap;
use std::sync::Arc;

use arrow::array::{Array, ArrayRef, AsArray, UInt64Array};
use arrow::compute::interleave;
use arrow::datatypes::{DataType, Field, Int64Type, Schema, SchemaRef};
use arrow::record_batch::{RecordBatch, RecordBatchOptions};
use parquet::arrow::ProjectionMask;
use parquet::arrow::arrow_reader::{RowSelection, RowSelector};
use rayon::prelude::*;

use super::decode::{chunk_ranges, reader};
use super::file::ParquetFile;
use super::source::{ParquetSource, ScanRequest};
use crate::error::Result;
use crate::exec::pipeline::{Emit, Source};
use crate::expr::Expr;
use crate::io::{LateRows, ScanBound};

/// A position is `file << FILE_SHIFT | row in the file`.
const FILE_SHIFT: u32 = 40;
const ROW_MASK: u64 = (1 << FILE_SHIFT) - 1;
pub const POSITION_COLUMN: &str = "__position";

/// First row of every row group, per file.
fn row_group_starts(files: &[Arc<ParquetFile>]) -> Vec<Vec<u64>> {
    files
        .iter()
        .map(|f| {
            let mut at = 0u64;
            f.meta
                .metadata()
                .row_groups()
                .iter()
                .map(|rg| {
                    let s = at;
                    at += rg.num_rows() as u64;
                    s
                })
                .collect()
        })
        .collect()
}

/// The files of a plain Parquet table (no partition columns, no per-file
/// column mapping), for late materialization.
pub struct ParquetRows {
    files: Vec<Arc<ParquetFile>>,
    table_schema: SchemaRef,
    starts: Vec<Vec<u64>>,
}

impl ParquetRows {
    pub fn new(files: Vec<Arc<ParquetFile>>, table_schema: SchemaRef) -> Self {
        let starts = row_group_starts(&files);
        Self { files, table_schema, starts }
    }
}

impl LateRows for ParquetRows {
    fn positioned_source(&self, projection: &[usize], filters: &[Expr], bound: Option<&ScanBound>) -> Result<Arc<dyn Source>> {
        let req = ScanRequest {
            files: &self.files,
            table_schema: &self.table_schema,
            projection: projection.to_vec(),
            filters,
            fetch: None,
            conform: false,
            row_numbers: true,
            bound,
            joins: &[],
        };
        let inner = ParquetSource::try_new(req)?;
        // the row numbers become positions
        let mut fields = inner.schema().fields().to_vec();
        *fields.last_mut().expect("row numbers") = Arc::new(Field::new(POSITION_COLUMN, DataType::UInt64, false));
        let schema = Arc::new(Schema::new(fields));
        Ok(Arc::new(PositionedSource { inner, schema }))
    }

    fn fetch(&self, projection: &[usize], positions: &[u64]) -> Result<RecordBatch> {
        let schema = Arc::new(self.table_schema.project(projection)?);
        // rows to read per (file, row group), each sorted
        let mut groups: BTreeMap<(usize, usize), Vec<u64>> = BTreeMap::new();
        for &p in positions {
            let (f, row) = ((p >> FILE_SHIFT) as usize, p & ROW_MASK);
            let rg = self.starts[f].partition_point(|&s| s <= row) - 1;
            groups.entry((f, rg)).or_default().push(row - self.starts[f][rg]);
        }
        let groups: Vec<((usize, usize), Vec<u64>)> = groups
            .into_iter()
            .map(|(k, mut rows)| {
                rows.sort_unstable();
                rows.dedup();
                (k, rows)
            })
            .collect();
        let batches = groups
            .par_iter()
            .map(|((f, rg), rows)| read_rows(&self.files[*f], *rg, rows, projection, &schema))
            .collect::<Result<Vec<_>>>()?;
        let index: Vec<(usize, usize)> = positions
            .iter()
            .map(|&p| {
                let (f, row) = ((p >> FILE_SHIFT) as usize, p & ROW_MASK);
                let rg = self.starts[f].partition_point(|&s| s <= row) - 1;
                let g = groups.binary_search_by(|(k, _)| k.cmp(&(f, rg))).expect("grouped");
                let r = groups[g].1.binary_search(&(row - self.starts[f][rg])).expect("read");
                (g, r)
            })
            .collect();
        let cols = (0..projection.len())
            .map(|c| {
                let arrays: Vec<&dyn Array> = batches.iter().map(|b| b.column(c).as_ref()).collect();
                interleave(&arrays, &index)
            })
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(RecordBatch::try_new_with_options(schema, cols, &RecordBatchOptions::new().with_row_count(Some(positions.len())))?)
    }
}

/// Rows `rows` (sorted) of one row group, columns `projection`.
fn read_rows(file: &ParquetFile, rg: usize, rows: &[u64], projection: &[usize], schema: &SchemaRef) -> Result<RecordBatch> {
    let mask = ProjectionMask::roots(file.meta.parquet_schema(), projection.iter().copied());
    let input = file.blob.read(&chunk_ranges(&file.meta, rg, &mask), None)?;
    let mut sel = vec![];
    let mut at = 0u64;
    for &r in rows {
        if r > at {
            sel.push(RowSelector::skip((r - at) as usize));
        }
        sel.push(RowSelector::select(1));
        at = r + 1;
    }
    let decoded = reader(input, &file.meta, mask, rg).with_batch_size(rows.len().max(1)).with_row_selection(RowSelection::from(sel)).build()?;
    let mut parts = vec![];
    for b in decoded {
        let b = b?;
        let cols = b
            .columns()
            .iter()
            .zip(schema.fields())
            .map(|(c, f)| if c.data_type() == f.data_type() { Ok(c.clone()) } else { crate::nested::canonical_array(c) })
            .collect::<Result<Vec<ArrayRef>>>()?;
        parts.push(RecordBatch::try_new_with_options(schema.clone(), cols, &RecordBatchOptions::new().with_row_count(Some(b.num_rows())))?);
    }
    Ok(arrow::compute::concat_batches(schema, &parts)?)
}

/// A Parquet scan emitting each row's position as a last column: its file
/// and its number in the file, as the decoder numbers it (rows filtered
/// while decoding keep their numbers).
struct PositionedSource {
    inner: ParquetSource,
    schema: SchemaRef,
}

impl Source for PositionedSource {
    fn num_morsels(&self) -> usize {
        self.inner.num_morsels()
    }

    fn run_morsel(&self, morsel: usize, emit: Emit<'_>) -> Result<()> {
        let file = (self.inner.morsel_file(morsel) as u64) << FILE_SHIFT;
        self.inner.run_morsel(morsel, &mut |b| {
            let mut cols = b.columns().to_vec();
            let rows = cols.pop().expect("row numbers");
            let rows = rows.as_primitive::<Int64Type>().values();
            cols.push(Arc::new(UInt64Array::from_iter_values(rows.iter().map(|&r| file | r as u64))));
            emit(RecordBatch::try_new_with_options(self.schema.clone(), cols, &RecordBatchOptions::new().with_row_count(Some(b.num_rows())))?)
        })
    }

    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }

    fn describe(&self) -> String {
        format!("Positioned{}", self.inner.describe())
    }
}
