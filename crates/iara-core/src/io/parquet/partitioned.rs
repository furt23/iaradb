//! A Parquet scan over partitioned files: the files' columns come from the
//! scan, the partition columns are constants per file.

use arrow::array::ArrayRef;
use arrow::datatypes::SchemaRef;
use arrow::record_batch::{RecordBatch, RecordBatchOptions};

use super::source::ParquetSource;
use crate::error::Result;
use crate::exec::pipeline::{Emit, Source};
use crate::io::partition::Partitions;
use crate::scalar::Scalar;

/// Where an output column comes from.
#[derive(Debug, Clone, Copy)]
pub enum Col {
    /// the scan's k-th column
    File(usize),
    /// the j-th partition column
    Part(usize),
}

pub struct PartitionedSource {
    pub inner: ParquetSource,
    /// partition values of the scanned files, one row per file
    pub partitions: Partitions,
    pub layout: Vec<Col>,
    pub schema: SchemaRef,
    /// files kept / files of the table
    pub files: (usize, usize),
}

impl Source for PartitionedSource {
    fn num_morsels(&self) -> usize {
        self.inner.num_morsels()
    }

    fn run_morsel(&self, morsel: usize, emit: Emit<'_>) -> Result<()> {
        let file = self.inner.morsel_file(morsel);
        let values = self.partitions.values.columns();
        self.inner.run_morsel(morsel, &mut |b: RecordBatch| {
            let n = b.num_rows();
            let columns = self
                .layout
                .iter()
                .map(|c| match *c {
                    Col::File(k) => Ok(b.column(k).clone()),
                    Col::Part(j) => Scalar::from_array(values[j].as_ref(), file)?.to_array(n),
                })
                .collect::<Result<Vec<ArrayRef>>>()?;
            let opts = RecordBatchOptions::new().with_row_count(Some(n));
            emit(RecordBatch::try_new_with_options(self.schema.clone(), columns, &opts)?)
        })
    }

    fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }

    fn describe(&self) -> String {
        format!("{}[partitions={}/{}]", self.inner.describe(), self.files.0, self.files.1)
    }
}

/// The scan's layout for a projection over `file_columns` file columns then
/// the partition columns: (the files' projection, where each output comes from).
pub fn split_projection(projection: &[usize], file_columns: usize) -> (Vec<usize>, Vec<Col>) {
    let mut files = vec![];
    let layout = projection
        .iter()
        .map(|&i| {
            if i < file_columns {
                files.push(i);
                Col::File(files.len() - 1)
            } else {
                Col::Part(i - file_columns)
            }
        })
        .collect();
    (files, layout)
}
