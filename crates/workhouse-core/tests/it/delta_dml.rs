//! `DELETE`, `UPDATE` and `MERGE` on Delta tables (copy-on-write): the contents
//! after each statement, which files its commit removes and adds, and how it
//! meets concurrent writers. Tables are made of one file per range of ids.

use std::sync::Arc;

use arrow::array::{Array, ArrayRef, Int64Array, StringArray};
use arrow::compute::cast;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use workhouse_core::delta::ops::delete::delete;
use workhouse_core::delta::ops::merge::merge;
use workhouse_core::delta::ops::update::update;
use workhouse_core::delta::{Action, DeltaTable, LogStore, MergeClause, Snapshot, WriteMode, parse_commit, write_table};
use workhouse_core::io::StorageOptions;
use workhouse_core::{Expr, LazyFrame, Scalar, SessionContext, SortExpr, WhError, col, lit};

use crate::support::dir::{TempDir, files_under};

type Row = (i64, Option<i64>, Option<String>);

fn schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("g", DataType::Int64, true),
        Field::new("s", DataType::Utf8, true),
    ]))
}

/// id, g = id % 3 (NULL for id % 7 == 6), s = 's<id>'
fn batch(ids: std::ops::Range<i64>) -> RecordBatch {
    let ids: Vec<i64> = ids.collect();
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(ids.clone())),
        Arc::new(Int64Array::from(ids.iter().map(|i| (i % 7 != 6).then_some(i % 3)).collect::<Vec<_>>())),
        Arc::new(StringArray::from(ids.iter().map(|i| format!("s{i}")).collect::<Vec<_>>())),
    ];
    RecordBatch::try_new(schema(), cols).unwrap()
}

fn frame(ctx: &SessionContext, ids: std::ops::Range<i64>) -> LazyFrame {
    ctx.from_batches(schema(), vec![batch(ids)]).unwrap()
}

fn opts() -> StorageOptions {
    StorageOptions::new()
}

/// A table with one file per range (per partition value, if partitioned).
fn table(tag: &str, ranges: &[std::ops::Range<i64>], partition_by: &[&str]) -> (TempDir, String) {
    let dir = TempDir::new(tag);
    let path = dir.join("t");
    let ctx = SessionContext::new();
    let parts: Vec<String> = partition_by.iter().map(|s| s.to_string()).collect();
    for (i, r) in ranges.iter().enumerate() {
        let mode = if i == 0 { WriteMode::Create } else { WriteMode::Append };
        write_table(&frame(&ctx, r.clone()), &path, &opts(), mode, &parts, false).unwrap();
    }
    (dir, path)
}

fn open(path: &str) -> DeltaTable {
    DeltaTable::open(path, &opts(), None).unwrap()
}

fn snapshot(path: &str) -> Snapshot {
    Snapshot::load(&LogStore::open(path, &opts()).unwrap(), None).unwrap()
}

fn commit_actions(path: &str, version: u64) -> Vec<Action> {
    parse_commit(&std::fs::read(format!("{path}/_delta_log/{version:020}.json")).unwrap()).unwrap()
}

fn removes(path: &str, version: u64) -> Vec<String> {
    let mut v: Vec<String> = commit_actions(path, version).iter().filter_map(|a| if let Action::Remove(r) = a { Some(r.file_path()) } else { None }).collect();
    v.sort();
    v
}

fn adds(path: &str, version: u64) -> Vec<workhouse_core::delta::Add> {
    commit_actions(path, version).into_iter().filter_map(|a| if let Action::Add(a) = a { Some(a) } else { None }).collect()
}

fn info(path: &str, version: u64) -> workhouse_core::delta::CommitInfo {
    match &commit_actions(path, version)[0] {
        Action::CommitInfo(i) => i.clone(),
        other => panic!("{other:?}"),
    }
}

/// The path of the file whose smallest id is `min`.
fn file_with_min(snap: &Snapshot, min: i64) -> String {
    let found: Vec<_> = snap
        .files
        .iter()
        .filter(|a| {
            let stats: serde_json::Value = serde_json::from_str(a.stats.as_ref().unwrap()).unwrap();
            stats["minValues"]["id"] == min
        })
        .collect();
    assert_eq!(found.len(), 1, "files with min id {min}");
    found[0].file_path()
}

fn data_files(path: &str) -> Vec<String> {
    files_under(path).into_iter().filter(|f| f.ends_with(".parquet") && !f.starts_with("_delta_log")).collect()
}

