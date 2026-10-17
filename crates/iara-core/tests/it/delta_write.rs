//! Writing Delta tables: the commits, the data files and what concurrent
//! writers may do. State is checked through the log (`Snapshot::load`).

use std::sync::Arc;

use arrow::array::{ArrayRef, Int64Array, LargeStringArray, StringArray, TimestampNanosecondArray, UInt32Array, UInt64Array};
use arrow::datatypes::{DataType, Field, Schema, TimeUnit};
use arrow::record_batch::RecordBatch;
use iara_core::delta::ops::{self, WriteArgs};
use iara_core::delta::{Action, LogStore, Snapshot, WriteMode, parse_commit, write_table};
use iara_core::io::StorageOptions;
use iara_core::{LazyFrame, SessionContext, WhError};

use crate::support::dir::{TempDir, files_under};

fn schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("g", DataType::Int64, true),
        Field::new("s", DataType::Utf8, true),
    ]))
}

/// A table `name` of the rows with these ids: g = id % 3 (null for id % 7 == 6), s = 's<id>'.
fn rows(ctx: &SessionContext, name: &str, ids: std::ops::Range<i64>) {
    let ids: Vec<i64> = ids.collect();
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(ids.clone())),
        Arc::new(Int64Array::from(ids.iter().map(|i| (i % 7 != 6).then_some(i % 3)).collect::<Vec<_>>())),
        Arc::new(StringArray::from(ids.iter().map(|i| format!("s{i}")).collect::<Vec<_>>())),
    ];
    ctx.register_batches(name, schema(), vec![RecordBatch::try_new(schema(), cols).unwrap()]).unwrap();
}

fn frame(ids: std::ops::Range<i64>) -> (SessionContext, LazyFrame) {
    let ctx = SessionContext::new();
    rows(&ctx, "t", ids);
    let lf = ctx.sql("select * from t").unwrap();
    (ctx, lf)
}

fn write(lf: &LazyFrame, path: &str, mode: WriteMode, partition_by: &[&str], merge: bool) -> iara_core::Result<iara_core::delta::WriteSummary> {
    let parts: Vec<String> = partition_by.iter().map(|s| s.to_string()).collect();
    write_table(lf, path, &StorageOptions::new(), mode, &parts, merge)
}

fn log(path: &str) -> LogStore {
    LogStore::open(path, &StorageOptions::new()).unwrap()
}

fn snapshot(path: &str) -> Snapshot {
    Snapshot::load(&log(path), None).unwrap()
}

fn commit_actions(path: &str, version: u64) -> Vec<Action> {
    parse_commit(&std::fs::read(format!("{path}/_delta_log/{version:020}.json")).unwrap()).unwrap()
}

fn data_files(path: &str) -> Vec<String> {
    files_under(path).into_iter().filter(|f| f.ends_with(".parquet") && !f.starts_with("_delta_log")).collect()
}

fn parquet_columns(file: &str) -> Vec<String> {
    let f = std::fs::File::open(file).unwrap();
    let b = parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder::try_new(f).unwrap();
    b.schema().fields().iter().map(|f| f.name().clone()).collect()
}

