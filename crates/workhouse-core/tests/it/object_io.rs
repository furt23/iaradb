//! Remote storage through the in-memory object store (`memory://`): what a
//! query reads from an object store must match what it reads from local
//! files.

use std::sync::Arc;

use arrow::array::{ArrayRef, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use arrow::record_batch::RecordBatch;
use arrow::util::pretty::pretty_format_batches;
use workhouse_core::io::csv::{CsvOptions, write_csv};
use workhouse_core::io::parquet::write_parquet;
use workhouse_core::io::{StorageOptions, list_files};
use workhouse_core::{SessionContext, WhError};

fn table(rows: i64, offset: i64) -> (SchemaRef, RecordBatch) {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("grp", DataType::Utf8, false),
        Field::new("amount", DataType::Float64, false),
    ]));
    let ids: Vec<i64> = (offset..offset + rows).collect();
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(ids.clone())),
        Arc::new(StringArray::from(ids.iter().map(|i| format!("g{}", i % 7)).collect::<Vec<_>>())),
        Arc::new(Float64Array::from(ids.iter().map(|i| *i as f64 * 0.5).collect::<Vec<_>>())),
    ];
    (schema.clone(), RecordBatch::try_new(schema, cols).unwrap())
}

/// The same three files locally and under `memory://<bucket>/sales/`.
fn write_both(bucket: &str) -> (tempdir::Dir, String) {
    let dir = tempdir::Dir::new(bucket);
    for (i, offset) in [0, 10_000, 20_000].iter().enumerate() {
        let (schema, batch) = table(10_000, *offset);
        let name = format!("part-{i}.parquet");
        write_parquet(&dir.join(&name), schema.clone(), std::slice::from_ref(&batch), "zstd", Some(1000)).unwrap();
        write_parquet(&format!("memory://{bucket}/sales/{name}"), schema, &[batch], "zstd", Some(1000)).unwrap();
    }
    (dir, format!("memory://{bucket}/sales"))
}

fn run(ctx: &SessionContext, sql: &str) -> String {
    let (_, batches) = ctx.sql(sql).unwrap().collect().unwrap();
    pretty_format_batches(&batches).unwrap().to_string()
}

const QUERIES: &[&str] = &[
    "select count(*) from t",
    "select grp, count(*), sum(amount), min(id), max(id) from t group by grp order by grp",
    "select id, amount from t where id between 12345 and 12360 order by id",
    "select * from t where grp = 'g3' and id > 29990 order by id",
    "select id from t order by id desc limit 5",
    "select avg(amount) from t where id < 500",
];

#[test]
fn remote_parquet_matches_local() {
    let (dir, url) = write_both("parity");
    let local = SessionContext::new();
    local.register_parquet("t", dir.path()).unwrap();
    let remote = SessionContext::new();
    remote.register_parquet("t", &url).unwrap();
    for q in QUERIES {
        assert_eq!(run(&local, q), run(&remote, q), "{q}");
    }
    // row groups are pruned remotely too
    let plan = remote.sql("select * from t where id > 29990").unwrap().explain(true).unwrap();
    assert!(plan.contains("row_groups=1/30"), "{plan}");
}

#[test]
fn urls_in_sql() {
    let (_dir, url) = write_both("sqlurls");
    let ctx = SessionContext::new();
    let q = format!("select count(*) as n from read_parquet('{url}/*.parquet', region => 'eu-west-1')");
    assert!(run(&ctx, &q).contains("30000"));
    let q = format!("select count(*) as n from \"{url}/part-1.parquet\"");
    assert!(run(&ctx, &q).contains("10000"));
}

#[test]
fn listing() {
    let (_dir, url) = write_both("listing");
    let none = StorageOptions::new();
    let names = |p: &str| list_files(p, "parquet", &none).unwrap().iter().map(|f| f.name()).collect::<Vec<_>>();
    assert_eq!(names(&url).len(), 3);
    assert_eq!(names(&format!("{url}/")).len(), 3);
    assert_eq!(names(&format!("{url}/part-[01].parquet")), vec![format!("{url}/part-0.parquet"), format!("{url}/part-1.parquet")]);
    assert_eq!(names("memory://listing/**/*.parquet").len(), 3);
    assert!(matches!(list_files(&format!("{url}/nope.parquet"), "parquet", &none), Err(WhError::Storage(m)) if m.contains("not found")));
    assert!(list_files("memory://listing/empty/", "parquet", &none).is_err());
    assert!(list_files("gs://x/y", "parquet", &none).is_err());
}

