//! How many requests reading remote Parquet makes (object stores bill per
//! request: footers, listings, data), counted per bucket through the
//! counting wrapper every `memory://` store has.

use std::sync::{Arc, Once};

use arrow::array::{ArrayRef, AsArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Int64Type, Schema, SchemaRef};
use arrow::record_batch::RecordBatch;
use workhouse_core::SessionContext;
use workhouse_core::io::object::{StorageRequests, scope_requests};
use workhouse_core::io::parquet::write_parquet;

/// Small fetch groups make the grouping visible with small files. Every
/// test calls this first, so the variable is set before anything reads it.
fn init() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // SAFETY: set once, before any test of this binary reads the environment
        unsafe { std::env::set_var("WORKHOUSE_FETCH_TARGET_MB", "4") };
    });
}

const TARGET: u64 = 4 << 20;

fn schema() -> SchemaRef {
    Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, false), Field::new("amount", DataType::Float64, false)]))
}

fn batch(rows: i64, offset: i64) -> RecordBatch {
    let ids: Vec<i64> = (offset..offset + rows).collect();
    // a hash-like spread keeps the values from compressing away
    let amounts: Vec<f64> = ids.iter().map(|i| ((i.wrapping_mul(2654435761) % 1_000_003) as f64) * 0.37).collect();
    let cols: Vec<ArrayRef> = vec![Arc::new(Int64Array::from(ids)), Arc::new(Float64Array::from(amounts))];
    RecordBatch::try_new(schema(), cols).unwrap()
}

fn write(bucket: &str, name: &str, rows: i64, offset: i64, row_group: usize, compression: &str) {
    write_parquet(&format!("memory://{bucket}/t/{name}"), schema(), &[batch(rows, offset)], compression, Some(row_group)).unwrap();
}

/// Three small files of 10 000 rows (ids 0..30 000) in `memory://<bucket>/t/`.
fn small_files(bucket: &str) -> String {
    for i in 0..3 {
        write(bucket, &format!("part-{i}.parquet"), 10_000, i * 10_000, 1000, "zstd");
    }
    format!("memory://{bucket}/t")
}

fn now(bucket: &str) -> StorageRequests {
    scope_requests(&format!("memory://{bucket}"))
}

/// Requests made to the bucket since `before`.
fn since(bucket: &str, before: StorageRequests) -> StorageRequests {
    now(bucket).since(before)
}

fn nothing() -> StorageRequests {
    StorageRequests::default()
}

fn int(ctx: &SessionContext, sql: &str) -> i64 {
    let (_, batches) = ctx.sql(sql).unwrap().collect().unwrap();
    let a = arrow::compute::cast(batches[0].column(0), &DataType::Int64).unwrap();
    a.as_primitive::<Int64Type>().value(0)
}

fn table(url: &str) -> SessionContext {
    let ctx = SessionContext::new();
    ctx.register_parquet("t", url).unwrap();
    ctx
}

#[test]
fn small_files_cost_one_get_each_data_included() {
    init();
    let url = small_files("reqs-small");
    let before = now("reqs-small");
    let ctx = table(&url);
    // one LIST, and per file the one request that reads it whole
    let registered = since("reqs-small", before);
    assert_eq!((registered.list, registered.head, registered.get), (1, 0, 3), "{registered:?}");
    assert!(registered.bytes > 0 && registered.bytes < 3 * 512 * 1024);
    // count(*) comes from the footers; filtered and full scans read the files held in memory
    assert_eq!(int(&ctx, "select count(*) from t"), 30_000);
    assert_eq!(int(&ctx, "select count(*) from t where id > 25000"), 4_999);
    assert!(int(&ctx, "select sum(amount) from t where id > 25000") > 0);
    assert!(int(&ctx, "select count(*) from t where amount > 100") > 0);
    assert_eq!(since("reqs-small", before), registered, "queries made requests");
}

#[test]
fn a_second_table_object_makes_no_listing_or_footer_requests() {
    init();
    let url = small_files("reqs-again");
    let _first = table(&url);
    let before = now("reqs-again");
    // same files, new table object: the listing and the footers are remembered
    let second = table(&url);
    assert_eq!(since("reqs-again", before), nothing());
    assert_eq!(int(&second, "select count(*) from t"), 30_000);
    assert_eq!(since("reqs-again", before), nothing());
    // data is read when scanned: one request per file that has a row group to read
    assert_eq!(int(&second, "select count(*) from t where id > 5000 and amount >= 0"), 24_999);
    let scan = since("reqs-again", before);
    assert_eq!((scan.list, scan.head, scan.get), (0, 0, 3), "{scan:?}");
}

