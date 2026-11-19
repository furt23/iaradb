//! Checkpoint Parquet files into actions. Reads what Spark, delta-rs and
//! this crate write: the columns `txn`, `add`, `remove`, `metaData` and
//! `protocol` (one non-null action per row); `commitInfo`, `domainMetadata`
//! and `partitionValues_parsed` are not read. A checkpoint of the v2 layout
//! (`checkpointMetadata` / `sidecar` rows) is refused.
//!
//! A table can keep the files' statistics as a struct (`add.stats_parsed`,
//! `delta.checkpoint.writeStatsAsStruct`) and leave the JSON text out
//! (`delta.checkpoint.writeStatsAsJson = false`). The struct is read only
//! then, and turned into the JSON text an `add` carries: without it no
//! filter could skip a file of such a table.

use std::collections::BTreeMap;

use arrow::array::{Array, ArrayRef, AsArray, RecordBatch};
use arrow::datatypes::{DataType, Date32Type, Decimal128Type, Float32Type, Float64Type, Int8Type, Int16Type, Int32Type, Int64Type, TimeUnit, TimestampMicrosecondType};
use bytes::Bytes;
use parquet::arrow::ProjectionMask;
use parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder;

use super::actions::{Action, Add, DeletionVector, Format, Metadata, Protocol, Remove, Txn};
use crate::error::{Result, WhError};

const ACTION_COLUMNS: [&str; 5] = ["txn", "add", "remove", "metaData", "protocol"];
const V2_COLUMNS: [&str; 2] = ["checkpointMetadata", "sidecar"];
const STATS_PARSED: &str = "stats_parsed";
const PARTITION_VALUES_PARSED: &str = "partitionValues_parsed";

/// The actions of one checkpoint file.
pub fn parse_checkpoint(bytes: Bytes) -> Result<Vec<Action>> {
    let builder = ParquetRecordBatchReaderBuilder::try_new(bytes)?;
    let descr = builder.parquet_schema();
    let parsed_stats = !has_json_stats(builder.metadata());
    let leaves: Vec<usize> = descr
        .columns()
        .iter()
        .enumerate()
        .filter(|(_, c)| {
            let parts = c.path().parts();
            let root = parts[0].as_str();
            let skipped = |p: &String| p == PARTITION_VALUES_PARSED || (p == STATS_PARSED && !parsed_stats);
            (ACTION_COLUMNS.contains(&root) || V2_COLUMNS.contains(&root)) && !parts.iter().any(skipped)
        })
        .map(|(i, _)| i)
        .collect();
    if leaves.is_empty() {
        return Ok(vec![]);
    }
    let mask = ProjectionMask::leaves(descr, leaves);
    let mut actions = Vec::new();
    for batch in builder.with_projection(mask).build()? {
        read_batch(&batch?, &mut actions)?;
    }
    Ok(actions)
}

/// Whether any `add` of the checkpoint may carry its statistics as JSON text: the column
/// `add.stats` exists and is not all nulls (by the row groups' statistics, where they say).
fn has_json_stats(meta: &parquet::file::metadata::ParquetMetaData) -> bool {
    let descr = meta.file_metadata().schema_descr();
    let Some(leaf) = descr.columns().iter().position(|c| c.path().parts() == ["add", "stats"]) else { return false };
    meta.row_groups().iter().any(|rg| {
        let column = rg.column(leaf);
        column.statistics().and_then(|s| s.null_count_opt()).is_none_or(|nulls| (nulls as i64) < column.num_values())
    })
}

