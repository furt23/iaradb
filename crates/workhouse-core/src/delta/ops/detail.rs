//! `DESCRIBE DETAIL`: what the log says about a table as a whole.

use std::collections::BTreeMap;
use std::sync::Arc;

use arrow::array::{ArrayRef, Int32Array, Int64Array, ListBuilder, MapBuilder, StringArray, StringBuilder, TimestampMillisecondArray};
use arrow::datatypes::{DataType, Field, Schema, TimeUnit};
use arrow::record_batch::RecordBatch;

use crate::delta::log_store::LogStore;
use crate::delta::snapshot::Snapshot;
use crate::error::Result;
use crate::io::options::StorageOptions;

#[derive(Debug, Clone, PartialEq)]
pub struct TableDetail {
    /// always `delta`
    pub format: String,
    pub id: String,
    pub name: Option<String>,
    pub description: Option<String>,
    pub location: String,
    /// milliseconds since the epoch
    pub created_at: Option<i64>,
    /// when the newest version was committed, milliseconds since the epoch
    pub last_modified: i64,
    pub version: u64,
    pub partition_columns: Vec<String>,
    /// top-level columns declared NOT NULL
    pub not_null_columns: Vec<String>,
    pub num_files: u64,
    pub size_in_bytes: u64,
    pub properties: BTreeMap<String, String>,
    pub min_reader_version: i32,
    pub min_writer_version: i32,
}

/// The detail of the table at `location`, at its newest version.
pub fn detail(location: &str, storage: &StorageOptions) -> Result<TableDetail> {
    let log = LogStore::open(location, storage)?;
    let s = Snapshot::load(&log, None)?;
    Ok(TableDetail {
        format: "delta".into(),
        id: s.metadata.id.clone(),
        name: s.metadata.name.clone(),
        description: s.metadata.description.clone(),
        location: location.to_string(),
        created_at: s.metadata.created_time,
        last_modified: s.timestamp,
        version: s.version,
        partition_columns: s.partition_columns.clone(),
        not_null_columns: s.schema.fields().iter().filter(|f| !f.is_nullable()).map(|f| f.name().clone()).collect(),
        num_files: s.files.len() as u64,
        size_in_bytes: s.files.iter().map(|a| a.size.max(0) as u64).sum(),
        properties: s.metadata.configuration.clone(),
        min_reader_version: s.protocol.min_reader_version,
        min_writer_version: s.protocol.min_writer_version,
    })
}

/// [`detail`] as a one-row table: `format`, `id`, `name`, `description`,
/// `location`, `createdAt`, `lastModified`, `version`, `partitionColumns`,
/// `numFiles`, `sizeInBytes`, `properties`, `minReaderVersion`, `minWriterVersion`.
pub fn detail_batch(location: &str, storage: &StorageOptions) -> Result<RecordBatch> {
    let d = detail(location, storage)?;
    let ts = || DataType::Timestamp(TimeUnit::Millisecond, Some("UTC".into()));
    let strings = |v: &str| -> ArrayRef { Arc::new(StringArray::from(vec![v.to_string()])) };
    let optional = |v: &Option<String>| -> ArrayRef { Arc::new(StringArray::from(vec![v.clone()])) };

    let mut partitions = ListBuilder::new(StringBuilder::new());
    for c in &d.partition_columns {
        partitions.values().append_value(c);
    }
    partitions.append(true);
    let mut properties = MapBuilder::new(None, StringBuilder::new(), StringBuilder::new());
    for (k, v) in &d.properties {
        properties.keys().append_value(k);
        properties.values().append_value(v);
    }
    properties.append(true)?;
    let partitions: ArrayRef = Arc::new(partitions.finish());
    let properties: ArrayRef = Arc::new(properties.finish());

    let columns: Vec<ArrayRef> = vec![
        strings(&d.format),
        strings(&d.id),
        optional(&d.name),
        optional(&d.description),
        strings(&d.location),
        Arc::new(TimestampMillisecondArray::from(vec![d.created_at]).with_timezone("UTC")),
        Arc::new(TimestampMillisecondArray::from(vec![d.last_modified]).with_timezone("UTC")),
        Arc::new(Int64Array::from(vec![d.version as i64])),
        partitions.clone(),
        Arc::new(Int64Array::from(vec![d.num_files as i64])),
        Arc::new(Int64Array::from(vec![d.size_in_bytes as i64])),
        properties.clone(),
        Arc::new(Int32Array::from(vec![d.min_reader_version])),
        Arc::new(Int32Array::from(vec![d.min_writer_version])),
    ];
    let schema = Arc::new(Schema::new(vec![
        Field::new("format", DataType::Utf8, false),
        Field::new("id", DataType::Utf8, false),
        Field::new("name", DataType::Utf8, true),
        Field::new("description", DataType::Utf8, true),
        Field::new("location", DataType::Utf8, false),
        Field::new("createdAt", ts(), true),
        Field::new("lastModified", ts(), false),
        Field::new("version", DataType::Int64, false),
        Field::new("partitionColumns", partitions.data_type().clone(), false),
        Field::new("numFiles", DataType::Int64, false),
        Field::new("sizeInBytes", DataType::Int64, false),
        Field::new("properties", properties.data_type().clone(), false),
        Field::new("minReaderVersion", DataType::Int32, false),
        Field::new("minWriterVersion", DataType::Int32, false),
    ]));
    Ok(RecordBatch::try_new(schema, columns)?)
}
