//! Maintaining Delta tables: history, detail, OPTIMIZE, VACUUM, RESTORE and
//! ALTER. Tables are built with `write_table`; the log is read back through
//! `Snapshot` and the commit files.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use arrow::array::{Array, ArrayRef, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use iara_core::delta::ops::alter::{add_columns, rename_column, set_comment, set_properties, unset_properties};
use iara_core::delta::ops::detail::{detail, detail_batch};
use iara_core::delta::ops::history::{history, history_batch};
use iara_core::delta::ops::optimize::optimize;
use iara_core::delta::ops::restore::restore;
use iara_core::delta::ops::vacuum::{vacuum, vacuum_as_of};
use iara_core::delta::{Action, Add, LogStore, Remove, Snapshot, Transaction, VersionSpec, WriteMode, parse_commit, write_table};
use iara_core::io::StorageOptions;
use iara_core::{LazyFrame, Scalar, SessionContext, WhError, col, lit};

use crate::support::dir::{TempDir, files_under};
use crate::support::rows_in;

const DAY_MS: i64 = 24 * 3600 * 1000;

fn schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("g", DataType::Int64, true),
        Field::new("s", DataType::Utf8, true),
    ]))
}

/// The rows with these ids: g = id % 3, s = 's<id>'.
fn frame(ids: std::ops::Range<i64>) -> (SessionContext, LazyFrame) {
    let ids: Vec<i64> = ids.collect();
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(ids.clone())),
        Arc::new(Int64Array::from(ids.iter().map(|i| Some(i % 3)).collect::<Vec<_>>())),
        Arc::new(StringArray::from(ids.iter().map(|i| format!("s{i}")).collect::<Vec<_>>())),
    ];
    let ctx = SessionContext::new();
    ctx.register_batches("t", schema(), vec![RecordBatch::try_new(schema(), cols).unwrap()]).unwrap();
    let lf = ctx.sql("select * from t").unwrap();
    (ctx, lf)
}

fn storage() -> StorageOptions {
    StorageOptions::new()
}

fn write(path: &str, ids: std::ops::Range<i64>, mode: WriteMode, partition_by: &[&str]) -> u64 {
    let (_ctx, lf) = frame(ids);
    let parts: Vec<String> = partition_by.iter().map(|s| s.to_string()).collect();
    write_table(&lf, path, &storage(), mode, &parts, false).unwrap().version
}

fn log(path: &str) -> LogStore {
    LogStore::open(path, &storage()).unwrap()
}

fn snapshot(path: &str) -> Snapshot {
    Snapshot::load(&log(path), None).unwrap()
}

fn commit_actions(path: &str, version: u64) -> Vec<Action> {
    parse_commit(&std::fs::read(format!("{path}/_delta_log/{version:020}.json")).unwrap()).unwrap()
}

/// The rows `id,g,s` of the table at a version (the newest if `None`), ordered by id.
fn content(path: &str, version: Option<u64>) -> String {
    let ctx = SessionContext::new();
    ctx.register_delta("d", path, &storage(), version.map(VersionSpec::Version), false).unwrap();
    rows_in(&ctx, "select id, g, s from d order by id")
}

fn data_files(path: &str) -> Vec<String> {
    files_under(path).into_iter().filter(|f| f.ends_with(".parquet")).collect()
}

fn set_mtime(path: &str, time: SystemTime) {
    std::fs::OpenOptions::new().write(true).open(path).unwrap().set_modified(time).unwrap();
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap().as_millis() as i64
}

fn strings(b: &RecordBatch, column: &str) -> Vec<Option<String>> {
    let a = b.column_by_name(column).unwrap().as_any().downcast_ref::<StringArray>().unwrap();
    (0..a.len()).map(|i| a.is_valid(i).then(|| a.value(i).to_string())).collect()
}

/// A table of many small files: one create and `appends` appends of 5 rows each.
fn small_files(dir: &TempDir, appends: i64, partition_by: &[&str]) -> String {
    let path = dir.join("t");
    write(&path, 0..5, WriteMode::Create, partition_by);
    for i in 1..=appends {
        write(&path, i * 5..i * 5 + 5, WriteMode::Append, partition_by);
    }
    path
}

