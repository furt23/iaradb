//! Spilling: data an operator cannot keep in memory goes to temporary Arrow
//! IPC files (LZ4-compressed), read back as a stream of batches.
//!
//! Files live in `IARA_SPILL_DIR` (default: the system temp folder) and
//! are deleted when their [`SpillFile`] is dropped.

use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use arrow::datatypes::SchemaRef;
use arrow::ipc::CompressionType;
use arrow::ipc::reader::StreamReader;
use arrow::ipc::writer::{IpcWriteOptions, StreamWriter};
use arrow::record_batch::RecordBatch;

use crate::error::{Result, WhError};

/// Bytes written to spill files by this process (for profiles and tests).
static SPILLED: AtomicU64 = AtomicU64::new(0);

pub fn spilled_bytes() -> u64 {
    SPILLED.load(Ordering::Relaxed)
}

pub fn spill_dir() -> PathBuf {
    let base = std::env::var_os("IARA_SPILL_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join("iara-spill")
}

fn new_path() -> Result<PathBuf> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let dir = spill_dir();
    std::fs::create_dir_all(&dir)?;
    let n = NEXT.fetch_add(1, Ordering::Relaxed);
    Ok(dir.join(format!("{}-{n}.arrows", std::process::id())))
}

/// Writes batches to a new spill file; [`SpillWriter::finish`] hands it over.
pub struct SpillWriter {
    path: PathBuf,
    writer: Option<StreamWriter<BufWriter<File>>>,
    schema: SchemaRef,
    rows: usize,
}

impl SpillWriter {
    pub fn try_new(schema: SchemaRef) -> Result<Self> {
        let path = new_path()?;
        let options = IpcWriteOptions::default().try_with_compression(Some(CompressionType::LZ4_FRAME))?;
        let file = BufWriter::with_capacity(1 << 20, File::create(&path)?);
        let writer = StreamWriter::try_new_with_options(file, &schema, options)?;
        Ok(Self { path, writer: Some(writer), schema, rows: 0 })
    }

    pub fn write(&mut self, batch: &RecordBatch) -> Result<()> {
        if batch.num_rows() == 0 {
            return Ok(());
        }
        self.rows += batch.num_rows();
        self.writer.as_mut().expect("spill writer finished").write(&compact_views(batch)?)?;
        Ok(())
    }

    pub fn rows(&self) -> usize {
        self.rows
    }

    pub fn finish(mut self) -> Result<SpillFile> {
        let mut w = self.writer.take().expect("spill writer finished");
        w.finish()?;
        drop(w.into_inner()?);
        let bytes = std::fs::metadata(&self.path)?.len();
        SPILLED.fetch_add(bytes, Ordering::Relaxed);
        Ok(SpillFile { path: std::mem::take(&mut self.path), schema: self.schema.clone(), rows: self.rows, bytes })
    }
}

impl Drop for SpillWriter {
    fn drop(&mut self) {
        // abandoned (an error, a cancelled query): remove the partial file
        if self.writer.is_some() {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// A finished spill file (deleted on drop).
pub struct SpillFile {
    path: PathBuf,
    schema: SchemaRef,
    rows: usize,
    bytes: u64,
}

impl std::fmt::Debug for SpillFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SpillFile({} rows, {} bytes)", self.rows, self.bytes)
    }
}

impl SpillFile {
    pub fn rows(&self) -> usize {
        self.rows
    }

    pub fn bytes(&self) -> u64 {
        self.bytes
    }

    pub fn schema(&self) -> SchemaRef {
        self.schema.clone()
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// The batches, in the order they were written.
    pub fn read(&self) -> Result<impl Iterator<Item = Result<RecordBatch>> + use<>> {
        let reader = StreamReader::try_new(BufReader::with_capacity(1 << 20, File::open(&self.path)?), None)?;
        Ok(reader.map(|b| b.map_err(WhError::from)))
    }

    /// All batches at once.
    pub fn read_all(&self) -> Result<Vec<RecordBatch>> {
        self.read()?.collect()
    }
}

impl Drop for SpillFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// View columns (`Utf8View`, `BinaryView`) point into the buffers they were
/// decoded or taken from, and IPC writes those buffers whole: a slice of a
/// few rows would carry megabytes. Spilled batches keep only their bytes.
fn compact_views(batch: &RecordBatch) -> Result<RecordBatch> {
    use arrow::array::{ArrayRef, AsArray};
    use arrow::datatypes::DataType;
    let has_views = batch.columns().iter().any(|c| matches!(c.data_type(), DataType::Utf8View | DataType::BinaryView));
    if !has_views {
        return Ok(batch.clone());
    }
    let cols: Vec<ArrayRef> = batch
        .columns()
        .iter()
        .map(|c| match c.data_type() {
            DataType::Utf8View => std::sync::Arc::new(c.as_string_view().gc()) as ArrayRef,
            DataType::BinaryView => std::sync::Arc::new(c.as_binary_view().gc()) as ArrayRef,
            _ => c.clone(),
        })
        .collect();
    let opts = arrow::record_batch::RecordBatchOptions::new().with_row_count(Some(batch.num_rows()));
    Ok(RecordBatch::try_new_with_options(batch.schema(), cols, &opts)?)
}

/// One spill file from a list of batches.
pub fn spill(schema: SchemaRef, batches: &[RecordBatch]) -> Result<SpillFile> {
    let mut w = SpillWriter::try_new(schema)?;
    for b in batches {
        w.write(b)?;
    }
    w.finish()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use arrow::array::{Int64Array, StringArray};
    use arrow::datatypes::{DataType, Field, Schema};

    use super::*;

    #[test]
    fn round_trip_and_cleanup() {
        let schema = Arc::new(Schema::new(vec![Field::new("a", DataType::Int64, false), Field::new("s", DataType::Utf8, true)]));
        let batch = RecordBatch::try_new(
            schema.clone(),
            vec![Arc::new(Int64Array::from_iter_values(0..1000)), Arc::new(StringArray::from_iter((0..1000).map(|i| (i % 3 != 0).then(|| format!("v{i}")))))],
        )
        .unwrap();
        let file = spill(schema, &[batch.clone(), batch.slice(10, 5)]).unwrap();
        assert_eq!(file.rows(), 1005);
        let path = file.path().to_path_buf();
        let back = file.read_all().unwrap();
        assert_eq!(back[0], batch);
        assert_eq!(back[1], batch.slice(10, 5));
        drop(file);
        assert!(!path.exists());
    }

    #[test]
    fn slices_of_view_arrays_spill_only_their_bytes() {
        use arrow::array::StringViewArray;
        // long strings live in large data buffers that every slice references
        let long: Vec<String> = (0..20_000).map(|i| format!("{i:0>100}")).collect();
        let views = Arc::new(StringViewArray::from_iter_values(long.iter())) as arrow::array::ArrayRef;
        let schema = Arc::new(Schema::new(vec![Field::new("s", DataType::Utf8View, false)]));
        let batch = RecordBatch::try_new(schema.clone(), vec![views]).unwrap();
        let whole = spill(schema.clone(), std::slice::from_ref(&batch)).unwrap();
        let few = spill(schema, &[batch.slice(100, 10)]).unwrap();
        assert!(few.bytes() * 50 < whole.bytes(), "{} vs {}", few.bytes(), whole.bytes());
        assert_eq!(few.read_all().unwrap()[0], batch.slice(100, 10));
    }
}
