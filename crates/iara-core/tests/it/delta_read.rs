//! Reading Delta tables: tables are built by writing Parquet files and
//! hand-made commits, then queried through SQL and the API.

use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;

use arrow::array::{Array, ArrayRef, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use parquet::arrow::ArrowWriter;
use iara_core::delta::stats::FileStats;
use iara_core::delta::{
    Action, Add, CommitInfo, DeltaTable, Format, LogStore, Metadata, Protocol, Remove, Snapshot, VersionSpec, commit_file_name, is_delta_table,
    schema_to_json, write_checkpoint, write_commit,
};
use iara_core::io::{StorageOptions, TableProvider};
use iara_core::{Scalar, SessionContext};

use crate::support::dir::TempDir;
use crate::support::rows_in;

struct Table {
    dir: TempDir,
    log: LogStore,
}

fn long(name: &str) -> Field {
    Field::new(name, DataType::Int64, true)
}

fn string(name: &str) -> Field {
    Field::new(name, DataType::Utf8, true)
}

fn ints(v: &[Option<i64>]) -> ArrayRef {
    Arc::new(Int64Array::from(v.to_vec()))
}

fn strings(v: &[Option<&str>]) -> ArrayRef {
    Arc::new(StringArray::from(v.to_vec()))
}

fn batch(fields: Vec<Field>, columns: Vec<ArrayRef>) -> RecordBatch {
    RecordBatch::try_new(Arc::new(Schema::new(fields)), columns).unwrap()
}

/// Bounds of the `long` columns of `batch`, as the log's statistics.
fn long_stats(batch: &RecordBatch) -> String {
    let mut stats = FileStats { num_records: Some(batch.num_rows() as u64), ..Default::default() };
    for (field, column) in batch.schema().fields().iter().zip(batch.columns()) {
        let Some(values) = column.as_any().downcast_ref::<Int64Array>() else { continue };
        let name = field.name().clone();
        stats.null_count.insert(name.clone(), values.null_count() as u64);
        if let (Some(lo), Some(hi)) = (arrow::compute::min(values), arrow::compute::max(values)) {
            stats.min.insert(name.clone(), Scalar::int64(lo));
            stats.max.insert(name, Scalar::int64(hi));
        }
    }
    stats.to_json()
}

fn write_file(root: &Path, rel: &str, batch: &RecordBatch) -> i64 {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let mut w = ArrowWriter::try_new(std::fs::File::create(&path).unwrap(), batch.schema(), None).unwrap();
    w.write(batch).unwrap();
    w.close().unwrap();
    std::fs::metadata(&path).unwrap().len() as i64
}

fn metadata(schema: &Schema, partitions: &[&str]) -> Metadata {
    Metadata {
        id: "table".into(),
        name: None,
        description: None,
        format: Format::default(),
        schema_string: schema_to_json(schema).unwrap(),
        partition_columns: partitions.iter().map(|p| p.to_string()).collect(),
        configuration: BTreeMap::new(),
        created_time: Some(0),
    }
}

fn protocol() -> Protocol {
    Protocol { min_reader_version: 1, min_writer_version: 2, reader_features: None, writer_features: None }
}

impl Table {
    fn new(tag: &str) -> Table {
        let dir = TempDir::new(tag);
        let log = LogStore::open(&dir.join(""), &StorageOptions::default()).unwrap();
        Table { dir, log }
    }

    fn root(&self) -> String {
        self.dir.0.display().to_string()
    }

    /// Commit `version` at `ts` (milliseconds).
    fn commit(&self, version: u64, ts: i64, actions: Vec<Action>) {
        let mut all = vec![Action::CommitInfo(CommitInfo::new("WRITE", ts))];
        all.extend(actions);
        assert!(self.log.put_if_absent(&commit_file_name(version), write_commit(&all)).unwrap());
    }

    /// Write `batch` as a data file (with statistics) and return the `add` of it.
    fn file(&self, rel: &str, partition: &[(&str, Option<&str>)], batch: &RecordBatch) -> Action {
        let size = write_file(&self.dir.0, rel, batch);
        let values = partition.iter().map(|(k, v)| (k.to_string(), v.map(String::from))).collect();
        Action::Add(Add::new(rel, values, size, 1, Some(long_stats(batch))))
    }

    fn open(&self, version: Option<VersionSpec>) -> DeltaTable {
        DeltaTable::open(&self.root(), &StorageOptions::default(), version).unwrap()
    }

    fn context(&self, version: Option<VersionSpec>) -> SessionContext {
        let ctx = SessionContext::new();
        ctx.register_table("t", Arc::new(self.open(version))).unwrap();
        ctx
    }
}

fn plan(ctx: &SessionContext, sql: &str) -> String {
    ctx.sql(sql).unwrap().explain(true).unwrap()
}

#[test]
fn a_plain_table_is_queried() {
    let t = Table::new("delta-plain");
    let schema = Schema::new(vec![long("id"), string("name")]);
    let fields = || vec![long("id"), string("name")];
    let a = batch(fields(), vec![ints(&[Some(1), Some(2)]), strings(&[Some("a"), None])]);
    let b = batch(fields(), vec![ints(&[Some(3)]), strings(&[Some("c")])]);
    t.commit(0, 1000, vec![Action::Protocol(protocol()), Action::Metadata(metadata(&schema, &[])), t.file("a.parquet", &[], &a), t.file("b.parquet", &[], &b)]);

    assert!(is_delta_table(&t.root(), &StorageOptions::default()));
    let ctx = t.context(None);
    assert_eq!(rows_in(&ctx, "select count(*), sum(id) from t"), "3,6");
    assert_eq!(rows_in(&ctx, "select id, name from t order by id"), "1,a|2,null|3,c");
    assert_eq!(rows_in(&ctx, "select name from t where id = 3"), "c");
    assert_eq!(t.open(None).num_rows(), Some(3));
    assert_eq!(t.open(None).kind(), "delta");

    let frame = ctx.read_delta(&t.root(), &StorageOptions::default(), None).unwrap();
    let (_, batches) = frame.collect().unwrap();
    assert_eq!(batches.iter().map(|b| b.num_rows()).sum::<usize>(), 3);
}

#[test]
fn a_folder_without_a_log_is_not_a_table() {
    let dir = TempDir::new("delta-none");
    let root = dir.0.display().to_string();
    assert!(!is_delta_table(&root, &StorageOptions::default()));
    assert!(!is_delta_table(&dir.join("missing"), &StorageOptions::default()));
    assert!(DeltaTable::open(&root, &StorageOptions::default(), None).is_err());
}

#[test]
fn partition_columns_come_from_the_log_and_filters_skip_files() {
    let t = Table::new("delta-parts");
    // the partition column sits between the data columns, and is not in the files
    let schema = Schema::new(vec![long("id"), string("region"), long("amount")]);
    let data = |ids: &[i64]| {
        batch(vec![long("id"), long("amount")], vec![ints(&ids.iter().map(|i| Some(*i)).collect::<Vec<_>>()), ints(&ids.iter().map(|i| Some(i * 10)).collect::<Vec<_>>())])
    };
    t.commit(
        0,
        1000,
        vec![
            Action::Protocol(protocol()),
            Action::Metadata(metadata(&schema, &["region"])),
            t.file("region=north/a.parquet", &[("region", Some("north"))], &data(&[1, 2])),
            t.file("region=south/b.parquet", &[("region", Some("south"))], &data(&[3])),
            t.file("region=__HIVE_DEFAULT_PARTITION__/c.parquet", &[("region", None)], &data(&[4])),
        ],
    );
    let ctx = t.context(None);
    assert_eq!(rows_in(&ctx, "select * from t order by id"), "1,north,10|2,north,20|3,south,30|4,null,40");
    assert_eq!(rows_in(&ctx, "select region, sum(amount) from t group by region order by region"), "north,30|south,30|null,40");
    assert_eq!(rows_in(&ctx, "select id from t where region = 'south'"), "3");
    let p = plan(&ctx, "select id from t where region = 'south'");
    assert!(p.contains("partitions=1/3"), "{p}");
    assert_eq!(rows_in(&ctx, "select count(*) from t where region is null"), "1");
    assert_eq!(rows_in(&ctx, "select region from t where id = 2"), "north");
}

#[test]
fn statistics_in_the_log_skip_files() {
    let t = Table::new("delta-stats");
    let schema = Schema::new(vec![long("id"), long("v")]);
    let part = |lo: i64, hi: i64, nulls: bool| {
        let ids: Vec<Option<i64>> = (lo..hi).map(Some).collect();
        let vs: Vec<Option<i64>> = (lo..hi).map(|i| if nulls && i % 2 == 0 { None } else { Some(i) }).collect();
        batch(vec![long("id"), long("v")], vec![ints(&ids), ints(&vs)])
    };
    t.commit(
        0,
        1000,
        vec![
            Action::Protocol(protocol()),
            Action::Metadata(metadata(&schema, &[])),
            t.file("f0.parquet", &[], &part(0, 100, false)),
            t.file("f1.parquet", &[], &part(100, 200, false)),
            t.file("f2.parquet", &[], &part(200, 300, true)),
            t.file("f3.parquet", &[], &part(300, 400, false)),
        ],
    );
    let ctx = t.context(None);
    let files_of = |sql: &str| {
        let p = plan(&ctx, sql);
        let at = p.find("files=").unwrap_or_else(|| panic!("{p}")) + "files=".len();
        p[at..].split(|c: char| !c.is_ascii_digit()).next().unwrap().parse::<usize>().unwrap()
    };
    assert_eq!(files_of("select count(*) from t"), 4);
    assert_eq!(files_of("select sum(v) from t where id >= 250"), 2);
    assert_eq!(rows_in(&ctx, "select count(*) from t where id >= 250"), "150");
    assert_eq!(files_of("select count(*) from t where id = 150"), 1);
    assert_eq!(files_of("select count(*) from t where id < 100 or id > 350"), 2);
    assert_eq!(files_of("select count(*) from t where id between 90 and 110"), 2);
    assert_eq!(files_of("select count(*) from t where id > 1000"), 0);
    assert_eq!(rows_in(&ctx, "select count(*) from t where id > 1000"), "0");
    // null counts: only the third file has nulls
    assert_eq!(files_of("select count(*) from t where v is null"), 1);
    assert_eq!(rows_in(&ctx, "select count(*) from t where v is null"), "50");
    assert_eq!(files_of("select count(*) from t where v is not null"), 4);
    // a filter on an expression of the column cannot skip
    assert_eq!(files_of("select count(*) from t where id + 0 >= 250"), 4);
}

#[test]
fn versions_and_timestamps_travel() {
    let t = Table::new("delta-travel");
    let schema = Schema::new(vec![long("id")]);
    let one = |i: i64| batch(vec![long("id")], vec![ints(&[Some(i)])]);
    t.commit(0, 1000, vec![Action::Protocol(protocol()), Action::Metadata(metadata(&schema, &[])), t.file("a.parquet", &[], &one(1))]);
    t.commit(1, 2000, vec![t.file("b.parquet", &[], &one(2))]);
    t.commit(2, 3000, vec![t.file("c.parquet", &[], &one(3))]);
    let sum = |v: Option<VersionSpec>| rows_in(&t.context(v), "select sum(id) from t");

    assert_eq!(sum(None), "6");
    assert_eq!(sum(Some(VersionSpec::Version(0))), "1");
    assert_eq!(sum(Some(VersionSpec::Version(1))), "3");
    assert_eq!(sum(Some(VersionSpec::Timestamp(2500))), "3");
    assert_eq!(sum(Some(VersionSpec::Timestamp(3000))), "6");
    assert_eq!(sum(Some(VersionSpec::Timestamp(9999))), "6");
    assert_eq!(t.open(Some(VersionSpec::Version(1))).version(), 1);
    assert!(DeltaTable::open(&t.root(), &StorageOptions::default(), Some(VersionSpec::Version(7))).is_err());
    assert!(DeltaTable::open(&t.root(), &StorageOptions::default(), Some(VersionSpec::Timestamp(10))).is_err());
}

#[test]
fn removed_files_are_not_read() {
    let t = Table::new("delta-removed");
    let schema = Schema::new(vec![long("id")]);
    let one = |i: i64| batch(vec![long("id")], vec![ints(&[Some(i)])]);
    let (a, b) = (t.file("a.parquet", &[], &one(1)), t.file("b.parquet", &[], &one(2)));
    let Action::Add(a_add) = a.clone() else { unreachable!() };
    t.commit(0, 1000, vec![Action::Protocol(protocol()), Action::Metadata(metadata(&schema, &[])), a, b]);
    t.commit(1, 2000, vec![Action::Remove(Remove::of(&a_add, 2000, true)), t.file("c.parquet", &[], &one(3))]);
    // the removed file is gone from disk: reading it would fail
    std::fs::remove_file(t.dir.0.join("a.parquet")).unwrap();
    let ctx = t.context(None);
    assert_eq!(rows_in(&ctx, "select id from t order by id"), "2|3");
    assert_eq!(t.open(None).snapshot().files.len(), 2);
}

#[test]
fn files_written_before_a_column_was_added_read_null_for_it() {
    let t = Table::new("delta-evolve");
    let old = Schema::new(vec![long("id")]);
    let new = Schema::new(vec![long("id"), long("extra"), string("tag")]);
    let old_file = batch(vec![long("id")], vec![ints(&[Some(1), Some(2)])]);
    t.commit(0, 1000, vec![Action::Protocol(protocol()), Action::Metadata(metadata(&old, &[])), t.file("old.parquet", &[], &old_file)]);
    // the new file has the new columns, in another order
    let fresh = batch(
        vec![string("tag"), long("extra"), long("id")],
        vec![strings(&[Some("x"), Some("y")]), ints(&[Some(70), Some(80)]), ints(&[Some(3), Some(4)])],
    );
    t.commit(1, 2000, vec![Action::Metadata(metadata(&new, &[])), t.file("new.parquet", &[], &fresh)]);
    let ctx = t.context(None);
    assert_eq!(rows_in(&ctx, "select * from t order by id"), "1,null,null|2,null,null|3,70,x|4,80,y");
    // only a column the old file lacks
    assert_eq!(rows_in(&ctx, "select extra from t order by extra"), "70|80|null|null");
    assert_eq!(rows_in(&ctx, "select count(tag), count(*) from t"), "2,4");
    assert_eq!(rows_in(&ctx, "select id from t where extra = 80"), "4");
    assert_eq!(rows_in(&ctx, "select id from t where extra is null order by id"), "1|2");
    assert_eq!(rows_in(&ctx, "select tag, sum(id) from t group by tag order by tag"), "x,3|y,4|null,3");
    assert_eq!(rows_in(&ctx, "select count(*) from t"), "4");
    // time travel to the old schema
    assert_eq!(rows_in(&t.context(Some(VersionSpec::Version(0))), "select * from t"), "1|2");
}

#[test]
fn a_checkpointed_table_reads_without_its_early_commits() {
    let t = Table::new("delta-checkpoint");
    let schema = Schema::new(vec![long("id")]);
    let one = |i: i64| batch(vec![long("id")], vec![ints(&[Some(i)])]);
    t.commit(0, 1000, vec![Action::Protocol(protocol()), Action::Metadata(metadata(&schema, &[])), t.file("a.parquet", &[], &one(1))]);
    t.commit(1, 2000, vec![t.file("b.parquet", &[], &one(2))]);
    let snapshot = Snapshot::load(&t.log, None).unwrap();
    write_checkpoint(&t.log, &snapshot).unwrap();
    t.commit(2, 3000, vec![t.file("c.parquet", &[], &one(3))]);
    for v in 0..=1 {
        t.log.delete(&commit_file_name(v)).unwrap();
    }
    assert_eq!(rows_in(&t.context(None), "select sum(id) from t"), "6");
    assert_eq!(rows_in(&t.context(Some(VersionSpec::Version(1))), "select sum(id) from t"), "3");
}

#[test]
fn an_empty_table_reads_no_rows() {
    let t = Table::new("delta-empty");
    let schema = Schema::new(vec![long("id"), string("s")]);
    t.commit(0, 1000, vec![Action::Protocol(protocol()), Action::Metadata(metadata(&schema, &[]))]);
    let ctx = t.context(None);
    assert_eq!(rows_in(&ctx, "select count(*) from t"), "0");
    assert_eq!(rows_in(&ctx, "select id, s from t"), "");
}

#[test]
fn partition_values_are_typed_by_the_schema() {
    let t = Table::new("delta-typed");
    let schema = Schema::new(vec![long("id"), Field::new("day", DataType::Date32, true), Field::new("n", DataType::Int32, true)]);
    let data = |i: i64| batch(vec![long("id")], vec![ints(&[Some(i)])]);
    t.commit(
        0,
        1000,
        vec![
            Action::Protocol(protocol()),
            Action::Metadata(metadata(&schema, &["day", "n"])),
            t.file("d1/a.parquet", &[("day", Some("2024-05-01")), ("n", Some("7"))], &data(1)),
            t.file("d2/b.parquet", &[("day", Some("2024-05-02")), ("n", Some(""))], &data(2)),
        ],
    );
    let ctx = t.context(None);
    assert_eq!(rows_in(&ctx, "select id, day, n from t order by id"), "1,2024-05-01,7|2,2024-05-02,null");
    assert_eq!(rows_in(&ctx, "select id from t where day = date '2024-05-02'"), "2");
    assert_eq!(rows_in(&ctx, "select id from t where n = 7"), "1");
}

#[test]
fn a_table_on_an_object_store_reads_only_the_files_it_needs() {
    let storage = StorageOptions::default();
    let root = "memory://delta-read-remote/t";
    let log = LogStore::open(root, &storage).unwrap();
    let schema = Schema::new(vec![long("id"), string("p"), long("v")]);
    let mut adds = vec![Action::Protocol(protocol()), Action::Metadata(metadata(&schema, &["p"]))];
    for (i, p) in ["a", "b", "c"].iter().enumerate() {
        let data = batch(vec![long("id"), long("v")], vec![ints(&[Some(i as i64 * 10), Some(i as i64 * 10 + 1)]), ints(&[Some(1), None])]);
        let rel = format!("p={p}/f.parquet");
        iara_core::io::parquet::write_parquet(&format!("{root}/{rel}"), data.schema(), std::slice::from_ref(&data), "zstd", None).unwrap();
        let size = iara_core::io::list_files(&format!("{root}/{rel}"), "parquet", &storage).unwrap()[0].size().unwrap();
        let values = BTreeMap::from([("p".to_string(), Some(p.to_string()))]);
        adds.push(Action::Add(Add::new(&rel, values, size as i64, 1, Some(long_stats(&data)))));
    }
    let mut all = vec![Action::CommitInfo(CommitInfo::new("WRITE", 1000))];
    all.extend(adds);
    assert!(log.put_if_absent(&commit_file_name(0), write_commit(&all)).unwrap());

    assert!(is_delta_table(root, &storage));
    let ctx = SessionContext::new();
    ctx.register_table("t", Arc::new(DeltaTable::open(root, &storage, None).unwrap())).unwrap();
    assert_eq!(rows_in(&ctx, "select * from t order by id"), "0,a,1|1,a,null|10,b,1|11,b,null|20,c,1|21,c,null");
    assert_eq!(rows_in(&ctx, "select sum(v) from t where p = 'b' and id > 5"), "1");
    // the statistics skip the files of `a` and `c`: one file is scanned
    let p = plan(&ctx, "select sum(v) from t where id >= 10 and id < 15");
    assert!(p.contains("files=1"), "{p}");
    assert_eq!(rows_in(&ctx, "select sum(v) from t where id >= 10 and id < 15"), "1");
}