/// The JSON value of row `i` of a statistics column: structs as objects of their non-null
/// fields, bounds as [`FileStats::parse`](super::stats::FileStats::parse) reads them (timestamps
/// keep their microseconds). `None` for a null or a type statistics have no form for.
fn stats_value(a: &ArrayRef, i: usize) -> Option<String> {
    if a.is_null(i) {
        return None;
    }
    let text = |v: &dyn std::fmt::Display| Some(v.to_string());
    match a.data_type() {
        DataType::Struct(fields) => {
            let s = a.as_struct();
            let items: Vec<String> = fields
                .iter()
                .zip(s.columns())
                .filter_map(|(f, c)| Some(format!("{}:{}", serde_json::to_string(f.name()).ok()?, stats_value(c, i)?)))
                .collect();
            Some(format!("{{{}}}", items.join(",")))
        }
        DataType::Boolean => text(&a.as_boolean().value(i)),
        DataType::Int8 => text(&a.as_primitive::<Int8Type>().value(i)),
        DataType::Int16 => text(&a.as_primitive::<Int16Type>().value(i)),
        DataType::Int32 => text(&a.as_primitive::<Int32Type>().value(i)),
        DataType::Int64 => text(&a.as_primitive::<Int64Type>().value(i)),
        DataType::Float32 => Some(a.as_primitive::<Float32Type>().value(i)).filter(|v| v.is_finite()).map(|v| v.to_string()),
        DataType::Float64 => Some(a.as_primitive::<Float64Type>().value(i)).filter(|v| v.is_finite()).map(|v| v.to_string()),
        DataType::Utf8 => serde_json::to_string(a.as_string::<i32>().value(i)).ok(),
        DataType::LargeUtf8 => serde_json::to_string(a.as_string::<i64>().value(i)).ok(),
        DataType::Date32 => {
            let day = chrono::DateTime::from_timestamp(i64::from(a.as_primitive::<Date32Type>().value(i)) * 86_400, 0)?;
            Some(format!("\"{}\"", day.format("%Y-%m-%d")))
        }
        DataType::Timestamp(TimeUnit::Microsecond, tz) => {
            let at = chrono::DateTime::from_timestamp_micros(a.as_primitive::<TimestampMicrosecondType>().value(i))?;
            Some(format!("\"{}{}\"", at.format("%Y-%m-%dT%H:%M:%S%.6f"), if tz.is_some() { "Z" } else { "" }))
        }
        DataType::Decimal128(_, scale) => {
            let v = a.as_primitive::<Decimal128Type>().value(i);
            let (sign, digits, scale) = (if v < 0 { "-" } else { "" }, v.unsigned_abs().to_string(), (*scale).max(0) as usize);
            let padded = format!("{digits:0>width$}", width = scale + 1);
            let (int, frac) = padded.split_at(padded.len() - scale);
            Some(if scale == 0 { format!("{sign}{int}") } else { format!("{sign}{int}.{frac}") })
        }
        _ => None,
    }
}

fn invalid(what: &str) -> WhError {
    WhError::Execution(format!("invalid Delta checkpoint: missing {what}"))
}

fn need<T>(v: Option<T>, what: &str) -> Result<T> {
    v.ok_or_else(|| invalid(what))
}

/// A column of a batch, or of a struct column, that may be absent.
#[derive(Clone, Copy)]
struct Col<'a>(Option<&'a ArrayRef>);

impl<'a> Col<'a> {
    fn of(batch: &'a RecordBatch, name: &str) -> Col<'a> {
        Col(batch.column_by_name(name))
    }

    fn sub(self, name: &str) -> Col<'a> {
        Col(self.0.and_then(|a| a.as_struct_opt()).and_then(|s| s.column_by_name(name)))
    }

    fn valid(self, i: usize) -> bool {
        self.0.is_some_and(|a| a.is_valid(i))
    }

    fn str(self, i: usize) -> Option<String> {
        let a = self.0.filter(|a| a.is_valid(i))?;
        match a.data_type() {
            DataType::Utf8 => Some(a.as_string::<i32>().value(i).to_string()),
            DataType::LargeUtf8 => Some(a.as_string::<i64>().value(i).to_string()),
            _ => None,
        }
    }

    fn i64(self, i: usize) -> Option<i64> {
        let a = self.0.filter(|a| a.is_valid(i))?;
        match a.data_type() {
            DataType::Int64 => Some(a.as_primitive::<Int64Type>().value(i)),
            DataType::Int32 => Some(a.as_primitive::<Int32Type>().value(i) as i64),
            _ => None,
        }
    }

    fn bool(self, i: usize) -> Option<bool> {
        let a = self.0.filter(|a| a.is_valid(i))?;
        Some(a.as_boolean_opt()?.value(i))
    }

    fn map(self, i: usize) -> Option<BTreeMap<String, Option<String>>> {
        let m = self.0?.as_map_opt().filter(|m| m.is_valid(i))?;
        let entries = m.value(i);
        let keys = entries.column(0).as_string_opt::<i32>()?;
        let vals = entries.column(1).as_string_opt::<i32>()?;
        Some((0..entries.len()).filter(|&j| keys.is_valid(j)).map(|j| (keys.value(j).to_string(), vals.is_valid(j).then(|| vals.value(j).to_string()))).collect())
    }

    fn list(self, i: usize) -> Option<Vec<String>> {
        let l = self.0?.as_list_opt::<i32>().filter(|l| l.is_valid(i))?;
        let values = l.value(i);
        let s = values.as_string_opt::<i32>()?;
        Some((0..s.len()).filter(|&j| s.is_valid(j)).map(|j| s.value(j).to_string()).collect())
    }
}

