//! Planning and scanning a Delta table of many small files on a (simulated) object store:
//! how long each query takes to plan and to run, and how many requests it makes.
//!
//! ```text
//! cargo run --release -p iara-core --example delta_many_files -- [files] [rows per file] [latency ms]
//! ```
//!
//! The table has `files` files (default 5000) of `rows per file` rows (default 2000), as an
//! incremental load leaves them: 20 files per `day` partition, `id` and `ts` growing from
//! file to file. Every request to the store waits `latency ms` (default 20).
//!
//! `-- plan [files] [columns]` opens and plans a table of `files` files (default 100 000)
//! with statistics of `columns` columns (default 32) and no data.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Instant;

use arrow::array::{ArrayRef, Float64Array, Int64Array, StringArray, TimestampMicrosecondArray};
use arrow::datatypes::{DataType, Field, Schema, TimeUnit};
use arrow::record_batch::RecordBatch;
use iara_core::delta::stats::FileStats;
use iara_core::delta::{Action, Add, CommitInfo, DeltaTable, Format, LogStore, Metadata, Protocol, commit_file_name, schema_to_json, write_commit};
use iara_core::io::object::scope_requests;
use iara_core::io::parquet::write_parquet;
use iara_core::io::{StorageOptions, list_files};
use iara_core::{Scalar, SessionContext};

const BUCKET: &str = "memory://delta-many-files";
const FILES_PER_DAY: usize = 20;
const MICROS_PER_DAY: i64 = 86_400_000_000;
/// 2024-01-01, in days since the epoch
const FIRST_DAY: i64 = 19_723;

fn arg(i: usize, default: usize) -> usize {
    std::env::args().nth(i).and_then(|v| v.parse().ok()).unwrap_or(default)
}

fn day_text(day: i64) -> String {
    chrono::DateTime::from_timestamp(day * 86_400, 0).expect("a date").format("%Y-%m-%d").to_string()
}

/// The table's files and its one commit, written without latency.
fn build(root: &str, files: usize, rows: usize) {
    let storage = StorageOptions::default();
    let ts = DataType::Timestamp(TimeUnit::Microsecond, Some("UTC".into()));
    let data_schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, true),
        Field::new("customer_id", DataType::Int64, true),
        Field::new("ts", ts.clone(), true),
        Field::new("amount", DataType::Float64, true),
        Field::new("region", DataType::Utf8, true),
    ]));
    let mut fields = data_schema.fields().iter().map(|f| f.as_ref().clone()).collect::<Vec<_>>();
    fields.push(Field::new("day", DataType::Date32, true));
    let schema = Schema::new(fields);
    let metadata = Metadata {
        id: "many-files".into(),
        name: None,
        description: None,
        format: Format::default(),
        schema_string: schema_to_json(&schema).expect("a Delta schema"),
        partition_columns: vec!["day".into()],
        configuration: BTreeMap::new(),
        created_time: Some(0),
    };
    let protocol = Protocol { min_reader_version: 1, min_writer_version: 2, reader_features: None, writer_features: None };
    let mut actions = vec![Action::CommitInfo(CommitInfo::new("WRITE", 1000)), Action::Protocol(protocol), Action::Metadata(metadata)];
    let regions = ["north", "south", "east", "west"];
    for f in 0..files {
        let day = FIRST_DAY + (f / FILES_PER_DAY) as i64;
        let first = (f * rows) as i64;
        let ids: Vec<i64> = (first..first + rows as i64).collect();
        let customers: Vec<i64> = ids.iter().map(|i| i.wrapping_mul(2_654_435_761) % 100_000).collect();
        let step = MICROS_PER_DAY / (FILES_PER_DAY * rows) as i64;
        let times: Vec<i64> = ids.iter().map(|i| FIRST_DAY * MICROS_PER_DAY + i * step).collect();
        let amounts: Vec<f64> = ids.iter().map(|i| (i.wrapping_mul(40_503) % 10_007) as f64 * 0.25).collect();
        let names: Vec<&str> = ids.iter().map(|i| regions[(*i as usize / 7) % regions.len()]).collect();
        let mut stats = FileStats { num_records: Some(rows as u64), ..Default::default() };
        let mut bound = |name: &str, lo: Scalar, hi: Scalar| {
            stats.min.insert(name.into(), lo);
            stats.max.insert(name.into(), hi);
            stats.null_count.insert(name.into(), 0);
        };
        bound("id", Scalar::int64(ids[0]), Scalar::int64(ids[rows - 1]));
        bound("customer_id", Scalar::int64(*customers.iter().min().expect("rows")), Scalar::int64(*customers.iter().max().expect("rows")));
        bound("ts", Scalar::timestamp_us(times[0], Some("UTC".into())), Scalar::timestamp_us(times[rows - 1], Some("UTC".into())));
        let columns: Vec<ArrayRef> = vec![
            Arc::new(Int64Array::from(ids)),
            Arc::new(Int64Array::from(customers)),
            Arc::new(TimestampMicrosecondArray::from(times).with_timezone("UTC")),
            Arc::new(Float64Array::from(amounts)),
            Arc::new(StringArray::from(names)),
        ];
        let batch = RecordBatch::try_new(data_schema.clone(), columns).expect("a batch");
        let rel = format!("day={}/part-{f:05}.parquet", day_text(day));
        let url = format!("{root}/{rel}");
        write_parquet(&url, data_schema.clone(), std::slice::from_ref(&batch), "zstd", None).expect("a data file");
        let size = list_files(&url, "parquet", &storage).expect("the file")[0].size().expect("its size");
        let values = BTreeMap::from([("day".to_string(), Some(day_text(day)))]);
        actions.push(Action::Add(Add::new(&rel, values, size as i64, 1, Some(stats.to_json()))));
    }
    let log = LogStore::open(root, &storage).expect("the log");
    assert!(log.put_if_absent(&commit_file_name(0), write_commit(&actions)).expect("the commit"));
}

