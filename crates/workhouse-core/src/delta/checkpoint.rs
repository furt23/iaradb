//! Checkpoints: the table state at one version as Parquet files in
//! `_delta_log/`, so readers skip the commits before it. A checkpoint of this
//! crate holds the protocol, the metadata, the app transaction versions and
//! the active files (no tombstones: this crate neither vacuums by them nor
//! needs them to read), in the classic layout (see `checkpoint_write`).
//! `_last_checkpoint` points to the newest one.

use bytes::Bytes;

use super::actions::Action;
use super::checkpoint_read::parse_checkpoint;
use super::checkpoint_write::encode_checkpoint;
use super::log_store::LogStore;
use super::names::{LAST_CHECKPOINT, LastCheckpoint, checkpoint_file_name, multipart_checkpoint_file_names};
use super::snapshot::Snapshot;
use crate::error::Result;

/// A checkpoint is written after every commit whose version is a multiple of this.
pub const CHECKPOINT_INTERVAL: u64 = 10;

pub fn should_checkpoint(version: u64) -> bool {
    version > 0 && version % CHECKPOINT_INTERVAL == 0
}

/// The actions of the checkpoint files `names` (all parts of one checkpoint).
pub fn read_checkpoint(log: &LogStore, names: &[String]) -> Result<Vec<Action>> {
    let mut actions = Vec::new();
    for name in names {
        let bytes: Bytes = log.read(name)?;
        actions.extend(parse_checkpoint(bytes)?);
    }
    Ok(actions)
}

/// The actions that make up the state of `snapshot`.
fn snapshot_actions(snapshot: &Snapshot) -> Vec<Action> {
    let mut actions = vec![Action::Protocol(snapshot.protocol.clone()), Action::Metadata(snapshot.metadata.clone())];
    actions.extend(snapshot.txns.iter().cloned().map(Action::Txn));
    actions.extend(snapshot.files.iter().cloned().map(Action::Add));
    actions
}

/// Write a single-file checkpoint of `snapshot` and point `_last_checkpoint` at it.
pub fn write_checkpoint(log: &LogStore, snapshot: &Snapshot) -> Result<LastCheckpoint> {
    write_checkpoint_parts(log, snapshot, 1)
}