#[test]
fn create_writes_commit_zero() {
    let dir = TempDir::new("dw-create");
    let path = dir.join("t");
    let (_ctx, lf) = frame(0..100);
    let s = write(&lf, &path, WriteMode::Create, &[], false).unwrap();
    assert_eq!((s.version, s.files, s.rows), (0, 1, 100));

    let files = data_files(&path);
    assert_eq!(files.len(), 1);
    assert!(files[0].starts_with("part-") && files[0].ends_with("-c000.snappy.parquet"), "{files:?}");

    let actions = commit_actions(&path, 0);
    assert!(matches!(actions[0], Action::CommitInfo(_)));
    let Action::CommitInfo(info) = &actions[0] else { unreachable!() };
    assert_eq!(info.operation(), Some("CREATE TABLE AS SELECT"));
    assert!(info.0["engineInfo"].as_str().unwrap().starts_with("iara/"));
    assert_eq!(info.0["isBlindAppend"], false);
    assert_eq!(info.metric("numOutputRows"), Some(100));
    assert_eq!(info.metric("numAddedFiles"), Some(1));
    let Some(Action::Protocol(p)) = actions.iter().find(|a| matches!(a, Action::Protocol(_))) else { panic!("no protocol") };
    assert_eq!((p.min_reader_version, p.min_writer_version), (1, 2));
    let Some(Action::Metadata(m)) = actions.iter().find(|a| matches!(a, Action::Metadata(_))) else { panic!("no metaData") };
    assert_eq!(m.format.provider, "parquet");
    assert!(m.partition_columns.is_empty() && m.created_time.is_some() && m.id.len() == 36);
    let Some(Action::Add(add)) = actions.iter().find(|a| matches!(a, Action::Add(_))) else { panic!("no add") };
    assert_eq!(add.file_path(), files[0]);
    assert!(add.data_change && add.size > 0 && add.partition_values.is_empty());
    let stats: serde_json::Value = serde_json::from_str(add.stats.as_ref().unwrap()).unwrap();
    assert_eq!(stats["numRecords"], 100);
    assert_eq!(stats["minValues"]["id"], 0);
    assert_eq!(stats["maxValues"]["id"], 99);
    assert_eq!(stats["nullCount"]["g"], 100 / 7);

    let snap = snapshot(&path);
    assert_eq!((snap.version, snap.files.len()), (0, 1));
    let names: Vec<_> = snap.schema.fields().iter().map(|f| (f.name().as_str(), f.data_type().clone(), f.is_nullable())).collect();
    assert_eq!(names, vec![("id", DataType::Int64, true), ("g", DataType::Int64, true), ("s", DataType::Utf8, true)]);
}

#[test]
fn create_twice_errors_and_ignore_skips() {
    let dir = TempDir::new("dw-twice");
    let path = dir.join("t");
    let (_ctx, lf) = frame(0..10);
    write(&lf, &path, WriteMode::ErrorIfExists, &[], false).unwrap();
    let err = write(&lf, &path, WriteMode::ErrorIfExists, &[], false).unwrap_err().to_string();
    assert!(err.contains("already exists"), "{err}");
    assert!(write(&lf, &path, WriteMode::Create, &[], false).is_err());
    let s = write(&lf, &path, WriteMode::Ignore, &[], false).unwrap();
    assert!(s.skipped && s.version == 0);
    assert_eq!(data_files(&path).len(), 1);
    assert_eq!(snapshot(&path).version, 0);
}

#[test]
fn append_makes_version_one() {
    let dir = TempDir::new("dw-append");
    let path = dir.join("t");
    let (_c1, lf1) = frame(0..10);
    write(&lf1, &path, WriteMode::Append, &[], false).unwrap();
    let (_c2, lf2) = frame(10..30);
    let s = write(&lf2, &path, WriteMode::Append, &[], false).unwrap();
    assert_eq!((s.version, s.files, s.rows), (1, 1, 20));
    let snap = snapshot(&path);
    assert_eq!((snap.version, snap.files.len()), (1, 2));
    let actions = commit_actions(&path, 1);
    let Action::CommitInfo(info) = &actions[0] else { panic!() };
    assert_eq!((info.operation(), info.0["isBlindAppend"].as_bool()), (Some("WRITE"), Some(true)));
    assert_eq!(info.operation_parameters().unwrap()["mode"], "Append");
    assert_eq!(actions.len(), 2, "commitInfo and one add: {actions:?}");
}