/// A log of `files` files with statistics of `columns` columns each, and no data but the
/// first file's: how long a table of that many files takes to open and to plan.
fn plan_only(files: usize, columns: usize) {
    let root = format!("{BUCKET}/wide");
    let storage = StorageOptions::default();
    let fields: Vec<Field> = (0..columns).map(|c| Field::new(format!("c{c}"), DataType::Int64, true)).collect();
    let schema = Arc::new(Schema::new(fields));
    let metadata = Metadata {
        id: "wide".into(),
        name: None,
        description: None,
        format: Format::default(),
        schema_string: schema_to_json(&schema).expect("a Delta schema"),
        partition_columns: vec![],
        configuration: BTreeMap::new(),
        created_time: Some(0),
    };
    let protocol = Protocol { min_reader_version: 1, min_writer_version: 2, reader_features: None, writer_features: None };
    let mut actions = vec![Action::CommitInfo(CommitInfo::new("WRITE", 1000)), Action::Protocol(protocol), Action::Metadata(metadata)];
    let batch = RecordBatch::try_new(schema.clone(), (0..columns).map(|_| Arc::new(Int64Array::from(vec![0i64])) as ArrayRef).collect()).expect("a batch");
    let first = format!("{root}/part-0000000.parquet");
    write_parquet(&first, schema.clone(), &[batch], "zstd", None).expect("a data file");
    let first_size = list_files(&first, "parquet", &storage).expect("the file")[0].size().expect("its size") as i64;
    for f in 0..files as i64 {
        let mut stats = FileStats { num_records: Some(1000), ..Default::default() };
        for c in 0..columns {
            let name = format!("c{c}");
            stats.min.insert(name.clone(), Scalar::int64(f * 1000));
            stats.max.insert(name.clone(), Scalar::int64(f * 1000 + 999));
            stats.null_count.insert(name, 0);
        }
        actions.push(Action::Add(Add::new(&format!("part-{f:07}.parquet"), BTreeMap::new(), if f == 0 { first_size } else { 64 << 20 }, 1, Some(stats.to_json()))));
    }
    let commit = write_commit(&actions);
    println!("a log of {files} files with statistics of {columns} columns: {} MB", commit.len() >> 20);
    assert!(LogStore::open(&root, &storage).expect("the log").put_if_absent(&commit_file_name(0), commit).expect("the commit"));
    let log = LogStore::open(&root, &storage).expect("the log");
    let started = Instant::now();
    let snapshot = iara_core::delta::Snapshot::load(&log, None).expect("the snapshot");
    println!("log replay: {:.2?}", started.elapsed());
    let started = Instant::now();
    let table = DeltaTable::from_snapshot(&root, &storage, snapshot).expect("the table");
    println!("table: {:.2?}", started.elapsed());
    let ctx = SessionContext::new();
    ctx.register_table("t", Arc::new(table)).expect("registered");
    let last = files as i64 * 1000;
    for sql in [
        "select count(*) from t".to_string(),
        format!("select sum(c1) from t where c0 >= {} and c3 < {last}", last / 2),
        "select a.c1, count(*) from t a join t b on a.c0 = b.c2 where b.c4 < 30000000 group by a.c1".to_string(),
        "select min(c0), max(c5) from t".to_string(),
    ] {
        for round in ["first", "again"] {
            let started = Instant::now();
            let plan = ctx.sql(&sql).and_then(|lf| lf.explain(true)).expect("a plan");
            let scan = plan.lines().find(|l| l.contains("files=")).map_or("", |l| l.trim());
            println!("explain ({round}): {:>10.2?}  {}  {}", started.elapsed(), &sql[..sql.len().min(50)], &scan[..scan.len().min(70)]);
        }
    }
}