#[test]
fn history_is_newest_first_with_the_commit_info() {
    let dir = TempDir::new("dm-history");
    let path = dir.join("t");
    write(&path, 0..10, WriteMode::Create, &[]);
    write(&path, 10..20, WriteMode::Append, &[]);
    write(&path, 0..3, WriteMode::Overwrite, &[]);

    let h = history(&path, &storage(), None).unwrap();
    assert_eq!(h.iter().map(|e| e.version).collect::<Vec<_>>(), vec![2, 1, 0]);
    assert_eq!(h.iter().map(|e| e.operation.as_deref().unwrap()).collect::<Vec<_>>(), vec!["WRITE", "WRITE", "CREATE TABLE AS SELECT"]);
    assert_eq!(h[0].operation_parameters["mode"], "Overwrite");
    assert_eq!(h[1].operation_parameters["mode"], "Append");
    assert!(h[1].is_blind_append && !h[0].is_blind_append);
    assert_eq!(h[2].operation_metrics["numOutputRows"], "10");
    assert!(h[0].engine_info.as_deref().unwrap().starts_with("iara/"));
    assert!(h[0].timestamp_ms >= h[1].timestamp_ms && h[1].timestamp_ms >= h[2].timestamp_ms && h[2].timestamp_ms > 0);

    let two = history(&path, &storage(), Some(2)).unwrap();
    assert_eq!(two.iter().map(|e| e.version).collect::<Vec<_>>(), vec![2, 1]);

    let b = history_batch(&path, &storage(), None).unwrap();
    assert_eq!(b.schema().fields().iter().map(|f| f.name().as_str()).collect::<Vec<_>>(), vec![
        "version",
        "timestamp",
        "operation",
        "operation_parameters",
        "operation_metrics",
        "engine_info"
    ]);
    assert_eq!(b.num_rows(), 3);
    let versions = b.column(0).as_any().downcast_ref::<Int64Array>().unwrap();
    assert_eq!(versions.values().to_vec(), vec![2, 1, 0]);
    assert_eq!(strings(&b, "operation")[0].as_deref(), Some("WRITE"));
    let params: serde_json::Value = serde_json::from_str(strings(&b, "operation_parameters")[0].as_deref().unwrap()).unwrap();
    assert_eq!(params["mode"], "Overwrite");
}

#[test]
fn history_skips_versions_whose_commit_file_is_gone() {
    let dir = TempDir::new("dm-history-gone");
    let path = small_files(&dir, 11, &[]);
    // a checkpoint at version 10 covers the early commits
    assert!(files_under(&path).iter().any(|f| f.contains("checkpoint.parquet")));
    for v in 0..=3u64 {
        std::fs::remove_file(format!("{path}/_delta_log/{v:020}.json")).unwrap();
    }
    let h = history(&path, &storage(), None).unwrap();
    assert_eq!(h.iter().map(|e| e.version).collect::<Vec<_>>(), (4..=11).rev().collect::<Vec<_>>());
}

#[test]
fn detail_describes_the_table() {
    let dir = TempDir::new("dm-detail");
    let path = small_files(&dir, 2, &["g"]);
    set_properties(&path, &storage(), &BTreeMap::from([("owner".to_string(), "me".to_string())])).unwrap();
    set_comment(&path, &storage(), Some("events")).unwrap();
    let s = snapshot(&path);
    let d = detail(&path, &storage()).unwrap();
    assert_eq!(d.format, "delta");
    assert_eq!(d.id, s.metadata.id);
    assert_eq!(d.id.len(), 36);
    assert_eq!(d.location, path);
    assert_eq!(d.description.as_deref(), Some("events"));
    assert_eq!(d.partition_columns, vec!["g".to_string()]);
    assert_eq!(d.num_files, s.files.len() as u64);
    assert_eq!(d.size_in_bytes, s.files.iter().map(|a| a.size as u64).sum::<u64>());
    assert_eq!(d.properties["owner"], "me");
    assert_eq!((d.min_reader_version, d.min_writer_version), (1, 2));
    assert_eq!(d.version, s.version);
    assert!(d.created_at.unwrap() > 0 && d.last_modified >= d.created_at.unwrap());

    let b = detail_batch(&path, &storage()).unwrap();
    assert_eq!(b.num_rows(), 1);
    assert_eq!(
        b.schema().fields().iter().map(|f| f.name().as_str()).collect::<Vec<_>>(),
        vec![
            "format",
            "id",
            "name",
            "description",
            "location",
            "createdAt",
            "lastModified",
            "version",
            "partitionColumns",
            "numFiles",
            "sizeInBytes",
            "properties",
            "minReaderVersion",
            "minWriterVersion"
        ]
    );
    assert_eq!(strings(&b, "format")[0].as_deref(), Some("delta"));
    assert_eq!(strings(&b, "description")[0].as_deref(), Some("events"));
    assert_eq!(b.column_by_name("numFiles").unwrap().as_any().downcast_ref::<Int64Array>().unwrap().value(0), d.num_files as i64);
}