#[test]
fn sql_urls_share_listings_and_footers() {
    init();
    let url = small_files("reqs-sql");
    let ctx = SessionContext::new();
    let q = format!("select count(*) from read_parquet('{url}/*.parquet')");
    let before = now("reqs-sql");
    assert_eq!(int(&ctx, &q), 30_000);
    let first = since("reqs-sql", before);
    assert_eq!((first.list, first.get), (1, 3), "{first:?}");
    let before = now("reqs-sql");
    assert_eq!(int(&ctx, &q), 30_000);
    assert_eq!(int(&SessionContext::new(), &format!("select count(*) from \"{url}\"")), 30_000);
    assert_eq!(since("reqs-sql", before), nothing());
}

#[test]
fn a_full_scan_of_a_big_file_uses_few_requests() {
    init();
    // ~19.5 MB in 80 row groups of 12 500 rows, uncompressed
    write("reqs-big", "big.parquet", 1_000_000, 0, 12_500, "none");
    let url = "memory://reqs-big/t/big.parquet";
    let size = workhouse_core::io::list_files(url, "parquet", &Default::default()).unwrap()[0].size().unwrap();
    assert!(size > 4 * TARGET, "{size}");
    let before = now("reqs-big");
    let ctx = table(url);
    // (the HEAD that gave the size above is remembered)
    let footer = since("reqs-big", before);
    assert_eq!((footer.list, footer.head, footer.get), (0, 0, 1), "{footer:?}");
    assert_eq!(int(&ctx, "select count(*) from t"), 1_000_000);
    assert_eq!(since("reqs-big", before), footer, "count(*) reads no data");
    let expected: i64 = (0..1_000_000i64).sum();
    assert_eq!(int(&ctx, "select sum(id) from t"), expected);
    let scan = since("reqs-big", before);
    // row groups are fetched together: about one request per fetch target, not one per row group
    let bound = size.div_ceil(TARGET) + 1;
    assert!(scan.get <= bound, "{} requests for {size} bytes, bound {bound}: {scan:?}", scan.get);
    assert!(scan.get > 1 && scan.bytes < size * 2, "{scan:?}");
    // both columns, whole file
    let before = now("reqs-big");
    assert!(int(&ctx, "select count(*) from t where amount >= 0 and id >= 0") > 0);
    let all = since("reqs-big", before);
    assert!(all.get <= size.div_ceil(TARGET), "{all:?}");
}

#[test]
fn a_limit_fetches_a_row_group_or_two() {
    init();
    write("reqs-limit", "big.parquet", 400_000, 0, 12_500, "none");
    let ctx = table("memory://reqs-limit/t/big.parquet");
    let before = now("reqs-limit");
    let (_, batches) = ctx.sql("select * from t limit 10").unwrap().collect().unwrap();
    assert_eq!(batches.iter().map(|b| b.num_rows()).sum::<usize>(), 10);
    let used = since("reqs-limit", before);
    assert!(used.get <= 2 && used.bytes < 2 * (1 << 20), "{used:?}");
}

#[test]
fn a_footer_larger_than_the_guess_costs_a_second_request() {
    init();
    // ~6000 columns: the footer is far larger than the 512 KiB first read
    let n = 6000usize;
    let fields: Vec<Field> = (0..n).map(|i| Field::new(format!("column_with_a_long_name_{i}"), DataType::Int64, false)).collect();
    let schema = Arc::new(Schema::new(fields));
    let cols: Vec<ArrayRef> = (0..n).map(|i| Arc::new(Int64Array::from(vec![i as i64; 10])) as ArrayRef).collect();
    let batch = RecordBatch::try_new(schema.clone(), cols).unwrap();
    write_parquet("memory://reqs-wide/w.parquet", schema, &[batch], "zstd", None).unwrap();
    let before = now("reqs-wide");
    let ctx = SessionContext::new();
    ctx.register_parquet("w", "memory://reqs-wide/w.parquet").unwrap();
    assert_eq!(since("reqs-wide", before).get, 2);
    assert_eq!(int(&ctx, "select sum(column_with_a_long_name_5999) from w"), 59_990);
}