fn main() {
    if std::env::args().nth(1).as_deref() == Some("plan") {
        return plan_only(arg(2, 100_000), arg(3, 32));
    }
    let (files, rows, latency) = (arg(1, 5000), arg(2, 2000), arg(3, 20));
    let root = format!("{BUCKET}/t");
    let started = Instant::now();
    build(&root, files, rows);
    println!("{files} files of {rows} rows written in {:.1?}; every request waits {latency} ms", started.elapsed());

    let storage = StorageOptions::new().with("latency_ms", latency.to_string());
    let requests = || scope_requests(BUCKET);
    let dim_schema = Arc::new(Schema::new(vec![Field::new("customer_id", DataType::Int64, true), Field::new("segment", DataType::Utf8, true)]));
    let dim_ids: Vec<i64> = (0..100).map(|i| i * 997).collect();
    let segments: Vec<String> = dim_ids.iter().map(|i| format!("s{}", i % 5)).collect();
    let dim = RecordBatch::try_new(dim_schema.clone(), vec![Arc::new(Int64Array::from(dim_ids)), Arc::new(StringArray::from(segments))]).expect("a batch");
    // a session that has read nothing yet: no footer is cached
    let session = || {
        iara_core::io::object::clear_object_stores();
        let ctx = SessionContext::new();
        ctx.register_table("t", Arc::new(DeltaTable::open(&root, &storage, None).expect("the table"))).expect("registered");
        ctx.register_table("dim", Arc::new(iara_core::io::memory::MemTable::new(dim_schema.clone(), vec![dim.clone()]))).expect("registered");
        ctx
    };
    let (before, started) = (requests(), Instant::now());
    session();
    println!("open: {:.2?}, {} requests", started.elapsed(), requests().since(before).count());

    let total = (files * rows) as i64;
    let last_day = day_text(FIRST_DAY + ((files - 1) / FILES_PER_DAY) as i64);
    let queries = [
        ("count", "select count(*) from t".to_string()),
        ("limit", "select * from t limit 10".to_string()),
        ("partition", format!("select sum(amount) from t where day = date '{last_day}'")),
        ("id range", format!("select sum(amount) from t where id >= {} and id < {}", total - 3 * rows as i64, total)),
        ("ts range", format!("select sum(amount) from t where ts >= timestamp '{last_day} 00:00:00'")),
        ("min max", "select min(id), max(id), count(customer_id) from t".to_string()),
        ("join", "select d.segment, sum(t.amount) from t join dim d on t.customer_id = d.customer_id group by d.segment".to_string()),
        ("full scan", "select region, sum(amount) from t group by region".to_string()),
    ];
    println!("{:<10} {:>10} {:>9} {:>10} {:>9}  plan", "query", "explain", "requests", "run", "requests");
    for (name, sql) in &queries {
        let ctx = session();
        let (before, started) = (requests(), Instant::now());
        let plan = ctx.sql(sql).and_then(|lf| lf.explain(true)).expect("a plan");
        let (explain, explain_requests) = (started.elapsed(), requests().since(before).count());
        let ctx = session();
        let (before, started) = (requests(), Instant::now());
        ctx.sql(sql).and_then(|lf| lf.collect()).expect("a result");
        let (run, run_requests) = (started.elapsed(), requests().since(before).count());
        let scan = plan.lines().find(|l| l.contains("files=")).map_or("", |l| l.trim());
        println!("{name:<10} {explain:>10.2?} {explain_requests:>9} {run:>10.2?} {run_requests:>9}  {}", &scan[..scan.len().min(110)]);
    }
}
