//! Reading a file whose columns differ from the table's (a Delta table whose
//! schema evolved): its columns are found by name, columns it lacks read as
//! NULL, columns it has extra are ignored.

use std::sync::Arc;

use arrow::array::{ArrayRef, new_null_array};
use arrow::datatypes::{Schema, SchemaRef};
use arrow::record_batch::{RecordBatch, RecordBatchOptions};

use super::file::ParquetFile;
use crate::error::Result;

/// How one file's columns make up a scan's columns.
pub struct FileColumns {
    /// the file's columns to read, ascending (the order a decoder returns them)
    pub read: Vec<usize>,
    /// for each scanned column, its position among the decoded ones (`None`: the file lacks it)
    at: Vec<Option<usize>>,
    /// the schema of the decoded columns
    pub decoded: SchemaRef,
}

impl FileColumns {
    /// `projection` indexes `table_schema`.
    pub fn new(file: &ParquetFile, table_schema: &Schema, projection: &[usize]) -> FileColumns {
        let schema = file.meta.schema();
        let found: Vec<Option<usize>> = projection.iter().map(|&c| schema.index_of(table_schema.field(c).name()).ok()).collect();
        let mut read: Vec<usize> = found.iter().flatten().copied().collect();
        read.sort_unstable();
        let at = found.iter().map(|f| f.and_then(|f| read.binary_search(&f).ok())).collect();
        let decoded = Arc::new(schema.project(&read).expect("indices of the file's own columns"));
        FileColumns { read, at, decoded }
    }

    /// The decoded batch as the scan's columns: absent ones NULL, types as the table's.
    pub fn adapt(&self, batch: RecordBatch, schema: &SchemaRef) -> Result<RecordBatch> {
        let rows = batch.num_rows();
        let columns = schema
            .fields()
            .iter()
            .zip(&self.at)
            .map(|(field, at)| -> Result<ArrayRef> {
                let Some(col) = at.map(|i| batch.column(i)) else { return Ok(new_null_array(field.data_type(), rows)) };
                if col.data_type() == field.data_type() {
                    return Ok(col.clone());
                }
                let col = crate::nested::canonical_array(col)?;
                Ok(if col.data_type() == field.data_type() { col } else { arrow::compute::cast(&col, field.data_type())? })
            })
            .collect::<Result<Vec<_>>>()?;
        let opts = RecordBatchOptions::new().with_row_count(Some(rows));
        Ok(RecordBatch::try_new_with_options(schema.clone(), columns, &opts)?)
    }
}
