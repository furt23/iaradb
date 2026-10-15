//! Actions into one checkpoint Parquet file, in the classic layout: the
//! top-level columns `txn`, `add`, `remove`, `metaData` and `protocol` are
//! nullable structs and every row holds exactly one non-null action.
//! Maps use the Parquet names `key_value` / `key` / `value`, lists `element`;
//! statistics stay JSON text in `add.stats`.

use std::sync::Arc;

use arrow::array::{ArrayRef, BooleanArray, Int32Array, Int64Array, ListBuilder, MapBuilder, MapFieldNames, RecordBatch, StringArray, StringBuilder, StructArray};
use arrow::buffer::NullBuffer;
use arrow::datatypes::{DataType, Field, Schema};
use parquet::arrow::ArrowWriter;
use parquet::basic::Compression;
use parquet::file::properties::WriterProperties;

use super::actions::{Action, Add, DeletionVector, Metadata, Protocol, Remove, Txn};
use crate::error::Result;

type Pairs<'a> = Vec<(&'a str, Option<&'a str>)>;

fn strs<'a>(it: impl Iterator<Item = Option<&'a str>>) -> ArrayRef {
    Arc::new(StringArray::from_iter(it))
}

fn longs(it: impl Iterator<Item = Option<i64>>) -> ArrayRef {
    Arc::new(Int64Array::from_iter(it))
}

fn ints(it: impl Iterator<Item = Option<i32>>) -> ArrayRef {
    Arc::new(Int32Array::from_iter(it))
}

fn bools(it: impl Iterator<Item = Option<bool>>) -> ArrayRef {
    Arc::new(BooleanArray::from_iter(it))
}

fn maps<'a>(rows: impl Iterator<Item = Option<Pairs<'a>>>) -> ArrayRef {
    let names = MapFieldNames { entry: "key_value".into(), key: "key".into(), value: "value".into() };
    let mut b = MapBuilder::new(Some(names), StringBuilder::new(), StringBuilder::new());
    for row in rows {
        match row {
            Some(pairs) => {
                for (k, v) in pairs {
                    b.keys().append_value(k);
                    b.values().append_option(v);
                }
                b.append(true).expect("keys and values are appended in pairs");
            }
            None => b.append(false).expect("a null map has no entries"),
        }
    }
    Arc::new(b.finish())
}

fn str_lists<'a>(rows: impl Iterator<Item = Option<&'a [String]>>) -> ArrayRef {
    let mut b = ListBuilder::new(StringBuilder::new()).with_field(Arc::new(Field::new("element", DataType::Utf8, true)));
    for row in rows {
        match row {
            Some(items) => {
                for s in items {
                    b.values().append_value(s);
                }
                b.append(true);
            }
            None => b.append(false),
        }
    }
    Arc::new(b.finish())
}

fn pairs<'a, V: AsRef<str>>(m: &'a std::collections::BTreeMap<String, V>) -> Pairs<'a> {
    m.iter().map(|(k, v)| (k.as_str(), Some(v.as_ref()))).collect()
}

fn pairs_opt(m: &std::collections::BTreeMap<String, Option<String>>) -> Pairs<'_> {
    m.iter().map(|(k, v)| (k.as_str(), v.as_deref())).collect()
}

/// A struct column with one row per entry of `valid`; the children are nullable.
fn structure(valid: Vec<bool>, cols: Vec<(&str, ArrayRef)>) -> ArrayRef {
    let fields: Vec<Field> = cols.iter().map(|(n, a)| Field::new(*n, a.data_type().clone(), true)).collect();
    let arrays = cols.into_iter().map(|(_, a)| a).collect();
    Arc::new(StructArray::new(fields.into(), arrays, Some(NullBuffer::from(valid))))
}

fn valid<T>(rows: &[Option<&T>]) -> Vec<bool> {
    rows.iter().map(Option::is_some).collect()
}

fn deletion_vectors(rows: Vec<Option<&DeletionVector>>) -> ArrayRef {
    structure(
        valid(&rows),
        vec![
            ("storageType", strs(rows.iter().map(|r| r.map(|d| d.storage_type.as_str())))),
            ("pathOrInlineDv", strs(rows.iter().map(|r| r.map(|d| d.path_or_inline_dv.as_str())))),
            ("offset", ints(rows.iter().map(|r| r.and_then(|d| d.offset)))),
            ("sizeInBytes", ints(rows.iter().map(|r| r.map(|d| d.size_in_bytes)))),
            ("cardinality", longs(rows.iter().map(|r| r.map(|d| d.cardinality)))),
        ],
    )
}

fn txn_column(rows: &[Option<&Txn>]) -> ArrayRef {
    structure(
        valid(rows),
        vec![
            ("appId", strs(rows.iter().map(|r| r.map(|t| t.app_id.as_str())))),
            ("version", longs(rows.iter().map(|r| r.map(|t| t.version)))),
            ("lastUpdated", longs(rows.iter().map(|r| r.and_then(|t| t.last_updated)))),
        ],
    )
}

