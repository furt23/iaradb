//! Writes are all-or-nothing: a query that fails while its result is being
//! written keeps what was there before and leaves no partial files, and a
//! replacement deletes the old files only after the new ones are in place.

use std::sync::Arc;

use arrow::array::{ArrayRef, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use iara_core::SessionContext;
use iara_core::io::csv::CsvSink;
use iara_core::io::dataset;
use iara_core::io::parquet::{DatasetSink, ParquetOptions, write_parquet};

use crate::support::dir::{TempDir, dirs_under, files_under};

const ROWS: i64 = 60_000;

fn schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("g", DataType::Int64, false),
        Field::new("s", DataType::Utf8, false),
    ]))
}

/// `src`: ROWS rows (g = id % 4); `s` holds a number, except in the last row.
fn source(ctx: &SessionContext) {
    let ids: Vec<i64> = (0..ROWS).collect();
    let text: Vec<String> = ids.iter().map(|i| if *i == ROWS - 1 { "oops".to_string() } else { (i % 1000).to_string() }).collect();
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(ids.clone())),
        Arc::new(Int64Array::from(ids.iter().map(|i| i % 4).collect::<Vec<_>>())),
        Arc::new(StringArray::from(text)),
    ];
    ctx.register_batches("src", schema(), vec![RecordBatch::try_new(schema(), cols).unwrap()]).unwrap();
}

/// A query that runs until its last row, which cannot be cast.
const FAILING: &str = "select id, g, cast(s as bigint) as n from src";
const GOOD: &str = "select id, g, cast(s as bigint) as n from src where id < 100";

fn run(ctx: &SessionContext, q: &str) -> String {
    let (_, batches) = ctx.sql(q).unwrap().collect().unwrap();
    arrow::util::display::array_value_to_string(batches[0].column(0), 0).unwrap()
}

fn fails(ctx: &SessionContext, q: &str) -> String {
    match ctx.sql(q).and_then(|lf| lf.collect()) {
        Ok(_) => panic!("{q} should fail"),
        Err(e) => e.to_string(),
    }
}

/// What a fresh session reads from `path`: rows and the sum of `n`.
fn read_back(path: &str) -> String {
    let ctx = SessionContext::new();
    ctx.register_parquet("t", path).unwrap();
    let (_, b) = ctx.sql("select count(*), sum(n) from t").unwrap().collect().unwrap();
    let cell = |c: usize| arrow::util::display::array_value_to_string(b[0].column(c), 0).unwrap();
    format!("{}/{}", cell(0), cell(1))
}

fn no_leftovers(root: &str) {
    let leftovers: Vec<_> = files_under(root).into_iter().filter(|f| f.contains(".tmp-")).collect();
    assert!(leftovers.is_empty(), "temporary files left: {leftovers:?}");
}

const OLD: &str = "100/4950";

#[test]
fn create_or_replace_that_fails_keeps_the_old_table() {
    let dir = TempDir::new("safe-create");
    let ctx = SessionContext::new();
    source(&ctx);
    ctx.set_warehouse(Some(&dir.join("wh")), &Default::default());
    run(&ctx, &format!("create table t using parquet as {GOOD}"));
    let table = dir.join("wh/t");
    let before = files_under(&table);
    assert_eq!(before.len(), 1);
    assert_eq!(read_back(&table), OLD);

    let err = fails(&ctx, &format!("create or replace table t using parquet as {FAILING}"));
    assert!(err.to_lowercase().contains("cast") || err.contains("oops"), "{err}");

    assert_eq!(files_under(&table), before, "the old file stays, nothing else appears");
    assert_eq!(read_back(&table), OLD);
    // the session's table still reads the old rows
    assert_eq!(run(&ctx, "select count(*) from t"), "100");
}