fn contents(path: &str) -> Vec<Row> {
    let ctx = SessionContext::new();
    let lf = ctx.read_delta(path, &opts(), None).unwrap().sort(vec![SortExpr::new(col("id"), false, false)]).unwrap();
    let (_, batches) = lf.collect().unwrap();
    let mut out = vec![];
    for b in batches {
        let by = |n: &str| b.column(b.schema().index_of(n).unwrap()).clone();
        let id = cast(&by("id"), &DataType::Int64).unwrap();
        let g = cast(&by("g"), &DataType::Int64).unwrap();
        let s = cast(&by("s"), &DataType::Utf8).unwrap();
        let (id, g, s) = (
            id.as_any().downcast_ref::<Int64Array>().unwrap().clone(),
            g.as_any().downcast_ref::<Int64Array>().unwrap().clone(),
            s.as_any().downcast_ref::<StringArray>().unwrap().clone(),
        );
        for i in 0..b.num_rows() {
            out.push((id.value(i), g.is_valid(i).then(|| g.value(i)), s.is_valid(i).then(|| s.value(i).to_string())));
        }
    }
    out
}

/// The rows of `batch(ids)` as `Row`s, for the ids that pass `keep`.
fn expected(ids: std::ops::Range<i64>, keep: impl Fn(i64) -> bool) -> Vec<Row> {
    ids.filter(|i| keep(*i)).map(|i| (i, (i % 7 != 6).then_some(i % 3), Some(format!("s{i}")))).collect()
}

fn int(v: i64) -> Expr {
    lit(Scalar::int64(v))
}

fn text(v: &str) -> Expr {
    lit(Scalar::utf8(v))
}

fn t(name: &str) -> Expr {
    workhouse_core::expr::qcol("t", name)
}

fn s(name: &str) -> Expr {
    workhouse_core::expr::qcol("s", name)
}

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

#[test]
fn delete_rewrites_only_the_file_with_matching_rows() {
    let (_dir, path) = table("dml-del-partial", &[0..10, 10..20, 20..30], &[]);
    let a = file_with_min(&snapshot(&path), 0);
    let ctx = SessionContext::new();
    let r = delete(&ctx, &open(&path), None, Some(col("id").eq(int(5)))).unwrap();
    assert_eq!((r.version, r.rows_affected, r.files_removed, r.files_added), (3, 1, 1, 1));
    assert_eq!(contents(&path), expected(0..30, |i| i != 5));
    assert_eq!(removes(&path, 3), vec![a]);
    assert_eq!(adds(&path, 3).len(), 1);
    assert_eq!(snapshot(&path).files.len(), 3);
    let i = info(&path, 3);
    assert_eq!(i.operation(), Some("DELETE"));
    assert_eq!(i.metric("numDeletedRows"), Some(1));
    assert_eq!(i.metric("numCopiedRows"), Some(9));
    assert_eq!((i.metric("numRemovedFiles"), i.metric("numAddedFiles")), (Some(1), Some(1)));
    assert!(i.operation_parameters().unwrap()["predicate"].as_str().unwrap().contains("id"));
    assert_eq!(i.0["isBlindAppend"], false);
}

#[test]
fn delete_removes_a_file_whose_rows_all_match_without_rewriting_it() {
    let (_dir, path) = table("dml-del-whole", &[0..10, 10..20, 20..30], &[]);
    let a = file_with_min(&snapshot(&path), 0);
    let ctx = SessionContext::new();
    let r = delete(&ctx, &open(&path), None, Some(col("id").lt(int(10)))).unwrap();
    assert_eq!((r.version, r.rows_affected, r.files_removed, r.files_added), (3, 10, 1, 0));
    assert_eq!(removes(&path, 3), vec![a]);
    assert_eq!(contents(&path), expected(0..30, |i| i >= 10));
    assert_eq!(data_files(&path).len(), 3, "no new file");
}

#[test]
fn delete_with_no_matching_row_commits_nothing() {
    let (_dir, path) = table("dml-del-none", &[0..10, 10..20], &[]);
    let files = data_files(&path);
    let ctx = SessionContext::new();
    let r = delete(&ctx, &open(&path), None, Some(col("id").gt(int(1000)))).unwrap();
    assert_eq!((r.version, r.rows_affected, r.files_removed, r.files_added), (1, 0, 0, 0));
    // a predicate the statistics cannot rule out
    let r = delete(&ctx, &open(&path), None, Some(col("s").eq(text("nothing")))).unwrap();
    assert_eq!((r.version, r.rows_affected), (1, 0));
    assert_eq!(snapshot(&path).version, 1);
    assert_eq!(data_files(&path), files);
}