#[test]
fn append_conforms_columns_by_name() {
    let dir = TempDir::new("dw-conform");
    let path = dir.join("t");
    let (_c1, lf1) = frame(0..10);
    write(&lf1, &path, WriteMode::Create, &[], false).unwrap();
    let ctx = SessionContext::new();
    rows(&ctx, "t", 10..20);
    // another order, another integer width for id, one column missing
    let lf2 = ctx.sql("select cast(id as int) as id, s from t").unwrap();
    write(&lf2, &path, WriteMode::Append, &[], false).unwrap();
    // a column the table lacks, and one that cannot be cast
    let lf3 = ctx.sql("select id, s, id as extra from t").unwrap();
    let err = write(&lf3, &path, WriteMode::Append, &[], false).unwrap_err().to_string();
    assert!(err.contains("extra") && err.contains("merge_schema"), "{err}");
    assert_eq!(snapshot(&path).version, 1);
    assert_eq!(snapshot(&path).files.len(), 2);
    assert_eq!(data_files(&path).len(), 2, "the refused write left no file");
}

#[test]
fn overwrite_removes_logically_and_adds() {
    let dir = TempDir::new("dw-overwrite");
    let path = dir.join("t");
    let (_c1, lf1) = frame(0..10);
    write(&lf1, &path, WriteMode::Create, &[], false).unwrap();
    let old = snapshot(&path).files[0].file_path();
    let (_c2, lf2) = frame(100..105);
    let s = write(&lf2, &path, WriteMode::Overwrite, &[], false).unwrap();
    assert_eq!((s.version, s.rows), (1, 5));

    let snap = snapshot(&path);
    assert_eq!(snap.files.len(), 1);
    assert_ne!(snap.files[0].file_path(), old);
    assert!(data_files(&path).contains(&old), "the removed file stays on disk");
    assert_eq!(data_files(&path).len(), 2);
    let actions = commit_actions(&path, 1);
    let removes: Vec<_> = actions.iter().filter_map(|a| if let Action::Remove(r) = a { Some(r) } else { None }).collect();
    assert_eq!(removes.len(), 1);
    assert_eq!(removes[0].file_path(), old);
    assert!(removes[0].data_change && removes[0].size.is_some());
    let Action::CommitInfo(info) = &actions[0] else { panic!() };
    assert_eq!(info.0["isBlindAppend"], false);
    assert_eq!(info.metric("numRemovedFiles"), Some(1));
    // time travel still sees the first version
    assert_eq!(Snapshot::load(&log(&path), Some(0)).unwrap().files[0].file_path(), old);
}

#[test]
fn replace_changes_schema_and_keeps_the_table_id() {
    let dir = TempDir::new("dw-replace");
    let path = dir.join("t");
    let (ctx, lf1) = frame(0..10);
    write(&lf1, &path, WriteMode::Create, &["g"], false).unwrap();
    let before = snapshot(&path);
    let lf2 = ctx.sql("select id, s from t where id < 4").unwrap();
    let s = write(&lf2, &path, WriteMode::Replace, &[], false).unwrap();
    assert_eq!(s.version, 1);
    let after = snapshot(&path);
    assert_eq!(after.metadata.id, before.metadata.id);
    assert_eq!(after.schema.fields().len(), 2);
    assert!(after.partition_columns.is_empty());
    assert_eq!(after.files.len(), 1);
    assert_eq!(after.files[0].partition_values.len(), 0);
}

#[test]
fn partitioned_layout_and_values() {
    let dir = TempDir::new("dw-part");
    let path = dir.join("t");
    let (_ctx, lf) = frame(0..60);
    let s = write(&lf, &path, WriteMode::Create, &["g"], false).unwrap();
    assert_eq!(s.files, 4, "g = 0, 1, 2 and null");
    let snap = snapshot(&path);
    assert_eq!(snap.partition_columns, vec!["g".to_string()]);
    let mut seen: Vec<(Option<String>, String)> = snap.files.iter().map(|a| (a.partition_values["g"].clone(), a.file_path())).collect();
    seen.sort();
    for (value, file) in &seen {
        let folder = value.as_deref().unwrap_or("__HIVE_DEFAULT_PARTITION__");
        assert!(file.starts_with(&format!("g={folder}/part-")), "{file}");
        assert_eq!(parquet_columns(&format!("{path}/{file}")), vec!["id", "s"], "the partition column is not in the file");
    }
    assert_eq!(seen[0].0, None, "a null partition is a null value");
    let total: i64 = snap.files.iter().map(|a| serde_json::from_str::<serde_json::Value>(a.stats.as_ref().unwrap()).unwrap()["numRecords"].as_i64().unwrap()).sum();
    assert_eq!(total, 60);
    // the table schema keeps the partition column
    assert_eq!(snap.schema.fields().len(), 3);

    // appending keeps the partitioning; asking for another one is refused
    let (_c2, lf2) = frame(60..70);
    write(&lf2, &path, WriteMode::Append, &[], false).unwrap();
    assert!(snapshot(&path).files.iter().all(|a| a.partition_values.contains_key("g")));
    let err = write(&lf2, &path, WriteMode::Append, &["s"], false).unwrap_err().to_string();
    assert!(err.contains("partitioned by"), "{err}");
}