#[test]
fn optimize_compacts_small_files_without_changing_rows() {
    let dir = TempDir::new("dm-optimize");
    let path = small_files(&dir, 10, &[]);
    let before_version = snapshot(&path).version;
    assert_eq!(snapshot(&path).files.len(), 11);
    let before = content(&path, None);
    let old_files = data_files(&path);

    let ctx = SessionContext::new();
    let r = optimize(&ctx, &path, &storage(), None, None).unwrap();
    assert!(!r.skipped);
    assert_eq!((r.files_removed, r.files_added, r.partitions_optimized), (11, 1, 1));
    assert_eq!(r.version, before_version + 1);

    let s = snapshot(&path);
    assert_eq!(s.files.len(), 1);
    assert_eq!(s.files[0].size as u64, r.bytes_added);
    assert!(s.files[0].stats.as_deref().unwrap().contains("\"numRecords\":55"));
    assert_eq!(content(&path, None), before);
    // time travel to the version before still works: the old files stay
    assert_eq!(content(&path, Some(before_version)), before);
    assert_eq!(data_files(&path).len(), old_files.len() + 1);

    let actions = commit_actions(&path, r.version);
    let Action::CommitInfo(info) = &actions[0] else { panic!("commitInfo first") };
    assert_eq!(info.operation(), Some("OPTIMIZE"));
    assert_eq!(info.metric("numFilesRemoved"), Some(11));
    assert_eq!(info.metric("numFilesAdded"), Some(1));
    assert_eq!(info.0["isBlindAppend"], false);
    let adds: Vec<&Add> = actions.iter().filter_map(|a| if let Action::Add(a) = a { Some(a) } else { None }).collect();
    let removes: Vec<&Remove> = actions.iter().filter_map(|a| if let Action::Remove(r) = a { Some(r) } else { None }).collect();
    assert_eq!((adds.len(), removes.len()), (1, 11));
    assert!(adds.iter().all(|a| !a.data_change) && removes.iter().all(|r| !r.data_change));

    // nothing left to combine: no commit
    let again = optimize(&ctx, &path, &storage(), None, None).unwrap();
    assert!(again.skipped);
    assert_eq!(again.version, r.version);
    assert_eq!(snapshot(&path).version, r.version);
}

#[test]
fn optimize_packs_files_up_to_the_target_size() {
    let dir = TempDir::new("dm-optimize-bins");
    let path = small_files(&dir, 11, &[]);
    let before = content(&path, None);
    let biggest = snapshot(&path).files.iter().map(|a| a.size as u64).max().unwrap();
    let ctx = SessionContext::new();
    // room for at most a few files per bin
    let r = optimize(&ctx, &path, &storage(), Some(biggest * 4 + 1), None).unwrap();
    assert_eq!(r.files_removed, 12);
    assert!(r.files_added >= 2 && r.files_added <= 6, "{r:?}");
    assert_eq!(snapshot(&path).files.len(), r.files_added);
    assert_eq!(content(&path, None), before);

    // a file already at the target is left alone, and so is a single small one
    let sizes: Vec<u64> = snapshot(&path).files.iter().map(|a| a.size as u64).collect();
    let r = optimize(&ctx, &path, &storage(), Some(*sizes.iter().min().unwrap()), None).unwrap();
    assert!(r.skipped);
    assert!(matches!(optimize(&ctx, &path, &storage(), Some(0), None), Err(WhError::Plan(_))));
}