#[test]
fn delete_all_removes_every_file() {
    let (_dir, path) = table("dml-del-all", &[0..10, 10..20, 20..30], &[]);
    let ctx = SessionContext::new();
    let r = delete(&ctx, &open(&path), None, None).unwrap();
    assert_eq!((r.version, r.rows_affected, r.files_removed, r.files_added), (3, 30, 3, 0));
    assert_eq!(removes(&path, 3).len(), 3);
    assert!(contents(&path).is_empty());
    assert_eq!(snapshot(&path).files.len(), 0);
    // the empty table can be deleted from, updated and read again
    let r = delete(&ctx, &open(&path), None, None).unwrap();
    assert_eq!((r.version, r.rows_affected), (3, 0));
    let r = update(&ctx, &open(&path), None, vec![("s".into(), text("x"))], None).unwrap();
    assert_eq!((r.version, r.rows_affected), (3, 0));
}

#[test]
fn delete_keeps_rows_the_predicate_is_null_for() {
    // g is NULL for ids 6, 13, 20, 27: `g <> 1` is NULL there and those rows stay
    let (_dir, path) = table("dml-del-null", &[0..15, 15..30], &[]);
    let ctx = SessionContext::new();
    let r = delete(&ctx, &open(&path), None, Some(col("g").not_eq(int(1)))).unwrap();
    let gone = |i: i64| i % 7 != 6 && i % 3 != 1;
    assert_eq!(r.rows_affected as usize, (0..30).filter(|i| gone(*i)).count());
    assert_eq!(contents(&path), expected(0..30, |i| !gone(i)));
    // NOT (g = 1) is the same expression: still NULL for the NULL rows
    let (_dir2, path2) = table("dml-del-null2", &[0..30], &[]);
    delete(&ctx, &open(&path2), None, Some(col("g").eq(int(1)).not())).unwrap();
    assert_eq!(contents(&path2), expected(0..30, |i| !gone(i)));
    // IS NULL deletes them
    delete(&ctx, &open(&path2), None, Some(col("g").is_null())).unwrap();
    assert_eq!(contents(&path2), expected(0..30, |i| i % 7 != 6 && i % 3 == 1));
}

#[test]
fn delete_by_a_partition_column_removes_whole_files() {
    let (_dir, path) = table("dml-del-part", &[0..30], &["g"]);
    let before = snapshot(&path).files.len();
    assert_eq!(before, 4, "g = 0, 1, 2 and NULL");
    let ctx = SessionContext::new();
    let r = delete(&ctx, &open(&path), None, Some(col("g").eq(int(1)))).unwrap();
    assert_eq!((r.files_removed, r.files_added), (1, 0));
    assert_eq!(contents(&path), expected(0..30, |i| i % 7 == 6 || i % 3 != 1));
    // a predicate on both kinds of column rewrites one partition's file
    let r = delete(&ctx, &open(&path), None, Some(col("g").eq(int(2)).and(col("id").lt(int(10))))).unwrap();
    assert_eq!((r.files_removed, r.files_added), (1, 1));
    assert_eq!(contents(&path), expected(0..30, |i| i % 7 == 6 || (i % 3 != 1 && !(i % 3 == 2 && i < 10))));
}

#[test]
fn delete_accepts_a_table_alias() {
    let (_dir, path) = table("dml-del-alias", &[0..10], &[]);
    let ctx = SessionContext::new();
    delete(&ctx, &open(&path), Some("x"), Some(workhouse_core::expr::qcol("x", "id").lt(int(3)))).unwrap();
    assert_eq!(contents(&path), expected(0..10, |i| i >= 3));
}

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

#[test]
fn update_sets_values_in_the_matching_rows_only() {
    let (_dir, path) = table("dml-upd", &[0..10, 10..20, 20..30], &[]);
    let b = file_with_min(&snapshot(&path), 10);
    let ctx = SessionContext::new();
    let r = update(&ctx, &open(&path), None, vec![("s".into(), text("changed")), ("G".into(), col("id").cast(DataType::Int32))], Some(col("id").between(int(12), int(14)))).unwrap();
    assert_eq!((r.version, r.rows_affected, r.files_removed, r.files_added), (3, 3, 1, 1));
    assert_eq!(removes(&path, 3), vec![b]);
    let mut want = expected(0..30, |_| true);
    for row in want.iter_mut().filter(|r| (12..=14).contains(&r.0)) {
        *row = (row.0, Some(row.0), Some("changed".into()));
    }
    assert_eq!(contents(&path), want);
    let i = info(&path, 3);
    assert_eq!(i.operation(), Some("UPDATE"));
    assert_eq!((i.metric("numUpdatedRows"), i.metric("numCopiedRows")), (Some(3), Some(7)));
}