#[test]
fn partition_values_are_escaped_in_folders() {
    let dir = TempDir::new("dw-escape");
    let path = dir.join("t");
    let ctx = SessionContext::new();
    rows(&ctx, "t", 0..4);
    let lf = ctx.sql("select id, case when id < 2 then 'a/b c' else 'x=y' end as k from t").unwrap();
    write(&lf, &path, WriteMode::Create, &["k"], false).unwrap();
    let snap = snapshot(&path);
    let mut values: Vec<String> = snap.files.iter().map(|a| a.partition_values["k"].clone().unwrap()).collect();
    values.sort();
    assert_eq!(values, vec!["a/b c", "x=y"]);
    for a in &snap.files {
        assert!(std::path::Path::new(&format!("{path}/{}", a.file_path())).exists(), "{}", a.file_path());
        assert!(!a.path.contains("a/b"), "the slash in the value is escaped: {}", a.path);
    }
}

const ROWS: i64 = 60_000;

fn failing_source(ctx: &SessionContext) {
    let ids: Vec<i64> = (0..ROWS).collect();
    let text: Vec<String> = ids.iter().map(|i| if *i == ROWS - 1 { "oops".to_string() } else { (i % 1000).to_string() }).collect();
    let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, false), Field::new("s", DataType::Utf8, false)]));
    let cols: Vec<ArrayRef> = vec![Arc::new(Int64Array::from(ids)), Arc::new(StringArray::from(text))];
    ctx.register_batches("src", schema.clone(), vec![RecordBatch::try_new(schema, cols).unwrap()]).unwrap();
}

#[test]
fn a_failing_query_changes_nothing() {
    let dir = TempDir::new("dw-fail");
    let path = dir.join("t");
    let ctx = SessionContext::new();
    failing_source(&ctx);
    let good = ctx.sql("select id, cast(s as bigint) as n from src where id < 100").unwrap();
    let bad = ctx.sql("select id, cast(s as bigint) as n from src").unwrap();
    write(&good, &path, WriteMode::Create, &[], false).unwrap();
    let before = files_under(&path);

    for (mode, parts) in [(WriteMode::Append, vec![]), (WriteMode::Overwrite, vec![]), (WriteMode::Replace, vec![]), (WriteMode::Replace, vec!["id"])] {
        let err = write(&bad, &path, mode, &parts, false).unwrap_err().to_string();
        assert!(err.to_lowercase().contains("cast") || err.contains("oops"), "{err}");
        assert_eq!(files_under(&path), before, "{mode:?}: no data file, no commit");
        assert_eq!(snapshot(&path).version, 0);
    }

    // a failing create leaves no table: no files, no log
    let fresh = dir.join("fresh");
    assert!(write(&bad, &fresh, WriteMode::Create, &["id"], false).is_err());
    assert!(files_under(&fresh).is_empty(), "{:?}", files_under(&fresh));
    assert!(Snapshot::load(&log(&fresh), None).is_err());
}