fn sales_batch() -> (SchemaRef, RecordBatch) {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("year", DataType::Int64, false),
        Field::new("region", DataType::Utf8, false),
        Field::new("amount", DataType::Float64, false),
    ]));
    let ids: Vec<i64> = (0..2_000).collect();
    let regions = ["north", "south", "east", "west"];
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(ids.clone())),
        Arc::new(Int64Array::from(ids.iter().map(|i| 2020 + i % 4).collect::<Vec<_>>())),
        Arc::new(StringArray::from(ids.iter().map(|i| regions[(*i / 4 % 4) as usize]).collect::<Vec<_>>())),
        Arc::new(Float64Array::from(ids.iter().map(|i| (*i % 100) as f64).collect::<Vec<_>>())),
    ];
    (schema.clone(), RecordBatch::try_new(schema, cols).unwrap())
}

#[test]
fn partition_pruning_skips_the_footers_of_pruned_files() {
    init();
    let ctx = SessionContext::new();
    let (schema, batch) = sales_batch();
    ctx.register_batches("sales", schema, vec![batch]);
    let out = "memory://reqs-part/sales/";
    ctx.sql(&format!("COPY (select * from sales) TO '{out}' (FORMAT parquet, PARTITION_BY (year, region))")).unwrap().collect().unwrap();

    let before = now("reqs-part");
    let t = table(out);
    // 16 files, one footer read for the schema
    let reg = since("reqs-part", before);
    assert_eq!((reg.list, reg.get), (1, 1), "{reg:?}");
    let sql = "select sum(amount) from t where year = 2021 and region = 'south'";
    let plan = t.sql(sql).unwrap().explain(true).unwrap();
    assert!(plan.contains("partitions=1/16"), "{plan}");
    // the answer is the same as without any pruning
    let expected = int(&ctx, "select sum(amount) from sales where year = 2021 and region = 'south'");
    assert_eq!(int(&t, sql), expected);
    assert_eq!(since("reqs-part", before).get, 2, "one footer for the file the filter keeps");
    // everything needs everything
    assert_eq!(int(&t, "select count(*) from t"), 2_000);
    assert_eq!(since("reqs-part", before).get, 16);
    let north = |op: &str| int(&t, &format!("select count(*) from t where region = 'north' and amount {op} 50"));
    assert_eq!(north("<") + north(">="), 500);
}

#[test]
fn writes_invalidate_the_listing_cache() {
    init();
    let url = small_files("reqs-writes");
    let before = now("reqs-writes");
    assert_eq!(int(&table(&url), "select count(*) from t"), 30_000);
    assert_eq!(since("reqs-writes", before).list, 1);
    // listed again within the cache lifetime: no request
    assert_eq!(int(&table(&url), "select count(*) from t"), 30_000);
    assert_eq!(since("reqs-writes", before).list, 1);
    // a file this process writes shows at once
    write("reqs-writes", "part-9.parquet", 500, 100_000, 1000, "zstd");
    assert_eq!(int(&table(&url), "select count(*) from t"), 30_500);
    assert_eq!(since("reqs-writes", before).list, 2);
}

#[test]
fn inserts_into_a_warehouse_on_an_object_store_are_seen_at_once() {
    init();
    let ctx = SessionContext::new();
    let (schema, batch) = sales_batch();
    ctx.register_batches("sales", schema, vec![batch]);
    ctx.set_warehouse(Some("memory://reqs-wh/wh"), &Default::default());
    let run = |sql: &str| ctx.sql(sql).unwrap().collect().unwrap();
    let count = |year: i64| int(&ctx, &format!("select count(*) from recent where year = {year}"));
    run("create table recent partitioned by (year) as select id, year, amount from sales where year >= 2022");
    assert_eq!(count(2023), 500);
    run("insert into recent select id, amount, year from sales where year = 2023 and id < 100");
    assert_eq!(count(2023), 525);
    run("insert into recent (id, year) select id, 2030 from sales where id < 10");
    assert_eq!(count(2030), 10);
    run("create or replace table recent as select id from sales where id < 3");
    assert_eq!(int(&ctx, "select count(*) from recent"), 3);
}