#[test]
fn update_reads_the_old_row_and_casts_to_the_column_type() {
    let (_dir, path) = table("dml-upd-cast", &[0..10], &[]);
    let ctx = SessionContext::new();
    // s = s || '!' reads the old value; g = 1.9 casts a double to the integer column
    let r = update(&ctx, &open(&path), None, vec![("g".into(), lit(Scalar::float64(7.0))), ("s".into(), col("id").cast(DataType::Utf8))], Some(col("id").gt_eq(int(8)))).unwrap();
    assert_eq!(r.rows_affected, 2);
    let mut want = expected(0..10, |_| true);
    for row in want.iter_mut().filter(|r| r.0 >= 8) {
        *row = (row.0, Some(7), Some(row.0.to_string()));
    }
    assert_eq!(contents(&path), want);
    // the column keeps its type
    let snap = snapshot(&path);
    assert_eq!(snap.schema.field_with_name("g").unwrap().data_type(), &DataType::Int64);
}

#[test]
fn update_without_a_predicate_touches_every_row_and_ignores_null_predicates() {
    let (_dir, path) = table("dml-upd-all", &[0..10, 10..20], &[]);
    let ctx = SessionContext::new();
    let r = update(&ctx, &open(&path), None, vec![("s".into(), text("all"))], None).unwrap();
    assert_eq!((r.rows_affected, r.files_removed), (20, 2));
    assert!(contents(&path).iter().all(|r| r.2.as_deref() == Some("all")));
    // g = 1 is NULL for the NULL rows: they are not updated
    let r = update(&ctx, &open(&path), None, vec![("s".into(), text("one"))], Some(col("g").eq(int(1)))).unwrap();
    let ones = (0..20).filter(|i| i % 7 != 6 && i % 3 == 1).count();
    assert_eq!(r.rows_affected as usize, ones);
    let c = contents(&path);
    assert_eq!(c.iter().filter(|r| r.2.as_deref() == Some("one")).count(), ones);
    assert!(c.iter().filter(|r| r.1.is_none()).all(|r| r.2.as_deref() == Some("all")));
}

#[test]
fn update_with_no_matching_row_commits_nothing() {
    let (_dir, path) = table("dml-upd-none", &[0..10], &[]);
    let ctx = SessionContext::new();
    let r = update(&ctx, &open(&path), None, vec![("s".into(), text("x"))], Some(col("id").gt(int(99)))).unwrap();
    assert_eq!((r.version, r.rows_affected, r.files_removed, r.files_added), (0, 0, 0, 0));
    assert_eq!(snapshot(&path).version, 0);
    assert!(update(&ctx, &open(&path), None, vec![("nope".into(), text("x"))], None).is_err());
    assert!(update(&ctx, &open(&path), None, vec![("s".into(), text("x")), ("S".into(), text("y"))], None).is_err());
    assert_eq!(snapshot(&path).version, 0);
    assert_eq!(data_files(&path).len(), 1);
}

#[test]
fn updating_a_partition_column_moves_the_rows() {
    let (_dir, path) = table("dml-upd-part", &[0..30], &["g"]);
    let ctx = SessionContext::new();
    // g = 0 -> 2 for ids below 10; the rows land in the partition g = 2
    let r = update(&ctx, &open(&path), None, vec![("g".into(), int(2))], Some(col("g").eq(int(0)).and(col("id").lt(int(10))))).unwrap();
    assert_eq!(r.rows_affected, 3, "ids 0, 3, 9 (6 has g NULL)");
    let mut want = expected(0..30, |_| true);
    for row in want.iter_mut().filter(|r| r.1 == Some(0) && r.0 < 10) {
        row.1 = Some(2);
    }
    assert_eq!(contents(&path), want);
    // the files still live under the folder of their partition value
    for add in snapshot(&path).files {
        let value = add.partition_values["g"].clone();
        let folder = value.map_or("__HIVE_DEFAULT_PARTITION__".to_string(), |v| v);
        assert!(add.file_path().starts_with(&format!("g={folder}/")), "{} in {folder}", add.file_path());
    }
    // other partitions keep their files: the g = 1 and NULL ones are not in the remove list
    assert_eq!(removes(&path, 1).len(), 1);
    assert_eq!(adds(&path, 1).len(), 2, "g = 0 keeps ids >= 10, g = 2 gets the moved rows");
    // and the reverse: to a value without a partition yet, and to NULL
    update(&ctx, &open(&path), None, vec![("g".into(), int(9))], Some(col("id").eq(int(1)))).unwrap();
    update(&ctx, &open(&path), None, vec![("g".into(), Expr::Literal(Scalar::null()).cast(DataType::Int64))], Some(col("id").eq(int(2)))).unwrap();
    let c = contents(&path);
    assert_eq!(c[1].1, Some(9));
    assert_eq!(c[2].1, None);
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

/// A source of rows `(id, g, s, op)`: s = 'new<id>', g = 100 + id.
fn source(ctx: &SessionContext, rows: &[(i64, &str)]) -> LazyFrame {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("g", DataType::Int64, true),
        Field::new("s", DataType::Utf8, true),
        Field::new("op", DataType::Utf8, true),
    ]));
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(rows.iter().map(|r| r.0).collect::<Vec<_>>())),
        Arc::new(Int64Array::from(rows.iter().map(|r| 100 + r.0).collect::<Vec<_>>())),
        Arc::new(StringArray::from(rows.iter().map(|r| format!("new{}", r.0)).collect::<Vec<_>>())),
        Arc::new(StringArray::from(rows.iter().map(|r| r.1).collect::<Vec<_>>())),
    ];
    ctx.from_batches(schema.clone(), vec![RecordBatch::try_new(schema, cols).unwrap()]).unwrap()
}

