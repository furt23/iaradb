//! Decoding (part of) one row group from the bytes fetched for it.

use std::ops::Range;

use arrow::datatypes::SchemaRef;
use arrow::record_batch::RecordBatch;
use parquet::arrow::ProjectionMask;
use parquet::arrow::arrow_reader::{ArrowReaderMetadata, ParquetRecordBatchReaderBuilder, RowSelection, RowSelector};

use super::batch_size;
use crate::error::Result;
use crate::exec::pipeline::Emit;
use crate::io::blob::RangeChunks;

/// Byte ranges of the column chunks `mask` selects in one row group: all a
/// decoder of that row group reads.
pub fn chunk_ranges(meta: &ArrowReaderMetadata, row_group: usize, mask: &ProjectionMask) -> Vec<Range<u64>> {
    let rg = meta.metadata().row_group(row_group);
    (0..rg.num_columns())
        .filter(|&c| mask.leaf_included(c))
        .map(|c| {
            let (start, len) = rg.column(c).byte_range();
            start..start + len
        })
        .collect()
}

pub fn reader(input: RangeChunks, meta: &ArrowReaderMetadata, mask: ProjectionMask, row_group: usize) -> ParquetRecordBatchReaderBuilder<RangeChunks> {
    ParquetRecordBatchReaderBuilder::new_with_metadata(input, meta.clone())
        .with_projection(mask)
        .with_row_groups(vec![row_group])
}

pub struct Part<'a> {
    pub meta: &'a ArrowReaderMetadata,
    pub row_group: usize,
    /// (first row, row count) inside the row group
    pub rows: Option<(usize, usize)>,
    pub limit: Option<usize>,
    /// output schema (batches are re-labelled when only metadata differs)
    pub schema: &'a SchemaRef,
}

pub fn decode(input: RangeChunks, mask: ProjectionMask, part: &Part<'_>, emit: Emit<'_>) -> Result<()> {
    let mut builder = reader(input, part.meta, mask, part.row_group).with_batch_size(batch_size());
    if let Some((start, len)) = part.rows {
        let mut sel = vec![];
        if start > 0 {
            sel.push(RowSelector::skip(start));
        }
        sel.push(RowSelector::select(len));
        builder = builder.with_row_selection(RowSelection::from(sel));
    }
    if let Some(limit) = part.limit {
        builder = builder.with_limit(limit);
    }
    for b in builder.build()? {
        let b = b?;
        if b.schema().fields() != part.schema.fields() {
            // normalise schema metadata differences
            emit(RecordBatch::try_new(part.schema.clone(), b.columns().to_vec())?)?;
        } else {
            emit(b)?;
        }
    }
    Ok(())
}