#[test]
fn optimize_only_the_partitions_the_predicate_selects() {
    let dir = TempDir::new("dm-optimize-partitions");
    let path = small_files(&dir, 3, &["g"]);
    let before = content(&path, None);
    let s = snapshot(&path);
    let in_partition = |g: &str, s: &Snapshot| s.files.iter().filter(|a| a.partition_values["g"].as_deref() == Some(g)).count();
    assert_eq!((in_partition("0", &s), in_partition("1", &s), in_partition("2", &s)), (4, 4, 4));

    let ctx = SessionContext::new();
    let r = optimize(&ctx, &path, &storage(), None, Some(&col("g").eq(lit(Scalar::int64(1))))).unwrap();
    assert_eq!((r.files_removed, r.files_added, r.partitions_optimized), (4, 1, 1));
    let s = snapshot(&path);
    assert_eq!((in_partition("0", &s), in_partition("1", &s), in_partition("2", &s)), (4, 1, 4));
    assert_eq!(content(&path, None), before);
    assert!(s.files.iter().filter(|a| a.partition_values["g"].as_deref() == Some("1")).all(|a| a.file_path().starts_with("g=1/")));

    // the rest, by a predicate that selects two partitions
    let r = optimize(&ctx, &path, &storage(), None, Some(&col("g").lt(lit(Scalar::int64(2))))).unwrap();
    assert_eq!((r.files_removed, r.files_added, r.partitions_optimized), (4, 1, 1), "g=1 has one file left");
    // and without a predicate, partition 2
    let r = optimize(&ctx, &path, &storage(), None, None).unwrap();
    assert_eq!((r.files_removed, r.files_added, r.partitions_optimized), (4, 1, 1));
    assert_eq!(snapshot(&path).files.len(), 3);
    assert_eq!(content(&path, None), before);

    // only partition columns, and only on a partitioned table
    let err = optimize(&ctx, &path, &storage(), None, Some(&col("id").eq(lit(Scalar::int64(1))))).unwrap_err();
    assert!(err.to_string().contains("partition columns"), "{err}");
    let flat = TempDir::new("dm-optimize-flat");
    let flat_path = small_files(&flat, 2, &[]);
    assert!(optimize(&ctx, &flat_path, &storage(), None, Some(&col("g").eq(lit(Scalar::int64(1))))).is_err());
}

#[test]
fn optimize_conflicts_with_removals_but_not_with_blind_appends() {
    let dir = TempDir::new("dm-optimize-conflicts");
    let path = small_files(&dir, 3, &[]);
    let s = snapshot(&path);
    let compaction = |read: u64| {
        let mut t = Transaction::new(Some(read), "OPTIMIZE");
        t.extend(s.files.iter().take(2).map(|a| Action::Remove(Remove::of(a, now_ms(), false))));
        let mut add = s.files[2].clone();
        add.path = "compacted.parquet".into();
        add.data_change = false;
        t.push(Action::Add(add));
        t
    };
    // a blind append meanwhile is no conflict
    write(&path, 100..105, WriteMode::Append, &[]);
    compaction(s.version).commit(&log(&path)).unwrap();
    // but a commit that removed a file it compacts is
    let s2 = snapshot(&path);
    let mut other = Transaction::new(Some(s2.version), "DELETE");
    other.push(Action::Remove(Remove::of(&s2.files[0], now_ms(), true)));
    let victim = s2.files[0].clone();
    let mut rival = Transaction::new(Some(s2.version), "OPTIMIZE");
    rival.push(Action::Remove(Remove::of(&victim, now_ms(), false)));
    other.commit(&log(&path)).unwrap();
    assert!(matches!(rival.commit(&log(&path)), Err(WhError::ConcurrentModification(_))));
}

/// A table with version 0 (ids 0..10), 1 (+10..20) and 2 (overwritten by 100..105),
/// each committed in a later millisecond than the one before, so every version
/// can be found by its commit time.
fn vacuum_table(dir: &TempDir) -> String {
    let path = dir.join("t");
    let v0 = write(&path, 0..10, WriteMode::Create, &[]);
    wait_past_commit(&path, v0);
    let v1 = write(&path, 10..20, WriteMode::Append, &[]);
    wait_past_commit(&path, v1);
    write(&path, 100..105, WriteMode::Overwrite, &[]);
    path
}