fn on_id() -> Expr {
    t("id").eq(s("id"))
}

fn new_row(id: i64) -> Row {
    (id, Some(100 + id), Some(format!("new{id}")))
}

#[test]
fn merge_upserts_and_leaves_untouched_files_alone() {
    let (_dir, path) = table("dml-merge-upsert", &[0..10, 10..20, 20..30], &[]);
    let c = file_with_min(&snapshot(&path), 20);
    let ctx = SessionContext::new();
    let src = source(&ctx, &(25..40).map(|i| (i, "")).collect::<Vec<_>>());
    let clauses = vec![MergeClause::MatchedUpdateAll { cond: None }, MergeClause::NotMatchedInsertAll { cond: None }];
    let r = merge(&ctx, &open(&path), &src, "s", "t", on_id(), clauses).unwrap();
    assert_eq!((r.version, r.rows_affected, r.files_removed, r.files_added), (3, 15, 1, 2));
    assert_eq!(removes(&path, 3), vec![c], "only the file with matched rows is rewritten");
    let mut want = expected(0..25, |_| true);
    want.extend((25..40).map(new_row));
    assert_eq!(contents(&path), want);
    let i = info(&path, 3);
    assert_eq!(i.operation(), Some("MERGE"));
    assert_eq!((i.metric("numTargetRowsInserted"), i.metric("numTargetRowsUpdated"), i.metric("numTargetRowsDeleted")), (Some(10), Some(5), Some(0)));
    assert_eq!(i.metric("numTargetRowsCopied"), Some(5));
    assert!(i.operation_parameters().unwrap().contains_key("matchedPredicates"));
}

#[test]
fn merge_update_with_explicit_assignments_and_insert_columns() {
    let (_dir, path) = table("dml-merge-set", &[0..10], &[]);
    let ctx = SessionContext::new();
    let src = source(&ctx, &[(3, ""), (50, "")]);
    let clauses = vec![
        MergeClause::MatchedUpdate { cond: None, set: vec![("s".into(), s("s")), ("g".into(), s("g").cast(DataType::Int64))] },
        MergeClause::NotMatchedInsert { cond: None, values: vec![("id".into(), s("id")), ("s".into(), text("inserted"))] },
    ];
    let r = merge(&ctx, &open(&path), &src, "s", "t", on_id(), clauses).unwrap();
    assert_eq!(r.rows_affected, 2);
    let mut want = expected(0..10, |_| true);
    want[3] = new_row(3);
    want.push((50, None, Some("inserted".into())));
    assert_eq!(contents(&path), want);
}

#[test]
fn merge_deletes_matched_rows() {
    let (_dir, path) = table("dml-merge-del", &[0..10, 10..20, 20..30], &[]);
    let (a, b) = (file_with_min(&snapshot(&path), 0), file_with_min(&snapshot(&path), 10));
    let ctx = SessionContext::new();
    let src = source(&ctx, &[(3, ""), (15, ""), (15, ""), (99, "")]);
    // a single unconditional DELETE tolerates a target row matching several source rows
    let r = merge(&ctx, &open(&path), &src, "s", "t", on_id(), vec![MergeClause::MatchedDelete { cond: None }]).unwrap();
    assert_eq!((r.rows_affected, r.files_removed, r.files_added), (2, 2, 1));
    let mut removed = removes(&path, 3);
    removed.sort();
    let mut want_removed = vec![a, b];
    want_removed.sort();
    assert_eq!(removed, want_removed);
    assert_eq!(contents(&path), expected(0..30, |i| i != 3 && i != 15));
    assert_eq!(info(&path, 3).metric("numTargetRowsDeleted"), Some(2));
}

