//! A Delta table of many files is planned from its log alone: no query opens
//! a file to be planned, and a scan opens only the files it reads, while it
//! reads them. Requests are counted per `memory://` bucket, and the split
//! size comes from the environment, so these tests have a process of their own.

use std::collections::BTreeMap;
use std::sync::{Arc, Once};

use arrow::array::{Array, ArrayRef, AsArray, Int64Array, StringArray, TimestampMicrosecondArray};
use arrow::datatypes::{DataType, Field, Int64Type, Schema, SchemaRef, TimeUnit};
use arrow::record_batch::RecordBatch;
use iara_core::delta::stats::FileStats;
use iara_core::delta::{Action, Add, CommitInfo, DeltaTable, Format, LogStore, Metadata, Protocol, commit_file_name, schema_to_json, write_commit};
use iara_core::io::object::{StorageRequests, clear_object_stores, scope_requests};
use iara_core::io::parquet::write_parquet;
use iara_core::io::{StorageOptions, list_files};
use iara_core::{Scalar, SessionContext};

/// More files than a plan ever opens, whatever the number of threads.
const FILES: i64 = 96;
const ROWS: i64 = 50;
const PARTITIONS: i64 = 8;
/// Timestamps are 1.5 ms apart: the log rounds their bounds to the millisecond.
const TICK: i64 = 1_500;

fn init() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // SAFETY: set once, before any test of this binary reads the environment
        unsafe { std::env::set_var("IARA_SPLIT_MB", "1") };
    });
}

fn timestamp() -> DataType {
    DataType::Timestamp(TimeUnit::Microsecond, None)
}

fn data_schema(with_name: bool) -> SchemaRef {
    let mut fields = vec![Field::new("id", DataType::Int64, true), Field::new("at", timestamp(), true), Field::new("v", DataType::Int64, true)];
    if with_name {
        fields.push(Field::new("name", DataType::Utf8, true));
    }
    Arc::new(Schema::new(fields))
}

/// File `f` holds ids `f * ROWS ..`; `v` is null in every fifth row; the first half of the
/// files were written before the column `name` was added.
fn file_batch(f: i64) -> RecordBatch {
    let ids: Vec<i64> = (f * ROWS..(f + 1) * ROWS).collect();
    let vs: Vec<Option<i64>> = ids.iter().map(|i| (i % 5 != 0).then_some(i % 7)).collect();
    let with_name = f >= FILES / 2;
    let mut columns: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(ids.clone())),
        Arc::new(TimestampMicrosecondArray::from(ids.iter().map(|i| i * TICK).collect::<Vec<_>>())),
        Arc::new(Int64Array::from(vs)),
    ];
    if with_name {
        columns.push(Arc::new(StringArray::from(ids.iter().map(|i| format!("n{}", i % 3)).collect::<Vec<_>>())));
    }
    RecordBatch::try_new(data_schema(with_name), columns).unwrap()
}

fn stats(batch: &RecordBatch) -> String {
    let ids = batch.column(0).as_primitive::<Int64Type>();
    let (lo, hi) = (ids.value(0), ids.value(ids.len() - 1));
    let mut s = FileStats { num_records: Some(batch.num_rows() as u64), ..Default::default() };
    s.min.insert("id".into(), Scalar::int64(lo));
    s.max.insert("id".into(), Scalar::int64(hi));
    s.min.insert("at".into(), Scalar::timestamp_us(lo * TICK, None));
    s.max.insert("at".into(), Scalar::timestamp_us(hi * TICK, None));
    s.null_count.insert("id".into(), 0);
    s.null_count.insert("at".into(), 0);
    s.null_count.insert("v".into(), batch.column(2).null_count() as u64);
    s.to_json()
}