#[test]
fn concurrent_appends_all_commit_at_distinct_versions() {
    let dir = TempDir::new("dw-concurrent");
    let path = dir.join("t");
    let (_ctx, lf) = frame(0..5);
    write(&lf, &path, WriteMode::Create, &[], false).unwrap();
    let threads: Vec<_> = (0..2)
        .map(|t| {
            let path = path.clone();
            std::thread::spawn(move || {
                (0..4)
                    .map(|i| {
                        let (_ctx, lf) = frame(0..3 + t + i);
                        write(&lf, &path, WriteMode::Append, &[], false).unwrap().version
                    })
                    .collect::<Vec<u64>>()
            })
        })
        .collect();
    let mut versions: Vec<u64> = threads.into_iter().flat_map(|h| h.join().unwrap()).collect();
    versions.sort_unstable();
    assert_eq!(versions, (1..=8).collect::<Vec<u64>>());
    let snap = snapshot(&path);
    assert_eq!((snap.version, snap.files.len()), (8, 9));
}

#[test]
fn an_overwrite_conflicts_with_an_append_that_came_first() {
    let dir = TempDir::new("dw-conflict");
    let path = dir.join("t");
    let (_ctx, lf) = frame(0..5);
    write(&lf, &path, WriteMode::Create, &[], false).unwrap();
    let stale = snapshot(&path);
    let (_c2, appended) = frame(5..9);
    write(&appended, &path, WriteMode::Append, &[], false).unwrap();

    let (_c3, over) = frame(0..2);
    let storage = StorageOptions::new();
    let args = WriteArgs { lf: &over, location: &path, storage: &storage, partition_by: &[], merge_schema: false };
    let err = ops::overwrite::overwrite(&args, &log(&path), &stale).unwrap_err();
    assert!(matches!(err, WhError::ConcurrentModification(_)), "{err}");
    assert!(err.to_string().contains("added"), "{err}");
    // the table is as the append left it, and the overwrite's file is gone
    assert_eq!(snapshot(&path).version, 1);
    assert_eq!(data_files(&path).len(), 2);

    // an append that raced an overwrite goes through
    let args = WriteArgs { lf: &appended, location: &path, storage: &storage, partition_by: &[], merge_schema: false };
    let now = snapshot(&path);
    write(&over, &path, WriteMode::Overwrite, &[], false).unwrap();
    let s = ops::append::append(&args, &log(&path), &now).unwrap();
    assert_eq!(s.version, 3);
}

#[test]
fn a_checkpoint_follows_version_ten() {
    let dir = TempDir::new("dw-checkpoint");
    let path = dir.join("t");
    for i in 0..11 {
        let (_ctx, lf) = frame(0..3);
        assert_eq!(write(&lf, &path, WriteMode::Append, &[], false).unwrap().version, i);
    }
    assert!(files_under(&path).contains(&"_delta_log/00000000000000000010.checkpoint.parquet".to_string()));
    let cp = log(&path).read_last_checkpoint().unwrap().unwrap();
    assert_eq!(cp.version, 10);
    let snap = snapshot(&path);
    assert_eq!((snap.version, snap.files.len()), (10, 11));
}

#[test]
fn merge_schema_adds_a_column() {
    let dir = TempDir::new("dw-merge");
    let path = dir.join("t");
    let (ctx, lf1) = frame(0..4);
    write(&lf1, &path, WriteMode::Create, &[], false).unwrap();
    let lf2 = ctx.sql("select id, s, id * 2 as extra from t").unwrap();
    assert!(write(&lf2, &path, WriteMode::Append, &[], false).is_err());
    let s = write(&lf2, &path, WriteMode::Append, &[], true).unwrap();
    assert_eq!(s.version, 1);
    let snap = snapshot(&path);
    let names: Vec<_> = snap.schema.fields().iter().map(|f| f.name().as_str()).collect();
    assert_eq!(names, vec!["id", "g", "s", "extra"]);
    assert!(snap.schema.field(3).is_nullable());
    let actions = commit_actions(&path, 1);
    assert!(actions.iter().any(|a| matches!(a, Action::Metadata(_))), "the commit carries the new schema");
    // the new file has the missing column `g` as nulls and the new one
    let new = snap.files.iter().find(|a| a.file_path() != snapshot_first(&path)).unwrap();
    assert_eq!(parquet_columns(&format!("{path}/{}", new.file_path())), vec!["id", "g", "s", "extra"]);
}