#[test]
fn create_or_replace_partitioned_that_fails_keeps_the_old_table() {
    let dir = TempDir::new("safe-create-part");
    let ctx = SessionContext::new();
    source(&ctx);
    ctx.set_warehouse(Some(&dir.join("wh")), &Default::default());
    run(&ctx, &format!("create table t using parquet partitioned by (g) as {GOOD}"));
    let table = dir.join("wh/t");
    let before = files_under(&table);
    assert_eq!(before.len(), 4);
    let dirs = dirs_under(&table);

    fails(&ctx, &format!("create or replace table t using parquet partitioned by (g) as {FAILING}"));
    assert_eq!(files_under(&table), before);
    assert_eq!(dirs_under(&table), dirs, "no empty partition folders either");
    assert_eq!(read_back(&table), OLD);
}

#[test]
fn successful_replace_deletes_only_the_old_files() {
    let dir = TempDir::new("safe-replace");
    let ctx = SessionContext::new();
    source(&ctx);
    ctx.set_warehouse(Some(&dir.join("wh")), &Default::default());
    run(&ctx, &format!("create table t using parquet partitioned by (g) as {GOOD}"));
    let table = dir.join("wh/t");
    let before = files_under(&table);

    run(&ctx, "create or replace table t using parquet partitioned by (g) as select id, g, cast(s as bigint) as n from src where id < 200");
    let after = files_under(&table);
    assert_eq!(after.len(), 4);
    assert!(after.iter().all(|f| !before.contains(f)), "{before:?} -> {after:?}");
    no_leftovers(&table);
    assert_eq!(run(&ctx, "select count(*) from t"), "200");
    assert_eq!(read_back(&table), "200/19900");

    // a replacement with fewer partitions leaves no empty folder of the old ones
    run(&ctx, "create or replace table t using parquet partitioned by (g) as select id, g, cast(s as bigint) as n from src where g = 1 and id < 50");
    assert_eq!(dirs_under(&table), vec!["g=1".to_string()]);
}

#[test]
fn copy_overwrite_that_fails_keeps_the_old_folder() {
    let dir = TempDir::new("safe-copy");
    let ctx = SessionContext::new();
    source(&ctx);
    for (name, options) in [("part", "PARTITION_BY (g)"), ("folder", "FORMAT parquet")] {
        let out = if name == "folder" { format!("{}/", dir.join(name)) } else { dir.join(name) };
        run(&ctx, &format!("copy ({GOOD}) to '{out}' ({options})"));
        let before = files_under(&dir.join(name));
        assert!(!before.is_empty());

        fails(&ctx, &format!("copy ({FAILING}) to '{out}' ({options}, OVERWRITE)"));
        assert_eq!(files_under(&dir.join(name)), before, "{name}");
        assert_eq!(read_back(&dir.join(name)), OLD, "{name}");

        run(&ctx, &format!("copy (select id, g, cast(s as bigint) as n from src where id < 10) to '{out}' ({options}, OVERWRITE)"));
        let after = files_under(&dir.join(name));
        assert!(after.iter().all(|f| !before.contains(f)), "{name}: {before:?} -> {after:?}");
        no_leftovers(&dir.join(name));
        assert_eq!(read_back(&dir.join(name)), "10/45", "{name}");
    }
}

#[test]
fn copy_to_a_file_that_fails_keeps_the_old_file() {
    let dir = TempDir::new("safe-copy-file");
    let ctx = SessionContext::new();
    source(&ctx);
    for ext in ["parquet", "csv", "json"] {
        let out = dir.join(&format!("out.{ext}"));
        run(&ctx, &format!("copy ({GOOD}) to '{out}'"));
        let before = std::fs::read(&out).unwrap();

        fails(&ctx, &format!("copy ({FAILING}) to '{out}'"));
        assert_eq!(std::fs::read(&out).unwrap(), before, "{ext}");
        no_leftovers(&dir.join(""));

        // replacing it works too (on Windows the rename replaces the old file)
        run(&ctx, &format!("copy (select id, g, cast(s as bigint) as n from src where id < 5) to '{out}'"));
        assert_ne!(std::fs::read(&out).unwrap(), before, "{ext}");
        no_leftovers(&dir.join(""));
    }
    assert_eq!(read_back(&dir.join("out.parquet")), "5/10");
    assert_eq!(files_under(&dir.join("")).len(), 3);
}