#[test]
fn merge_clauses_are_tried_in_order_with_their_conditions() {
    let (_dir, path) = table("dml-merge-cond", &[0..10, 10..20], &[]);
    let ctx = SessionContext::new();
    // ops: u = update, d = delete, x = matched but no clause applies; i = insert, n = not inserted
    let src = source(&ctx, &[(1, "u"), (2, "d"), (3, "x"), (4, "u"), (12, "d"), (40, "i"), (41, "n"), (42, "i")]);
    let op = |v: &str| s("op").eq(text(v));
    let clauses = vec![
        MergeClause::MatchedDelete { cond: Some(op("d")) },
        MergeClause::MatchedUpdate { cond: Some(op("u").and(t("id").lt(int(4)))), set: vec![("s".into(), text("first"))] },
        MergeClause::MatchedUpdate { cond: Some(op("u")), set: vec![("s".into(), text("second"))] },
        MergeClause::NotMatchedInsert { cond: Some(op("i")), values: vec![("id".into(), s("id")), ("g".into(), int(-1)), ("s".into(), s("op"))] },
    ];
    let r = merge(&ctx, &open(&path), &src, "s", "t", on_id(), clauses).unwrap();
    assert_eq!(r.rows_affected, 6);
    let mut want = expected(0..20, |i| i != 2 && i != 12);
    for row in want.iter_mut() {
        match row.0 {
            1 => row.2 = Some("first".into()),
            4 => row.2 = Some("second".into()),
            _ => {}
        }
    }
    want.push((40, Some(-1), Some("i".into())));
    want.push((42, Some(-1), Some("i".into())));
    assert_eq!(contents(&path), want);
    let i = info(&path, 2);
    assert_eq!((i.metric("numTargetRowsInserted"), i.metric("numTargetRowsUpdated"), i.metric("numTargetRowsDeleted")), (Some(2), Some(2), Some(2)));
}

#[test]
fn merge_inserts_only_source_rows_without_a_match() {
    let (_dir, path) = table("dml-merge-insert", &[0..10, 10..20], &[]);
    let files = snapshot(&path).files.len();
    let ctx = SessionContext::new();
    let src = source(&ctx, &[(5, ""), (25, ""), (26, "")]);
    let r = merge(&ctx, &open(&path), &src, "s", "t", on_id(), vec![MergeClause::NotMatchedInsertAll { cond: None }]).unwrap();
    assert_eq!((r.rows_affected, r.files_removed, r.files_added), (2, 0, 1));
    assert_eq!(removes(&path, 2).len(), 0);
    assert_eq!(snapshot(&path).files.len(), files + 1);
    let mut want = expected(0..20, |_| true);
    want.extend([new_row(25), new_row(26)]);
    assert_eq!(contents(&path), want);
    // nothing new: no commit
    let r = merge(&ctx, &open(&path), &src, "s", "t", on_id(), vec![MergeClause::NotMatchedInsertAll { cond: None }]).unwrap();
    assert_eq!((r.version, r.rows_affected), (2, 0));
    assert_eq!(snapshot(&path).version, 2);
}

#[test]
fn merge_into_an_empty_table_inserts_everything() {
    let (_dir, path) = table("dml-merge-empty", &[0..5], &[]);
    let ctx = SessionContext::new();
    delete(&ctx, &open(&path), None, None).unwrap();
    let src = source(&ctx, &[(1, ""), (2, "")]);
    let r = merge(&ctx, &open(&path), &src, "s", "t", on_id(), vec![MergeClause::NotMatchedInsertAll { cond: None }]).unwrap();
    assert_eq!((r.rows_affected, r.files_added), (2, 1));
    assert_eq!(contents(&path), vec![new_row(1), new_row(2)]);
}