/// The table at `root` (a `memory://` URL or a folder): FILES files in PARTITIONS partitions `p`.
fn build(root: &str) {
    let storage = StorageOptions::default();
    let mut fields: Vec<Field> = data_schema(true).fields().iter().map(|f| f.as_ref().clone()).collect();
    fields.push(Field::new("p", DataType::Int64, true));
    let metadata = Metadata {
        id: "many".into(),
        name: None,
        description: None,
        format: Format::default(),
        schema_string: schema_to_json(&Schema::new(fields)).unwrap(),
        partition_columns: vec!["p".into()],
        configuration: BTreeMap::new(),
        created_time: Some(0),
    };
    let protocol = Protocol { min_reader_version: 1, min_writer_version: 2, reader_features: None, writer_features: None };
    let mut actions = vec![Action::CommitInfo(CommitInfo::new("WRITE", 1000)), Action::Protocol(protocol), Action::Metadata(metadata)];
    for f in 0..FILES {
        let batch = file_batch(f);
        let p = f % PARTITIONS;
        let rel = format!("p={p}/part-{f:04}.parquet");
        let url = format!("{root}/{rel}");
        write_parquet(&url, batch.schema(), std::slice::from_ref(&batch), "zstd", None).unwrap();
        let size = list_files(&url, "parquet", &storage).unwrap()[0].size().unwrap();
        actions.push(Action::Add(Add::new(&rel, BTreeMap::from([("p".to_string(), Some(p.to_string()))]), size as i64, 1, Some(stats(&batch)))));
    }
    let log = LogStore::open(root, &storage).unwrap();
    assert!(log.put_if_absent(&commit_file_name(0), write_commit(&actions)).unwrap());
}

fn session(root: &str) -> SessionContext {
    let ctx = SessionContext::new();
    ctx.register_table("t", Arc::new(DeltaTable::open(root, &StorageOptions::default(), None).unwrap())).unwrap();
    let ids: Vec<i64> = vec![3, 1_000, 4_799, 1_000_000];
    let labels: Vec<&str> = vec!["a", "b", "c", "d"];
    let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, true), Field::new("label", DataType::Utf8, true)]));
    let dim = RecordBatch::try_new(schema.clone(), vec![Arc::new(Int64Array::from(ids)), Arc::new(StringArray::from(labels))]).unwrap();
    ctx.register_table("dim", Arc::new(iara_core::io::memory::MemTable::new(schema, vec![dim]))).unwrap();
    ctx
}

fn requests(bucket: &str) -> StorageRequests {
    scope_requests(&format!("memory://{bucket}"))
}

fn rows(ctx: &SessionContext, sql: &str) -> String {
    let (_, batches) = ctx.sql(sql).unwrap().collect().unwrap();
    let mut out = vec![];
    for b in &batches {
        for r in 0..b.num_rows() {
            let cells: Vec<String> = b.columns().iter().map(|c| if c.is_null(r) { "null".into() } else { arrow::util::display::array_value_to_string(c, r).unwrap() }).collect();
            out.push(cells.join(","));
        }
    }
    out.join("|")
}

fn total_rows() -> i64 {
    FILES * ROWS
}

/// The queries of the tests, with their answers.
fn checks() -> Vec<(String, String)> {
    let n = total_rows();
    let sum = |lo: i64, hi: i64| (lo..hi).sum::<i64>();
    let nulls = (0..n).filter(|i| i % 5 == 0).count();
    let named = n - (FILES / 2) * ROWS;
    vec![
        ("select count(*) from t".into(), n.to_string()),
        ("select count(*), sum(id) from t where id >= 0".into(), format!("{n},{}", sum(0, n))),
        (format!("select count(*), sum(id) from t where id >= 100 and id < {}", n - 100), format!("{},{}", n - 200, sum(100, n - 100))),
        (format!("select count(*) from t where at >= timestamp '1970-01-01 00:00:00.000100' and id < {}", n - 1), (n - 2).to_string()),
        ("select count(*) from t where v is null".into(), nulls.to_string()),
        ("select count(name), count(*) from t where id >= 0".into(), format!("{named},{n}")),
        ("select p, count(*) from t group by p order by p limit 2".into(), format!("0,{0}|1,{0}", n / PARTITIONS)),
        ("select d.label, t.p, t.v from t join dim d on t.id = d.id order by d.label".into(), format!("a,0,3|b,4,null|c,7,{}", 4_799 % 7)),
        ("select name, count(*) from t where name is not null group by name order by name limit 1".into(), format!("n0,{}", (FILES / 2 * ROWS..n).filter(|i| i % 3 == 0).count())),
    ]
}