#[test]
fn failed_copy_to_a_new_path_leaves_nothing() {
    let dir = TempDir::new("safe-copy-new");
    let ctx = SessionContext::new();
    source(&ctx);
    fails(&ctx, &format!("copy ({FAILING}) to '{}'", dir.join("new.parquet")));
    fails(&ctx, &format!("copy ({FAILING}) to '{}' (PARTITION_BY (g))", dir.join("new")));
    fails(&ctx, &format!("copy ({FAILING}) to '{}'", dir.join("new.csv")));
    assert_eq!(files_under(&dir.join("")), Vec::<String>::new());
    assert_eq!(dirs_under(&dir.join("new")), Vec::<String>::new());
}

#[test]
fn a_failed_insert_adds_nothing() {
    let dir = TempDir::new("safe-insert");
    let ctx = SessionContext::new();
    source(&ctx);
    ctx.set_warehouse(Some(&dir.join("wh")), &Default::default());
    run(&ctx, &format!("create table t using parquet partitioned by (g) as {GOOD}"));
    let table = dir.join("wh/t");
    let before = files_under(&table);
    fails(&ctx, &format!("insert into t {FAILING}"));
    assert_eq!(files_under(&table), before);
    assert_eq!(read_back(&table), OLD);
}

fn batch(rows: i64) -> RecordBatch {
    let ids: Vec<i64> = (0..rows).collect();
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(ids.clone())),
        Arc::new(Int64Array::from(ids.iter().map(|i| i % 3).collect::<Vec<_>>())),
        Arc::new(StringArray::from(ids.iter().map(|i| i.to_string()).collect::<Vec<_>>())),
    ];
    RecordBatch::try_new(schema(), cols).unwrap()
}

#[test]
fn a_sink_dropped_unfinished_removes_what_it_wrote() {
    let dir = TempDir::new("safe-drop");
    // one file: written under a temporary name, and the old file stays
    let file = dir.join("one.parquet");
    write_parquet(&file, schema(), &[batch(5)], "zstd", None).unwrap();
    let old = std::fs::read(&file).unwrap();
    let mut sink = DatasetSink::create(&file, schema(), &ParquetOptions::default(), &Default::default()).unwrap();
    sink.write(&batch(1000)).unwrap();
    assert!(files_under(&dir.join("")).iter().any(|f| f.contains(".tmp-")), "written under a temporary name");
    drop(sink);
    assert_eq!(files_under(&dir.join("")), vec!["one.parquet".to_string()]);
    assert_eq!(std::fs::read(&file).unwrap(), old);

    // partitioned: no files and no folders
    let root = dir.join("hive");
    let opts = ParquetOptions { partition_by: vec!["g".into()], ..Default::default() };
    let mut sink = DatasetSink::create(&root, schema(), &opts, &Default::default()).unwrap();
    sink.write(&batch(1000)).unwrap();
    assert_eq!(files_under(&root).len(), 3);
    drop(sink);
    assert!(files_under(&root).is_empty());
    assert!(dirs_under(&root).is_empty());

    // csv
    let csv = dir.join("a.csv");
    let mut sink = CsvSink::create(&csv, true, b',', &Default::default()).unwrap();
    sink.write(&batch(10)).unwrap();
    drop(sink);
    assert!(!std::path::Path::new(&csv).exists());
}