#[test]
fn large_footer_needs_a_second_request() {
    // ~1500 columns: the footer is far larger than the first 64 KiB guess
    let fields: Vec<Field> = (0..1500).map(|i| Field::new(format!("column_with_a_long_name_{i}"), DataType::Int64, false)).collect();
    let schema = Arc::new(Schema::new(fields));
    let cols: Vec<ArrayRef> = (0..1500).map(|i| Arc::new(Int64Array::from(vec![i as i64; 10])) as ArrayRef).collect();
    let batch = RecordBatch::try_new(schema.clone(), cols).unwrap();
    write_parquet("memory://wide/w.parquet", schema, &[batch], "zstd", None).unwrap();
    let ctx = SessionContext::new();
    ctx.register_parquet("w", "memory://wide/w.parquet").unwrap();
    assert!(run(&ctx, "select sum(column_with_a_long_name_1499) as s from w").contains("14990"));
}

#[test]
fn remote_csv_with_small_ranges_matches_local() {
    let dir = tempdir::Dir::new("csv");
    let (_, batch) = table(5_000, 0);
    let local = dir.join("t.csv");
    write_csv(&local, std::slice::from_ref(&batch), true, b',').unwrap();
    write_csv("memory://csv/t.csv", &[batch], true, b',').unwrap();
    for chunk in [7, 100, 4096] {
        // tiny ranges: most lines straddle a range end, many ranges hold no line start
        let opts = CsvOptions { chunk_bytes: Some(chunk), ..Default::default() };
        let (l, r) = (SessionContext::new(), SessionContext::new());
        l.register_csv("t", &local, opts.clone()).unwrap();
        r.register_csv("t", "memory://csv/t.csv", opts).unwrap();
        for q in QUERIES {
            assert_eq!(run(&l, q), run(&r, q), "chunk {chunk}: {q}");
        }
    }
}

#[test]
fn deferred_tables_load_on_first_use_and_retry() {
    let ctx = SessionContext::new();
    ctx.register_parquet_with("later", "memory://deferred/t", &StorageOptions::new(), true).unwrap();
    assert_eq!(ctx.is_loaded("later"), Some(false));
    assert!(ctx.sql("select count(*) from later").and_then(|f| f.collect()).is_err());
    let (schema, batch) = table(10, 0);
    write_parquet("memory://deferred/t/a.parquet", schema, &[batch], "zstd", None).unwrap();
    assert!(run(&ctx, "select count(*) as n from later").contains("10"));
    assert_eq!(ctx.is_loaded("later"), Some(true));
}

#[test]
fn cancelled_requests_stop_waiting() {
    use workhouse_core::exec::query::with_query;
    use workhouse_core::io::object::block_on_cancellable;
    let r: Result<(), WhError> = with_query(|q| {
        q.cancel();
        block_on_cancellable(std::future::pending(), Some(q))
    });
    assert!(matches!(r, Err(WhError::Cancelled)));
}

#[test]
fn storage_options_never_show_secrets() {
    let o = StorageOptions::new().with("secret_access_key", "s3cr3t").with("session_token", "t0k3n");
    let shown = format!("{o:?}");
    assert!(!shown.contains("s3cr3t") && !shown.contains("t0k3n"), "{shown}");
}

mod tempdir {
    use std::path::PathBuf;

    pub struct Dir(PathBuf);

    impl Dir {
        pub fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("wh-object-io-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&p);
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        pub fn path(&self) -> &str {
            self.0.to_str().unwrap()
        }
        pub fn join(&self, name: &str) -> String {
            self.0.join(name).to_str().unwrap().to_string()
        }
    }

    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}