fn read_batch(batch: &RecordBatch, out: &mut Vec<Action>) -> Result<()> {
    let rows = batch.num_rows();
    for name in V2_COLUMNS {
        let col = Col::of(batch, name);
        if (0..rows).any(|i| col.valid(i)) {
            return Err(WhError::NotSupported(format!("Delta v2 checkpoints (a '{name}' row) are not supported")));
        }
    }
    let (txn, add, remove, meta, proto) = (Col::of(batch, "txn"), Col::of(batch, "add"), Col::of(batch, "remove"), Col::of(batch, "metaData"), Col::of(batch, "protocol"));
    for i in 0..rows {
        if add.valid(i) {
            out.push(Action::Add(read_add(add, i)?));
        } else if remove.valid(i) {
            out.push(Action::Remove(read_remove(remove, i)?));
        } else if meta.valid(i) {
            out.push(Action::Metadata(read_metadata(meta, i)?));
        } else if proto.valid(i) {
            out.push(Action::Protocol(read_protocol(proto, i)?));
        } else if txn.valid(i) {
            out.push(Action::Txn(Txn { app_id: need(txn.sub("appId").str(i), "txn.appId")?, version: need(txn.sub("version").i64(i), "txn.version")?, last_updated: txn.sub("lastUpdated").i64(i) }));
        }
    }
    Ok(())
}

fn read_deletion_vector(c: Col, i: usize) -> Result<Option<DeletionVector>> {
    if !c.valid(i) {
        return Ok(None);
    }
    Ok(Some(DeletionVector {
        storage_type: need(c.sub("storageType").str(i), "deletionVector.storageType")?,
        path_or_inline_dv: need(c.sub("pathOrInlineDv").str(i), "deletionVector.pathOrInlineDv")?,
        offset: c.sub("offset").i64(i).map(|v| v as i32),
        size_in_bytes: need(c.sub("sizeInBytes").i64(i), "deletionVector.sizeInBytes")? as i32,
        cardinality: need(c.sub("cardinality").i64(i), "deletionVector.cardinality")?,
    }))
}

fn read_add(c: Col, i: usize) -> Result<Add> {
    Ok(Add {
        path: need(c.sub("path").str(i), "add.path")?,
        partition_values: c.sub("partitionValues").map(i).unwrap_or_default(),
        size: need(c.sub("size").i64(i), "add.size")?,
        modification_time: c.sub("modificationTime").i64(i).unwrap_or(0),
        data_change: c.sub("dataChange").bool(i).unwrap_or(true),
        stats: c.sub("stats").str(i).or_else(|| c.sub(STATS_PARSED).0.and_then(|parsed| stats_value(parsed, i))),
        tags: c.sub("tags").map(i),
        deletion_vector: read_deletion_vector(c.sub("deletionVector"), i)?,
        base_row_id: c.sub("baseRowId").i64(i),
        default_row_commit_version: c.sub("defaultRowCommitVersion").i64(i),
    })
}

fn read_remove(c: Col, i: usize) -> Result<Remove> {
    Ok(Remove {
        path: need(c.sub("path").str(i), "remove.path")?,
        deletion_timestamp: c.sub("deletionTimestamp").i64(i),
        data_change: c.sub("dataChange").bool(i).unwrap_or(true),
        extended_file_metadata: c.sub("extendedFileMetadata").bool(i),
        partition_values: c.sub("partitionValues").map(i),
        size: c.sub("size").i64(i),
        stats: c.sub("stats").str(i),
        tags: c.sub("tags").map(i),
        deletion_vector: read_deletion_vector(c.sub("deletionVector"), i)?,
    })
}

fn read_metadata(c: Col, i: usize) -> Result<Metadata> {
    let format = c.sub("format");
    let strings = |m: Option<BTreeMap<String, Option<String>>>| m.unwrap_or_default().into_iter().filter_map(|(k, v)| v.map(|v| (k, v))).collect();
    Ok(Metadata {
        id: need(c.sub("id").str(i), "metaData.id")?,
        name: c.sub("name").str(i),
        description: c.sub("description").str(i),
        format: if format.valid(i) {
            Format { provider: format.sub("provider").str(i).unwrap_or_else(|| "parquet".into()), options: strings(format.sub("options").map(i)) }
        } else {
            Format::default()
        },
        schema_string: need(c.sub("schemaString").str(i), "metaData.schemaString")?,
        partition_columns: c.sub("partitionColumns").list(i).unwrap_or_default(),
        configuration: strings(c.sub("configuration").map(i)),
        created_time: c.sub("createdTime").i64(i),
    })
}

fn read_protocol(c: Col, i: usize) -> Result<Protocol> {
    Ok(Protocol {
        min_reader_version: need(c.sub("minReaderVersion").i64(i), "protocol.minReaderVersion")? as i32,
        min_writer_version: need(c.sub("minWriterVersion").i64(i), "protocol.minWriterVersion")? as i32,
        reader_features: c.sub("readerFeatures").list(i),
        writer_features: c.sub("writerFeatures").list(i),
    })
}