#[test]
fn finished_sinks_report_the_files_on_disk() {
    let dir = TempDir::new("safe-written");
    let ctx = SessionContext::new();
    source(&ctx);

    // partitioned
    let root = dir.join("hive");
    let opts = ParquetOptions { partition_by: vec!["g".into()], ..Default::default() };
    let lf = ctx.sql("select id, g, cast(s as bigint) as n from src where id < 40000").unwrap();
    let written = lf.sink_parquet_files(&root, &opts, &Default::default()).unwrap();
    assert_eq!(written.len(), 4);
    assert_eq!(written.iter().map(|f| f.rows).sum::<u64>(), 40_000);
    let mut paths: Vec<String> = written.iter().map(|f| f.path.trim_start_matches(&format!("{root}/")).to_string()).collect();
    paths.sort();
    assert_eq!(paths, files_under(&root));
    for f in &written {
        assert_eq!(f.size, std::fs::metadata(&f.path).unwrap().len(), "{}", f.path);
        let meta = f.metadata.as_ref().expect("footer");
        assert_eq!(meta.file_metadata().num_rows() as u64, f.rows);
        assert_eq!(f.partition_values.len(), 1);
        let (column, value) = &f.partition_values[0];
        assert_eq!(column, "g");
        assert!(f.path.contains(&format!("g={}", value.as_deref().unwrap())), "{f:?}");
        // no partition column inside the file
        assert_eq!(meta.file_metadata().schema_descr().num_columns(), 2);
    }

    // one file
    let one = dir.join("one.parquet");
    let written = ctx.sql(GOOD).unwrap().sink_parquet_files(&one, &ParquetOptions::default(), &Default::default()).unwrap();
    assert_eq!(written.len(), 1);
    assert_eq!((written[0].path.as_str(), written[0].rows), (one.as_str(), 100));
    assert_eq!(written[0].size, std::fs::metadata(&one).unwrap().len());
    assert!(written[0].partition_values.is_empty());

    // csv
    let csv = dir.join("a.csv");
    let mut sink = CsvSink::create(&csv, true, b',', &Default::default()).unwrap();
    sink.write(&batch(10)).unwrap();
    let f = sink.finish().unwrap();
    assert_eq!((f.rows, f.size, f.path.as_str()), (10, std::fs::metadata(&csv).unwrap().len(), csv.as_str()));
    assert!(f.metadata.is_none());
}

#[test]
fn listing_and_removing_files_of_a_folder() {
    let dir = TempDir::new("safe-list");
    let root = dir.join("t");
    let opts = ParquetOptions { partition_by: vec!["g".into()], ..Default::default() };
    let mut sink = DatasetSink::create(&root, schema(), &opts, &Default::default()).unwrap();
    sink.write(&batch(30)).unwrap();
    sink.finish().unwrap();
    // an unfinished file of another writer is not part of the table
    std::fs::write(format!("{root}/g=0/part-x.parquet.tmp-1"), b"x").unwrap();
    std::fs::write(format!("{root}/notes.txt"), b"x").unwrap();

    let files = dataset::list_files(&root, &Default::default()).unwrap();
    assert_eq!(files.len(), 4, "{files:?}");
    assert!(dataset::list_files(&dir.join("missing"), &Default::default()).unwrap().is_empty());
    assert!(dataset::list_files(&dir.join("x.parquet"), &Default::default()).is_err());

    dataset::remove_files(&files, &Default::default()).unwrap();
    // removing them twice is fine
    dataset::remove_files(&files, &Default::default()).unwrap();
    dataset::prune_empty_dirs(&root);
    assert_eq!(files_under(&root), vec!["g=0/part-x.parquet.tmp-1".to_string()]);
    assert_eq!(dirs_under(&root), vec!["g=0".to_string()]);
}

#[test]
fn object_store_overwrite_that_fails_keeps_the_old_objects() {
    let ctx = SessionContext::new();
    source(&ctx);
    let out = "memory://safe-writes/out/";
    let storage = Default::default();
    run(&ctx, &format!("copy ({GOOD}) to '{out}' (PARTITION_BY (g))"));
    let before = dataset::list_files(out, &storage).unwrap();
    assert_eq!(before.len(), 4);

    fails(&ctx, &format!("copy ({FAILING}) to '{out}' (PARTITION_BY (g), OVERWRITE)"));
    assert_eq!(dataset::list_files(out, &storage).unwrap(), before);
    assert_eq!(read_back(out), OLD);

    run(&ctx, "copy (select id, g, cast(s as bigint) as n from src where id < 10) to 'memory://safe-writes/out/' (PARTITION_BY (g), OVERWRITE)");
    let after = dataset::list_files(out, &storage).unwrap();
    assert!(after.iter().all(|f| !before.contains(f)), "{before:?} -> {after:?}");
    assert_eq!(read_back(out), "10/45");

    // a single object: replaced only when the upload completes
    let file = "memory://safe-writes/one.parquet";
    run(&ctx, &format!("copy ({GOOD}) to '{file}'"));
    fails(&ctx, &format!("copy ({FAILING}) to '{file}'"));
    assert_eq!(read_back(file), OLD);
}