#[test]
fn merge_not_matched_by_source_deletes_and_updates() {
    let (_dir, path) = table("dml-merge-nmbs", &[0..10, 10..20, 20..30], &[]);
    let (b, c) = (file_with_min(&snapshot(&path), 10), file_with_min(&snapshot(&path), 20));
    let ctx = SessionContext::new();
    // the source has the ids of the first file: the others are "not matched by source"
    let src = source(&ctx, &(0..10).map(|i| (i, "")).collect::<Vec<_>>());
    let r = merge(&ctx, &open(&path), &src, "s", "t", on_id(), vec![MergeClause::NotMatchedBySourceDelete { cond: Some(t("id").lt(int(20))) }]).unwrap();
    assert_eq!((r.rows_affected, r.files_removed, r.files_added), (10, 1, 0));
    assert_eq!(removes(&path, 3), vec![b], "the files with no row to change are not rewritten");
    assert_eq!(contents(&path), expected(0..10, |_| true).into_iter().chain(expected(20..30, |_| true)).collect::<Vec<_>>());

    // together with matched clauses: update the unmatched rows of the last file, update the matched
    let clauses = vec![
        MergeClause::MatchedUpdate { cond: Some(t("id").lt(int(2))), set: vec![("s".into(), text("matched"))] },
        MergeClause::NotMatchedBySourceUpdate { cond: None, set: vec![("s".into(), text("orphan")), ("g".into(), t("id"))] },
    ];
    let r = merge(&ctx, &open(&path), &src, "s", "t", on_id(), clauses).unwrap();
    assert_eq!((r.rows_affected, r.files_removed), (12, 2));
    assert!(removes(&path, 4).contains(&c) && removes(&path, 4).len() == 2);
    let want: Vec<Row> = (0..10)
        .chain(20..30)
        .map(|i| match i {
            0 | 1 => (i, (i % 7 != 6).then_some(i % 3), Some("matched".to_string())),
            2..=9 => (i, (i % 7 != 6).then_some(i % 3), Some(format!("s{i}"))),
            _ => (i, Some(i), Some("orphan".to_string())),
        })
        .collect();
    assert_eq!(contents(&path), want);
}

#[test]
fn merge_with_a_non_equality_condition_and_all_three_kinds_of_clause() {
    let (_dir, path) = table("dml-merge-residual", &[0..10, 10..20], &[]);
    let ctx = SessionContext::new();
    let src = source(&ctx, &[(3, "a"), (30, "b")]);
    let on = t("id").eq(s("id")).and(s("op").eq(text("a")));
    let clauses = vec![
        MergeClause::MatchedUpdate { cond: None, set: vec![("s".into(), s("op"))] },
        MergeClause::NotMatchedInsertAll { cond: None },
        MergeClause::NotMatchedBySourceDelete { cond: Some(t("id").gt_eq(int(15))) },
    ];
    let r = merge(&ctx, &open(&path), &src, "s", "t", on, clauses).unwrap();
    assert_eq!(r.rows_affected, 1 + 1 + 5);
    let mut want = expected(0..15, |_| true);
    want[3].2 = Some("a".into());
    want.push(new_row(30));
    assert_eq!(contents(&path), want);
}

#[test]
fn merge_fails_when_a_target_row_matches_several_source_rows() {
    let (_dir, path) = table("dml-merge-multi", &[0..10, 10..20], &[]);
    let files = data_files(&path);
    let ctx = SessionContext::new();
    let src = source(&ctx, &[(4, ""), (7, ""), (7, "")]);
    for clauses in [
        vec![MergeClause::MatchedUpdateAll { cond: None }],
        vec![MergeClause::MatchedDelete { cond: Some(s("op").eq(text(""))) }],
        vec![MergeClause::MatchedUpdate { cond: Some(t("id").lt(int(5))), set: vec![("s".into(), text("x"))] }, MergeClause::NotMatchedInsertAll { cond: None }],
    ] {
        let err = merge(&ctx, &open(&path), &src, "s", "t", on_id(), clauses).unwrap_err();
        assert!(err.to_string().contains("multiple source rows"), "{err}");
    }
    assert_eq!(snapshot(&path).version, 1);
    assert_eq!(data_files(&path), files, "the failed merges left no file");
    assert_eq!(contents(&path), expected(0..20, |_| true));

    // a source with repeated keys is fine when no target row actually matches twice
    let src = source(&ctx, &[(4, "keep"), (4, "other"), (7, "keep")]);
    let on = t("id").eq(s("id")).and(s("op").eq(text("keep")));
    let r = merge(&ctx, &open(&path), &src, "s", "t", on, vec![MergeClause::MatchedUpdate { cond: None, set: vec![("s".into(), s("op"))] }]).unwrap();
    assert_eq!(r.rows_affected, 2);
    let c = contents(&path);
    assert_eq!((c[4].2.as_deref(), c[7].2.as_deref(), c[5].2.as_deref()), (Some("keep"), Some("keep"), Some("s5")));
}