/// Write a checkpoint of `snapshot` split into up to `parts` files (a
/// multi-part checkpoint when more than one) and point `_last_checkpoint` at
/// it. A checkpoint file that already exists is left as it is (the content
/// of a version never changes); the pointer only moves forward.
pub fn write_checkpoint_parts(log: &LogStore, snapshot: &Snapshot, parts: u32) -> Result<LastCheckpoint> {
    let actions = snapshot_actions(snapshot);
    let parts = (parts.max(1) as usize).min(actions.len());
    let per_part = actions.len().div_ceil(parts);
    let chunks: Vec<&[Action]> = actions.chunks(per_part).collect();
    let names = if chunks.len() == 1 { vec![checkpoint_file_name(snapshot.version)] } else { multipart_checkpoint_file_names(snapshot.version, chunks.len() as u32) };
    let mut size_in_bytes = 0i64;
    for (name, chunk) in names.iter().zip(&chunks) {
        let bytes = encode_checkpoint(chunk)?;
        size_in_bytes += bytes.len() as i64;
        log.put_if_absent(name, bytes)?;
    }
    let last = LastCheckpoint {
        version: snapshot.version,
        size: actions.len() as i64,
        parts: (chunks.len() > 1).then_some(chunks.len() as u32),
        size_in_bytes: Some(size_in_bytes),
        num_of_add_files: Some(snapshot.files.len() as i64),
    };
    if log.read_last_checkpoint()?.is_none_or(|current| current.version <= last.version) {
        log.put(LAST_CHECKPOINT, last.to_bytes())?;
    }
    Ok(last)
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;
    use std::sync::Arc;

    use arrow::array::{ArrayRef, Int64Array, MapBuilder, RecordBatch, StringArray, StringBuilder, StructArray};
    use arrow::buffer::NullBuffer;
    use arrow::datatypes::{Field, Schema};
    use parquet::arrow::ArrowWriter;

    use super::*;
    use crate::delta::actions::{DeletionVector, Format, Protocol, Remove, Txn};
    use crate::delta::test_support::{add, metadata};

    #[test]
    fn checkpoints_are_due_every_ten_versions() {
        let due: Vec<u64> = (0..=31).filter(|v| should_checkpoint(*v)).collect();
        assert_eq!(due, vec![10, 20, 30]);
    }

    #[test]
    fn every_action_kind_round_trips_through_parquet() {
        let mut a1 = add("year=2024/a b.parquet", 7);
        a1.partition_values = [("year".to_string(), Some("2024".to_string())), ("m".to_string(), None)].into();
        a1.tags = Some([("t".to_string(), Some("v".to_string())), ("n".to_string(), None)].into());
        a1.base_row_id = Some(5);
        a1.default_row_commit_version = Some(2);
        a1.deletion_vector = Some(DeletionVector { storage_type: "u".into(), path_or_inline_dv: "ab^-x".into(), offset: Some(1), size_in_bytes: 40, cardinality: 3 });
        let mut a2 = add("plain.parquet", 8);
        a2.stats = None;
        a2.data_change = false;
        let mut meta = metadata(&["id", "name"]);
        meta.name = Some("t".into());
        meta.description = Some("d".into());
        meta.partition_columns = vec!["id".into()];
        meta.configuration = [("delta.appendOnly".to_string(), "true".to_string())].into();
        meta.format = Format { provider: "parquet".into(), options: [("o".to_string(), "1".to_string())].into() };
        let proto = Protocol { min_reader_version: 3, min_writer_version: 7, reader_features: Some(vec!["timestampNtz".into()]), writer_features: Some(vec!["timestampNtz".into(), "appendOnly".into()]) };
        let remove = Remove::of(&a2, 99, true);
        let actions = vec![
            Action::Protocol(proto),
            Action::Metadata(meta),
            Action::Txn(Txn { app_id: "app".into(), version: 4, last_updated: Some(10) }),
            Action::Add(a1),
            Action::Add(a2),
            Action::Remove(remove),
        ];
        let bytes = encode_checkpoint(&actions).unwrap();
        let mut back = parse_checkpoint(Bytes::from(bytes)).unwrap();
        // rows come back grouped by kind order of the file, which is the order given
        let order = |a: &Action| match a {
            Action::Protocol(_) => 0,
            Action::Metadata(_) => 1,
            Action::Txn(_) => 2,
            Action::Add(_) => 3,
            _ => 4,
        };
        back.sort_by_key(order);
        let mut expected = actions.clone();
        expected.sort_by_key(order);
        assert_eq!(back, expected);
    }

    fn string_map(rows: Vec<Vec<(&str, &str)>>) -> ArrayRef {
        let mut b = MapBuilder::new(None, StringBuilder::new(), StringBuilder::new());
        for r in rows {
            for (k, v) in r {
                b.keys().append_value(k);
                b.values().append_value(v);
            }
            b.append(true).unwrap();
        }
        Arc::new(b.finish())
    }

    fn structure(valid: Vec<bool>, cols: Vec<(&str, ArrayRef)>) -> ArrayRef {
        let fields: Vec<Field> = cols.iter().map(|(n, a)| Field::new(*n, a.data_type().clone(), true)).collect();
        Arc::new(StructArray::new(fields.into(), cols.into_iter().map(|(_, a)| a).collect(), Some(NullBuffer::from(valid))))
    }

    fn write(cols: Vec<(&str, ArrayRef)>) -> Bytes {
        let schema = Arc::new(Schema::new(cols.iter().map(|(n, a)| Field::new(*n, a.data_type().clone(), true)).collect::<Vec<_>>()));
        let batch = RecordBatch::try_new(schema.clone(), cols.into_iter().map(|(_, a)| a).collect()).unwrap();
        let mut out = Vec::new();
        let mut w = ArrowWriter::try_new(&mut out, schema, None).unwrap();
        w.write(&batch).unwrap();
        w.close().unwrap();
        Bytes::from(out)
    }

    #[test]
    fn spark_style_columns_are_read_or_ignored() {
        // add with a stats_parsed struct, a commitInfo column and an unrelated column
        let strs = |v: Vec<Option<&str>>| -> ArrayRef { Arc::new(StringArray::from(v)) };
        let longs = |v: Vec<Option<i64>>| -> ArrayRef { Arc::new(Int64Array::from(v)) };
        let parsed = structure(vec![true, false], vec![("numRecords", longs(vec![Some(3), None]))]);
        let add_col = structure(
            vec![true, false],
            vec![
                ("path", strs(vec![Some("f%201.parquet"), None])),
                ("partitionValues", string_map(vec![vec![("p", "x")], vec![]])),
                ("size", longs(vec![Some(11), None])),
                ("modificationTime", longs(vec![Some(5), None])),
                ("stats", strs(vec![Some("{\"numRecords\":3}"), None])),
                ("stats_parsed", parsed),
            ],
        );
        let commit_info = structure(vec![false, true], vec![("operation", strs(vec![None, Some("WRITE")]))]);
        let bytes = write(vec![("add", add_col), ("commitInfo", commit_info), ("other", longs(vec![Some(1), Some(2)]))]);
        let actions = parse_checkpoint(bytes).unwrap();
        assert_eq!(actions.len(), 1);
        let Action::Add(a) = &actions[0] else { panic!() };
        assert_eq!((a.file_path().as_str(), a.size, a.data_change), ("f 1.parquet", 11, true), "dataChange defaults to true when the column is absent");
        assert_eq!(a.partition_values, BTreeMap::from([("p".to_string(), Some("x".to_string()))]));
        assert_eq!(a.stats.as_deref(), Some("{\"numRecords\":3}"));
        // only unrelated columns: nothing to read
        assert!(parse_checkpoint(write(vec![("other", longs(vec![Some(1)]))])).unwrap().is_empty());
    }

    #[test]
    fn v2_checkpoints_are_refused() {
        let strs = |v: Vec<Option<&str>>| -> ArrayRef { Arc::new(StringArray::from(v)) };
        let longs = |v: Vec<Option<i64>>| -> ArrayRef { Arc::new(Int64Array::from(v)) };
        let sidecar = structure(vec![true], vec![("path", strs(vec![Some("x.parquet")])), ("sizeInBytes", longs(vec![Some(1)]))]);
        let err = parse_checkpoint(write(vec![("sidecar", sidecar)])).unwrap_err().to_string();
        assert!(err.contains("v2 checkpoints") && err.contains("sidecar"), "{err}");
    }
}