fn snapshot_first(path: &str) -> String {
    Snapshot::load(&log(path), Some(0)).unwrap().files[0].file_path()
}

#[test]
fn types_are_stored_as_delta_knows_them() {
    let dir = TempDir::new("dw-types");
    let path = dir.join("t");
    let ctx = SessionContext::new();
    let schema = Arc::new(Schema::new(vec![
        Field::new("u32", DataType::UInt32, true),
        Field::new("u64", DataType::UInt64, true),
        Field::new("big", DataType::LargeUtf8, true),
        Field::new("ts", DataType::Timestamp(TimeUnit::Nanosecond, None), true),
        Field::new("tz", DataType::Timestamp(TimeUnit::Nanosecond, Some("UTC".into())), true),
    ]));
    let cols: Vec<ArrayRef> = vec![
        Arc::new(UInt32Array::from(vec![1, 4_000_000_000])),
        Arc::new(UInt64Array::from(vec![1, u64::MAX])),
        Arc::new(LargeStringArray::from(vec!["a", "b"])),
        Arc::new(TimestampNanosecondArray::from(vec![1_700_000_000_123_456_789, 0])),
        Arc::new(TimestampNanosecondArray::from(vec![1_700_000_000_123_456_789, 0]).with_timezone("UTC")),
    ];
    ctx.register_batches("t", schema.clone(), vec![RecordBatch::try_new(schema, cols).unwrap()]).unwrap();
    let lf = ctx.sql("select * from t").unwrap();
    write(&lf, &path, WriteMode::Create, &[], false).unwrap();
    let snap = snapshot(&path);
    let types: Vec<DataType> = snap.schema.fields().iter().map(|f| f.data_type().clone()).collect();
    assert_eq!(
        types,
        vec![
            DataType::Int64,
            DataType::Decimal128(20, 0),
            DataType::Utf8,
            DataType::Timestamp(TimeUnit::Microsecond, None),
            DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into())),
        ]
    );
    assert_eq!((snap.protocol.min_reader_version, snap.protocol.min_writer_version), (3, 7), "timestamp_ntz needs table features");
    // the file holds exactly those types
    let f = std::fs::File::open(format!("{path}/{}", snap.files[0].file_path())).unwrap();
    let b = parquet::arrow::arrow_reader::ParquetRecordBatchReaderBuilder::try_new(f).unwrap();
    let file_types: Vec<DataType> = b.schema().fields().iter().map(|f| f.data_type().clone()).collect();
    assert_eq!(file_types, types);
}

#[test]
fn an_empty_table_from_a_schema() {
    let dir = TempDir::new("dw-empty");
    let path = dir.join("t");
    let s = ops::create::create_empty(&path, &StorageOptions::new(), &schema(), &["g".to_string()]).unwrap();
    assert_eq!((s.version, s.files), (0, 0));
    let snap = snapshot(&path);
    assert!(snap.files.is_empty());
    assert_eq!(snap.partition_columns, vec!["g".to_string()]);
    assert_eq!(snap.schema.fields().len(), 3);
    assert!(ops::create::create_empty(&path, &StorageOptions::new(), &schema(), &[]).is_err());
    // rows can follow
    let (_ctx, lf) = frame(0..9);
    assert_eq!(write(&lf, &path, WriteMode::Append, &[], false).unwrap().version, 1);
}

#[test]
fn a_query_without_rows_makes_an_empty_table() {
    let dir = TempDir::new("dw-norows");
    let path = dir.join("t");
    let (ctx, _lf) = frame(0..3);
    let none = ctx.sql("select * from t where id < 0").unwrap();
    let s = write(&none, &path, WriteMode::Create, &["g"], false).unwrap();
    assert_eq!((s.version, s.files, s.rows), (0, 0, 0));
    assert!(data_files(&path).is_empty());
    let s = write(&none, &path, WriteMode::Append, &[], false).unwrap();
    assert!(s.skipped, "an append of no rows makes no version");
    assert_eq!(snapshot(&path).version, 0);
}