#[test]
fn merge_checks_its_clauses() {
    let (_dir, path) = table("dml-merge-clauses", &[0..5], &[]);
    let ctx = SessionContext::new();
    let src = source(&ctx, &[(1, "")]);
    let none = merge(&ctx, &open(&path), &src, "s", "t", on_id(), vec![]);
    assert!(none.is_err());
    // only the last clause of a kind may lack a condition
    let clauses = vec![MergeClause::MatchedDelete { cond: None }, MergeClause::MatchedUpdateAll { cond: None }];
    assert!(merge(&ctx, &open(&path), &src, "s", "t", on_id(), clauses).is_err());
    // no clause acts: nothing happens
    let clauses = vec![MergeClause::MatchedDelete { cond: Some(s("op").eq(text("zzz"))) }];
    let r = merge(&ctx, &open(&path), &src, "s", "t", on_id(), clauses).unwrap();
    assert_eq!((r.version, r.rows_affected), (0, 0));
}

// ---------------------------------------------------------------------------
// concurrent writers
// ---------------------------------------------------------------------------

#[test]
fn a_statement_on_a_stale_table_conflicts_with_an_append() {
    let (_dir, path) = table("dml-conflict", &[0..10, 10..20], &[]);
    let stale = open(&path);
    // another writer appends meanwhile
    let ctx = SessionContext::new();
    write_table(&frame(&ctx, 20..25), &path, &opts(), WriteMode::Append, &[], false).unwrap();
    let files = data_files(&path);
    assert_eq!(snapshot(&path).version, 2);

    let err = update(&ctx, &stale, None, vec![("s".into(), text("x"))], Some(col("id").lt(int(5)))).unwrap_err();
    assert!(matches!(err, WhError::ConcurrentModification(_)), "{err}");
    let err = delete(&ctx, &stale, None, Some(col("id").lt(int(5)))).unwrap_err();
    assert!(matches!(err, WhError::ConcurrentModification(_)), "{err}");
    // an insert-only merge read the table too: a concurrent insert may hold the same key
    let src = source(&ctx, &[(100, "")]);
    let err = merge(&ctx, &stale, &src, "s", "t", on_id(), vec![MergeClause::NotMatchedInsertAll { cond: None }]).unwrap_err();
    assert!(matches!(err, WhError::ConcurrentModification(_)), "{err}");

    assert_eq!(snapshot(&path).version, 2, "nothing was committed");
    assert_eq!(data_files(&path), files, "the rewritten files were deleted");
    assert_eq!(contents(&path), expected(0..25, |_| true));
    // the same statement on the current table goes through
    let r = update(&ctx, &open(&path), None, vec![("s".into(), text("x"))], Some(col("id").lt(int(5)))).unwrap();
    assert_eq!((r.version, r.rows_affected), (3, 5));
}

#[test]
fn two_statements_removing_the_same_file_conflict() {
    let (_dir, path) = table("dml-conflict-remove", &[0..10, 10..20], &[]);
    let ctx = SessionContext::new();
    let (first, second) = (open(&path), open(&path));
    delete(&ctx, &first, None, Some(col("id").eq(int(1)))).unwrap();
    let err = delete(&ctx, &second, None, Some(col("id").eq(int(2)))).unwrap_err();
    assert!(matches!(err, WhError::ConcurrentModification(_)), "{err}");
    assert_eq!(contents(&path), expected(0..20, |i| i != 1));
    assert_eq!(data_files(&path).len(), 3);
}

#[test]
fn append_only_tables_refuse_to_remove_files() {
    let (_dir, path) = table("dml-append-only", &[0..10], &[]);
    // set the property with a metadata action
    let snap = snapshot(&path);
    let mut meta = snap.metadata.clone();
    meta.configuration.insert("delta.appendOnly".into(), "true".into());
    let mut txn = workhouse_core::delta::Transaction::new(Some(0), "SET TBLPROPERTIES");
    txn.push(Action::Metadata(meta));
    txn.commit(&LogStore::open(&path, &opts()).unwrap()).unwrap();
    let ctx = SessionContext::new();
    assert!(delete(&ctx, &open(&path), None, Some(col("id").eq(int(1)))).is_err());
    assert!(update(&ctx, &open(&path), None, vec![("s".into(), text("x"))], None).is_err());
    // inserting is still allowed
    let src = source(&ctx, &[(50, "")]);
    merge(&ctx, &open(&path), &src, "s", "t", on_id(), vec![MergeClause::NotMatchedInsertAll { cond: None }]).unwrap();
    assert_eq!(contents(&path).len(), 11);
}
