//! Arrow IPC stream buffers, the way tables cross to and from JS.
//!
//! Every type the engine produces is written as it is: apache-arrow 21.2.0
//! reads Utf8View and BinaryView (also nested in lists, structs and maps)
//! as well as the other types, so no column is converted.

use std::io::Cursor;

use arrow::datatypes::SchemaRef;
use arrow::ipc::reader::StreamReader;
use arrow::ipc::writer::StreamWriter;
use arrow::record_batch::RecordBatch;

use crate::error::{Result, ResExt};

/// An uncompressed IPC stream: the schema, then the batches.
pub fn to_ipc(schema: &SchemaRef, batches: &[RecordBatch]) -> Result<Vec<u8>> {
    let mut w = StreamWriter::try_new(Vec::new(), schema).js()?;
    for b in batches {
        w.write(b).js()?;
    }
    w.into_inner().js()
}

pub fn from_ipc(bytes: &[u8]) -> Result<(SchemaRef, Vec<RecordBatch>)> {
    let reader = StreamReader::try_new(Cursor::new(bytes), None).js()?;
    let schema = reader.schema();
    let batches = reader.collect::<std::result::Result<Vec<_>, _>>().js()?;
    Ok((schema, batches))
}