fn add_column(rows: &[Option<&Add>]) -> ArrayRef {
    structure(
        valid(rows),
        vec![
            ("path", strs(rows.iter().map(|r| r.map(|a| a.path.as_str())))),
            ("partitionValues", maps(rows.iter().map(|r| r.map(|a| pairs_opt(&a.partition_values))))),
            ("size", longs(rows.iter().map(|r| r.map(|a| a.size)))),
            ("modificationTime", longs(rows.iter().map(|r| r.map(|a| a.modification_time)))),
            ("dataChange", bools(rows.iter().map(|r| r.map(|a| a.data_change)))),
            ("stats", strs(rows.iter().map(|r| r.and_then(|a| a.stats.as_deref())))),
            ("tags", maps(rows.iter().map(|r| r.and_then(|a| a.tags.as_ref()).map(pairs_opt)))),
            ("deletionVector", deletion_vectors(rows.iter().map(|r| r.and_then(|a| a.deletion_vector.as_ref())).collect())),
            ("baseRowId", longs(rows.iter().map(|r| r.and_then(|a| a.base_row_id)))),
            ("defaultRowCommitVersion", longs(rows.iter().map(|r| r.and_then(|a| a.default_row_commit_version)))),
        ],
    )
}

fn remove_column(rows: &[Option<&Remove>]) -> ArrayRef {
    structure(
        valid(rows),
        vec![
            ("path", strs(rows.iter().map(|r| r.map(|a| a.path.as_str())))),
            ("deletionTimestamp", longs(rows.iter().map(|r| r.and_then(|a| a.deletion_timestamp)))),
            ("dataChange", bools(rows.iter().map(|r| r.map(|a| a.data_change)))),
            ("extendedFileMetadata", bools(rows.iter().map(|r| r.and_then(|a| a.extended_file_metadata)))),
            ("partitionValues", maps(rows.iter().map(|r| r.and_then(|a| a.partition_values.as_ref()).map(pairs_opt)))),
            ("size", longs(rows.iter().map(|r| r.and_then(|a| a.size)))),
            ("stats", strs(rows.iter().map(|r| r.and_then(|a| a.stats.as_deref())))),
            ("tags", maps(rows.iter().map(|r| r.and_then(|a| a.tags.as_ref()).map(pairs_opt)))),
            ("deletionVector", deletion_vectors(rows.iter().map(|r| r.and_then(|a| a.deletion_vector.as_ref())).collect())),
        ],
    )
}

fn metadata_column(rows: &[Option<&Metadata>]) -> ArrayRef {
    let format = structure(
        valid(rows),
        vec![
            ("provider", strs(rows.iter().map(|r| r.map(|m| m.format.provider.as_str())))),
            ("options", maps(rows.iter().map(|r| r.map(|m| pairs(&m.format.options))))),
        ],
    );
    structure(
        valid(rows),
        vec![
            ("id", strs(rows.iter().map(|r| r.map(|m| m.id.as_str())))),
            ("name", strs(rows.iter().map(|r| r.and_then(|m| m.name.as_deref())))),
            ("description", strs(rows.iter().map(|r| r.and_then(|m| m.description.as_deref())))),
            ("format", format),
            ("schemaString", strs(rows.iter().map(|r| r.map(|m| m.schema_string.as_str())))),
            ("partitionColumns", str_lists(rows.iter().map(|r| r.map(|m| m.partition_columns.as_slice())))),
            ("configuration", maps(rows.iter().map(|r| r.map(|m| pairs(&m.configuration))))),
            ("createdTime", longs(rows.iter().map(|r| r.and_then(|m| m.created_time)))),
        ],
    )
}

fn protocol_column(rows: &[Option<&Protocol>]) -> ArrayRef {
    structure(
        valid(rows),
        vec![
            ("minReaderVersion", ints(rows.iter().map(|r| r.map(|p| p.min_reader_version)))),
            ("minWriterVersion", ints(rows.iter().map(|r| r.map(|p| p.min_writer_version)))),
            ("readerFeatures", str_lists(rows.iter().map(|r| r.and_then(|p| p.reader_features.as_deref())))),
            ("writerFeatures", str_lists(rows.iter().map(|r| r.and_then(|p| p.writer_features.as_deref())))),
        ],
    )
}

/// The Parquet bytes of a checkpoint file holding `actions` (protocol,
/// metaData, txn, add and remove actions; others are not written).
pub fn encode_checkpoint(actions: &[Action]) -> Result<Vec<u8>> {
    let actions: Vec<&Action> = actions.iter().filter(|a| !matches!(a, Action::CommitInfo(_))).collect();
    macro_rules! rows {
        ($variant:ident) => {
            actions.iter().map(|a| if let Action::$variant(x) = a { Some(x) } else { None }).collect::<Vec<_>>()
        };
    }
    let columns: Vec<(&str, ArrayRef)> = vec![
        ("txn", txn_column(&rows!(Txn))),
        ("add", add_column(&rows!(Add))),
        ("remove", remove_column(&rows!(Remove))),
        ("metaData", metadata_column(&rows!(Metadata))),
        ("protocol", protocol_column(&rows!(Protocol))),
    ];
    let schema = Arc::new(Schema::new(columns.iter().map(|(n, a)| Field::new(*n, a.data_type().clone(), true)).collect::<Vec<_>>()));
    let batch = RecordBatch::try_new(schema.clone(), columns.into_iter().map(|(_, a)| a).collect())?;
    let props = WriterProperties::builder().set_compression(Compression::SNAPPY).build();
    let mut out = Vec::new();
    let mut writer = ArrowWriter::try_new(&mut out, schema, Some(props))?;
    writer.write(&batch)?;
    writer.close()?;
    Ok(out)
}
