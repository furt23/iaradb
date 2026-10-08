//! Opening Parquet files: local ones are memory mapped (zero copy), remote
//! ones keep only their footer and are read by ranges later.

use std::path::Path;
use std::sync::Arc;

use arrow::datatypes::{DataType, Field, Schema};
use parquet::arrow::arrow_reader::{ArrowReaderMetadata, ArrowReaderOptions};
use rayon::prelude::*;

use super::footer;
use crate::error::{Result, WhError};
use crate::io::DataFile;
use crate::io::blob::{Blob, map_local};
use crate::io::object::ObjectFile;

pub struct ParquetFile {
    pub name: String,
    pub blob: Blob,
    pub meta: ArrowReaderMetadata,
}

impl std::fmt::Debug for ParquetFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ParquetFile({})", self.name)
    }
}

/// Open files in order: local ones in parallel, remote footers concurrently.
pub fn open_files(files: Vec<DataFile>) -> Result<Vec<Arc<ParquetFile>>> {
    let (mut local, mut remote) = (vec![], vec![]);
    for (i, f) in files.into_iter().enumerate() {
        match f {
            DataFile::Local(p) => local.push((i, p)),
            DataFile::Object(o) => remote.push((i, o)),
        }
    }
    let mut opened: Vec<(usize, ParquetFile)> =
        local.par_iter().map(|(i, p)| open_local(p).map(|f| (*i, f))).collect::<Result<_>>()?;
    let objects: Vec<ObjectFile> = remote.iter().map(|(_, o)| o.clone()).collect();
    for ((i, o), meta) in remote.into_iter().zip(footer::fetch_all(&objects)?) {
        let meta = ArrowReaderMetadata::try_new(Arc::new(meta), ArrowReaderOptions::new()).map_err(|e| named(&o.url, e))?;
        opened.push((i, ParquetFile { name: o.url.to_string(), blob: Blob::Object(o), meta: with_string_views(meta) }));
    }
    opened.sort_by_key(|(i, _)| *i);
    Ok(opened.into_iter().map(|(_, f)| Arc::new(f)).collect())
}

fn open_local(path: &Path) -> Result<ParquetFile> {
    let data = map_local(path)?;
    let meta = ArrowReaderMetadata::load(&data, ArrowReaderOptions::new()).map_err(|e| named(&path.display(), e))?;
    Ok(ParquetFile { name: path.display().to_string(), blob: Blob::Mapped(data), meta: with_string_views(meta) })
}

fn named(name: &dyn std::fmt::Display, e: impl std::fmt::Display) -> WhError {
    WhError::Execution(format!("{name}: {e}"))
}

/// Decode strings as Utf8View ("German strings"): dictionary pages decode
/// to 16-byte views without copying string bytes, short strings live
/// inline, and filters / joins / group-bys move 16 bytes per value.
fn with_string_views(meta: ArrowReaderMetadata) -> ArrowReaderMetadata {
    let schema = meta.schema();
    let views = std::env::var("WORKHOUSE_STRING_VIEW").map(|v| v != "0").unwrap_or(true);
    if !views || !schema.fields().iter().any(|f| matches!(f.data_type(), DataType::Utf8 | DataType::LargeUtf8)) {
        return meta;
    }
    let fields: Vec<Field> = schema
        .fields()
        .iter()
        .map(|f| match f.data_type() {
            DataType::Utf8 | DataType::LargeUtf8 => f.as_ref().clone().with_data_type(DataType::Utf8View),
            _ => f.as_ref().clone(),
        })
        .collect();
    let hinted = Arc::new(Schema::new_with_metadata(fields, schema.metadata().clone()));
    ArrowReaderMetadata::try_new(meta.metadata().clone(), ArrowReaderOptions::new().with_schema(hinted)).unwrap_or(meta)
}