#[test]
fn planning_a_query_opens_no_file() {
    init();
    let bucket = "many-plan";
    let root = format!("memory://{bucket}/t");
    build(&root);
    clear_object_stores();
    let ctx = session(&root);
    let before = requests(bucket);
    for (sql, _) in checks() {
        let plan = ctx.sql(&sql).unwrap().explain(true).unwrap();
        assert_eq!(requests(bucket).since(before), StorageRequests::default(), "{sql}\n{plan}");
    }
    // few files are left: they open with the plan, the others never do
    let plan = ctx.sql("select sum(v) from t where id >= 120 and id < 180").unwrap().explain(true).unwrap();
    assert!(plan.contains("files=2"), "{plan}");
    assert!(requests(bucket).since(before).get <= 2, "{plan}");
}

#[test]
fn a_scan_opens_the_files_it_reads_while_it_reads_them() {
    init();
    let bucket = "many-scan";
    let root = format!("memory://{bucket}/t");
    build(&root);
    clear_object_stores();
    let ctx = session(&root);
    for (sql, expected) in checks() {
        assert_eq!(rows(&ctx, &sql), expected, "{sql}");
    }
    // a fresh table: a file this small arrives whole with its footer, in one request (the
    // first file's footer came with the table: its one request is for the data)
    clear_object_stores();
    let ctx = session(&root);
    let before = requests(bucket);
    assert_eq!(rows(&ctx, "select sum(id) from t where id >= 0"), (0..total_rows()).sum::<i64>().to_string());
    let scan = requests(bucket).since(before);
    assert_eq!((scan.list, scan.head, scan.get), (0, 0, FILES as u64), "{scan:?}");
    // a partition: only its files
    let before = requests(bucket);
    assert_eq!(rows(&ctx, "select count(v) from t where p = 3"), (0..total_rows()).filter(|i| (i / ROWS) % PARTITIONS == 3 && i % 5 != 0).count().to_string());
    assert!(requests(bucket).since(before).get <= (FILES / PARTITIONS) as u64);
}

#[test]
fn counts_and_extremes_come_from_the_log() {
    init();
    let bucket = "many-log";
    let root = format!("memory://{bucket}/t");
    build(&root);
    clear_object_stores();
    let ctx = session(&root);
    let n = total_rows();
    let before = requests(bucket);
    assert_eq!(rows(&ctx, "select count(*) from t"), n.to_string());
    assert_eq!(rows(&ctx, "select count(*) from t where p = 3"), (n / PARTITIONS).to_string());
    assert_eq!(rows(&ctx, "select min(id), max(id), count(v), count(*) from t"), format!("0,{},{},{n}", n - 1, n - n / 5));
    assert_eq!(requests(bucket).since(before), StorageRequests::default());
    // the log rounds timestamps: its bounds name the one file that can hold the newest, whose
    // footer has the value
    assert_eq!(rows(&ctx, "select max(at) = timestamp '1970-01-01 00:00:07.198500' from t"), "true");
    assert_eq!(requests(bucket).since(before).get, 1);
}

#[test]
fn a_limit_reads_the_first_files_only() {
    init();
    let bucket = "many-limit";
    let root = format!("memory://{bucket}/t");
    build(&root);
    clear_object_stores();
    let ctx = session(&root);
    let before = requests(bucket);
    let (_, batches) = ctx.sql("select id, name, p from t limit 60").unwrap().collect().unwrap();
    assert_eq!(batches.iter().map(|b| b.num_rows()).sum::<usize>(), 60);
    // the files are listed by path: the first two of partition 0 hold 100 rows
    assert!(requests(bucket).since(before).get <= 2, "{:?}", requests(bucket).since(before));
}