/// Wait until the clock is past the commit time of `version`, so the next commit
/// gets a later time. Quick writes can share a millisecond, and time travel to
/// that time gives the newest of them.
fn wait_past_commit(path: &str, version: u64) {
    let committed = snapshot_at(path, version).timestamp;
    while now_ms() <= committed {
        std::thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn vacuum_lists_only_old_unreferenced_files() {
    let dir = TempDir::new("dm-vacuum");
    let path = vacuum_table(&dir);
    let current: Vec<String> = snapshot(&path).files.iter().map(|a| a.file_path()).collect();
    let removed: Vec<String> = data_files(&path).into_iter().filter(|f| !current.contains(f)).collect();
    assert_eq!(removed.len(), 2);
    std::fs::write(format!("{path}/orphan.parquet"), b"junk").unwrap();
    std::fs::create_dir_all(format!("{path}/_hidden")).unwrap();
    std::fs::write(format!("{path}/_hidden/x.parquet"), b"junk").unwrap();
    std::fs::write(format!("{path}/.part.crc"), b"junk").unwrap();
    let long_ago = SystemTime::now() - Duration::from_secs(40 * 24 * 3600);
    for f in ["orphan.parquet", "_hidden/x.parquet", ".part.crc"] {
        set_mtime(&format!("{path}/{f}"), long_ago);
    }
    // old files, but removed just now: kept (a removed file counts from its deletion time)
    for f in &removed {
        set_mtime(&format!("{path}/{f}"), long_ago);
    }

    // only the orphan is old enough by its modification time
    let r = vacuum(&path, &storage(), None, true, false).unwrap();
    assert!(r.dry_run);
    assert_eq!(r.files, vec!["orphan.parquet".to_string()]);
    assert_eq!(r.bytes, 4);
    assert!(std::path::Path::new(&format!("{path}/orphan.parquet")).exists(), "a dry run deletes nothing");

    // a week and a day later the removed files are old as well; current ones, the log and hidden files never
    let later = now_ms() + 8 * DAY_MS;
    let r = vacuum_as_of(&path, &storage(), None, true, false, later).unwrap();
    let mut expected: Vec<String> = removed.clone();
    expected.push("orphan.parquet".into());
    expected.sort();
    assert_eq!(r.files, expected);
    assert!(current.iter().all(|c| !r.files.contains(c)));

    // a shorter retention needs a flag
    let err = vacuum(&path, &storage(), Some(1.0), true, false).unwrap_err();
    assert!(err.to_string().contains("retention shorter than 7 days could break time travel and concurrent readers"), "{err}");
    assert!(vacuum(&path, &storage(), Some(-1.0), true, true).is_err());
    // with the flag one hour is enough for the orphan, the removed files were removed just now
    let r = vacuum(&path, &storage(), Some(1.0), true, true).unwrap();
    assert_eq!(r.files, vec!["orphan.parquet".to_string()]);
}

#[test]
fn vacuum_deletes_and_the_table_still_reads() {
    let dir = TempDir::new("dm-vacuum-delete");
    let path = vacuum_table(&dir);
    let current_content = content(&path, None);
    let before_all = data_files(&path).len();
    let later = now_ms() + 8 * DAY_MS;
    let r = vacuum_as_of(&path, &storage(), None, false, false, later).unwrap();
    assert!(!r.dry_run);
    assert_eq!(r.files.len(), 2);
    assert!(r.bytes > 0);
    assert_eq!(data_files(&path).len(), before_all - 2);
    assert_eq!(content(&path, None), current_content);
    assert!(files_under(&path).iter().any(|f| f.starts_with("_delta_log/")));
    // the old versions lost their files
    let ctx = SessionContext::new();
    let old = ctx.register_delta("old", &path, &storage(), Some(VersionSpec::Version(0)), false).and_then(|_| ctx.sql("select count(*) from old")?.collect());
    assert!(old.is_err());
    // nothing more to do
    assert!(vacuum_as_of(&path, &storage(), None, false, false, later).unwrap().files.is_empty());
}

#[test]
fn vacuum_removes_empty_partition_folders() {
    let dir = TempDir::new("dm-vacuum-partitions");
    let path = dir.join("t");
    write(&path, 0..9, WriteMode::Create, &["g"]);
    write(&path, 100..101, WriteMode::Overwrite, &["g"]);
    let later = now_ms() + 8 * DAY_MS;
    let r = vacuum_as_of(&path, &storage(), None, false, false, later).unwrap();
    assert_eq!(r.files.len(), 3);
    let folders: Vec<String> = files_under(&path).iter().filter_map(|f| f.split('/').next().filter(|d| d.starts_with("g=")).map(str::to_string)).collect();
    assert_eq!(folders.len(), 1, "{folders:?}");
    assert!(!std::path::Path::new(&format!("{path}/g=0")).exists() || folders[0] == "g=0");
}

#[test]
fn restore_goes_back_to_an_older_version() {
    let dir = TempDir::new("dm-restore");
    let path = vacuum_table(&dir);
    let v0 = content(&path, Some(0));
    let v1 = content(&path, Some(1));
    assert_ne!(v0, v1);

    let r = restore(&path, &storage(), VersionSpec::Version(0)).unwrap();
    assert!(!r.skipped);
    assert_eq!((r.version, r.restored_version, r.files_removed, r.files_restored), (3, 0, 1, 1));
    assert_eq!(content(&path, None), v0);
    let actions = commit_actions(&path, 3);
    let Action::CommitInfo(info) = &actions[0] else { panic!() };
    assert_eq!(info.operation(), Some("RESTORE"));
    assert_eq!(info.operation_parameters().unwrap()["version"], 0);
    assert_eq!(info.metric("numRestoredFiles"), Some(1));
    assert_eq!(info.metric("numOfFilesAfterRestore"), Some(1));
    assert!(actions.iter().filter_map(|a| if let Action::Add(a) = a { Some(a) } else { None }).all(|a| a.data_change));
    // the history keeps everything, and every version still reads as it did
    assert_eq!(content(&path, Some(1)), v1);
    assert_eq!(history(&path, &storage(), Some(1)).unwrap()[0].operation.as_deref(), Some("RESTORE"));

    // by time: the commit time of version 1, which version 2 came after
    let t1 = snapshot_at(&path, 1).timestamp;
    assert!(t1 < snapshot_at(&path, 2).timestamp);
    let r = restore(&path, &storage(), VersionSpec::Timestamp(t1)).unwrap();
    assert_eq!((r.version, r.restored_version), (4, 1));
    assert_eq!(content(&path, None), v1);

    // already there
    let r = restore(&path, &storage(), VersionSpec::Version(1)).unwrap();
    assert!(r.skipped);
    assert_eq!(r.version, 4);
    assert!(restore(&path, &storage(), VersionSpec::Version(99)).is_err());
}

fn snapshot_at(path: &str, version: u64) -> Snapshot {
    Snapshot::load(&log(path), Some(version)).unwrap()
}

#[test]
fn restore_after_vacuum_fails_cleanly() {
    let dir = TempDir::new("dm-restore-vacuum");
    let path = vacuum_table(&dir);
    vacuum_as_of(&path, &storage(), None, false, false, now_ms() + 8 * DAY_MS).unwrap();
    let before = snapshot(&path).version;
    let err = restore(&path, &storage(), VersionSpec::Version(0)).unwrap_err();
    assert!(err.to_string().contains("no longer exists"), "{err}");
    assert_eq!(snapshot(&path).version, before, "no commit was made");
    // the current version restores to itself
    assert!(restore(&path, &storage(), VersionSpec::Version(before)).unwrap().skipped);
}

#[test]
fn restore_brings_the_schema_back() {
    let dir = TempDir::new("dm-restore-schema");
    let path = dir.join("t");
    write(&path, 0..5, WriteMode::Create, &[]);
    add_columns(&path, &storage(), vec![Field::new("extra", DataType::Utf8, true)]).unwrap();
    assert_eq!(snapshot(&path).schema.fields().len(), 4);
    let r = restore(&path, &storage(), VersionSpec::Version(0)).unwrap();
    assert_eq!((r.files_removed, r.files_restored), (0, 0));
    assert!(!r.skipped);
    assert_eq!(snapshot(&path).schema.fields().len(), 3);
    assert_eq!(content(&path, None).split('|').count(), 5);
}

#[test]
fn added_columns_read_as_null_in_old_files() {
    let dir = TempDir::new("dm-add-columns");
    let path = dir.join("t");
    write(&path, 0..3, WriteMode::Create, &[]);
    let v = add_columns(&path, &storage(), vec![Field::new("extra", DataType::Utf8, false), Field::new("n", DataType::UInt8, true)]).unwrap();
    assert_eq!(v, 1);

    let s = snapshot(&path);
    let names: Vec<_> = s.schema.fields().iter().map(|f| f.name().clone()).collect();
    assert_eq!(names, vec!["id", "g", "s", "extra", "n"]);
    assert!(s.schema.field_with_name("extra").unwrap().is_nullable(), "new columns are nullable");
    assert_eq!(s.schema.field_with_name("n").unwrap().data_type(), &DataType::Int16, "types are Delta's");
    assert_eq!(s.metadata.id.len(), 36);

    let ctx = SessionContext::new();
    ctx.register_delta("d", &path, &storage(), None, false).unwrap();
    assert_eq!(rows_in(&ctx, "select id, extra, n from d order by id"), "0,null,null|1,null,null|2,null,null");
    // old versions keep their schema
    let old = SessionContext::new();
    old.register_delta("d", &path, &storage(), Some(VersionSpec::Version(0)), false).unwrap();
    assert!(old.sql("select extra from d").is_err());

    // new rows can fill the column
    let (ctx2, _) = frame(10..12);
    let with_extra = ctx2.sql("select id, g, s, 'x' as extra from t").unwrap();
    write_table(&with_extra, &path, &storage(), WriteMode::Append, &[], false).unwrap();
    let fresh = SessionContext::new();
    fresh.register_delta("d", &path, &storage(), None, false).unwrap();
    assert_eq!(rows_in(&fresh, "select id, extra from d where id >= 2 order by id"), "2,null|10,x|11,x");

    let info = history(&path, &storage(), Some(2)).unwrap();
    assert_eq!(info[1].operation.as_deref(), Some("ADD COLUMNS"));
    assert!(info[1].operation_parameters["columns"].contains("extra"));

    assert!(matches!(add_columns(&path, &storage(), vec![Field::new("EXTRA", DataType::Int64, true)]), Err(WhError::Plan(_))));
    assert!(matches!(add_columns(&path, &storage(), vec![]), Err(WhError::Plan(_))));
}

#[test]
fn rename_column_needs_column_mapping() {
    let dir = TempDir::new("dm-rename");
    let path = dir.join("t");
    write(&path, 0..3, WriteMode::Create, &[]);
    let err = rename_column(&path, &storage(), "s", "name").unwrap_err();
    assert!(matches!(err, WhError::NotSupported(_)), "{err}");
    assert!(err.to_string().contains("column mapping"), "{err}");
    assert!(matches!(rename_column(&path, &storage(), "nope", "x"), Err(WhError::ColumnNotFound(_))));
    assert_eq!(snapshot(&path).version, 0);
}

#[test]
fn properties_and_comment_are_metadata_commits() {
    let dir = TempDir::new("dm-properties");
    let path = dir.join("t");
    write(&path, 0..3, WriteMode::Create, &[]);
    let props = BTreeMap::from([("delta.logRetentionDuration".to_string(), "interval 30 days".to_string()), ("team".to_string(), "data".to_string())]);
    assert_eq!(set_properties(&path, &storage(), &props).unwrap(), 1);
    let s = snapshot(&path);
    assert_eq!(s.metadata.configuration, props);
    assert_eq!(s.files.len(), 1, "no data file changes");
    assert_eq!(commit_actions(&path, 1).iter().filter(|a| matches!(a, Action::Add(_) | Action::Remove(_))).count(), 0);
    assert_eq!(history(&path, &storage(), Some(1)).unwrap()[0].operation.as_deref(), Some("SET TBLPROPERTIES"));
    // nothing new: no commit
    assert_eq!(set_properties(&path, &storage(), &props).unwrap(), 1);

    assert_eq!(unset_properties(&path, &storage(), &["team".to_string()], false).unwrap(), 2);
    assert!(!snapshot(&path).metadata.configuration.contains_key("team"));
    assert!(unset_properties(&path, &storage(), &["team".to_string()], false).is_err());
    assert_eq!(unset_properties(&path, &storage(), &["team".to_string()], true).unwrap(), 2);

    assert_eq!(set_comment(&path, &storage(), Some("my table")).unwrap(), 3);
    assert_eq!(snapshot(&path).metadata.description.as_deref(), Some("my table"));
    assert_eq!(set_comment(&path, &storage(), None).unwrap(), 4);
    assert_eq!(snapshot(&path).metadata.description, None);
    assert_eq!(snapshot(&path).metadata.configuration.len(), 1, "the other properties stay");
    assert!(set_properties(&path, &storage(), &BTreeMap::new()).is_err());
    assert_eq!(content(&path, None).split('|').count(), 3);
}