#[test]
fn local_files_are_read_the_same() {
    init();
    let dir = std::env::temp_dir().join(format!("iara-many-files-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let root = dir.to_str().unwrap().replace('\\', "/");
    build(&root);
    let ctx = session(&root);
    for (sql, expected) in checks() {
        assert_eq!(rows(&ctx, &sql), expected, "{sql}");
    }
    let plan = ctx.sql("select sum(id) from t").unwrap().explain(true).unwrap();
    assert!(plan.contains(&format!("files={FILES}")), "{plan}");
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn large_files_are_read_in_splits() {
    init();
    // 40 files of ~2.4 MB in row groups of 20 000 rows, read in splits of 1 MB
    let (files, per_file, row_group) = (40i64, 300_000i64, 20_000usize);
    let mut morsels = 0;
    let dir = std::env::temp_dir().join(format!("iara-split-files-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let root = dir.to_str().unwrap().replace('\\', "/");
    let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, true)]));
    let metadata = Metadata {
        id: "splits".into(),
        name: None,
        description: None,
        format: Format::default(),
        schema_string: schema_to_json(&schema).unwrap(),
        partition_columns: vec![],
        configuration: BTreeMap::new(),
        created_time: Some(0),
    };
    let protocol = Protocol { min_reader_version: 1, min_writer_version: 2, reader_features: None, writer_features: None };
    let mut actions = vec![Action::CommitInfo(CommitInfo::new("WRITE", 1000)), Action::Protocol(protocol), Action::Metadata(metadata)];
    for f in 0..files {
        let ids: Vec<i64> = (f * per_file..(f + 1) * per_file).collect();
        let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(Int64Array::from(ids))]).unwrap();
        let rel = format!("part-{f:02}.parquet");
        write_parquet(&format!("{root}/{rel}"), schema.clone(), &[batch], "none", Some(row_group)).unwrap();
        let size = std::fs::metadata(dir.join(&rel)).unwrap().len();
        assert!(size > 2 << 20, "{size}");
        morsels += (size + (1 << 19)) >> 20;
        let mut s = FileStats { num_records: Some(per_file as u64), ..Default::default() };
        s.min.insert("id".into(), Scalar::int64(f * per_file));
        s.max.insert("id".into(), Scalar::int64((f + 1) * per_file - 1));
        actions.push(Action::Add(Add::new(&rel, BTreeMap::new(), size as i64, 1, Some(s.to_json()))));
    }
    let log = LogStore::open(&root, &StorageOptions::default()).unwrap();
    assert!(log.put_if_absent(&commit_file_name(0), write_commit(&actions)).unwrap());

    let ctx = SessionContext::new();
    ctx.register_table("t", Arc::new(DeltaTable::open(&root, &StorageOptions::default(), None).unwrap())).unwrap();
    let n = files * per_file;
    // every row group is read by exactly one split
    let query = ctx.sql("select count(*), sum(id), count(distinct id) from t where id >= 0").unwrap();
    assert!(morsels >= 2 * files as u64);
    assert!(query.explain(true).unwrap().contains(&format!("files={files}, morsels={morsels}")), "{}", query.explain(true).unwrap());
    assert_eq!(rows(&ctx, "select count(*), sum(id), count(distinct id) from t where id >= 0"), format!("{n},{},{n}", (0..n).sum::<i64>()));
    let wanted = (5 * per_file + 50_000, 5 * per_file + 50_010);
    assert_eq!(rows(&ctx, &format!("select count(*) from t where id >= {} and id < {} or id < 0", wanted.0, wanted.1)), "10");
    let _ = std::fs::remove_dir_all(&dir);
}
