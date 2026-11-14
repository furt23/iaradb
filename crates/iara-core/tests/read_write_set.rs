//! A query reports the tables it read (location and Delta version) and table
//! writes are noted in a process-wide log while plans are recorded. The log
//! and the recording switch are global, so the cases run one at a time.

use std::path::PathBuf;
use std::sync::Mutex;

use iara_core::SessionContext;
use iara_core::delta::{VersionSpec, WriteMode, write_table};
use iara_core::exec::query::TableRead;
use iara_core::exec::write_log::take_writes;
use iara_core::io::StorageOptions;
use iara_core::io::parquet::write_parquet;
use iara_core::physical::analyze::record_plans;

static SERIAL: Mutex<()> = Mutex::new(());

struct Dir(PathBuf);

impl Dir {
    fn new(tag: &str) -> Dir {
        let p = std::env::temp_dir().join(format!("wh-rws-{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Dir(p)
    }

    fn join(&self, name: &str) -> String {
        self.0.join(name).to_str().unwrap().replace('\\', "/")
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn storage() -> StorageOptions {
    StorageOptions::new()
}

/// A Delta table at `path` with one row, at version 0, registered as `name`.
fn delta(ctx: &SessionContext, name: &str, path: &str) {
    let lf = ctx.sql("select 1 as id").unwrap();
    write_table(&lf, path, &storage(), WriteMode::Overwrite, &[], false).unwrap();
    ctx.register_delta(name, path, &storage(), None, false).unwrap();
}

fn read(location: &str, version: Option<u64>) -> TableRead {
    TableRead { location: location.to_string(), version }
}

fn reads_of(ctx: &SessionContext, sql: &str) -> Vec<TableRead> {
    ctx.sql(sql).unwrap().collect_profiled().unwrap().2.reads
}

#[test]
fn delta_read_reports_root_and_version() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = Dir::new("delta");
    let path = dir.join("t");
    let ctx = SessionContext::new();
    delta(&ctx, "d", &path);
    assert_eq!(reads_of(&ctx, "select sum(id) from d"), vec![read(&path, Some(0))]);

    // a frame planned before an INSERT reads the version the INSERT made
    let lf = ctx.sql("select sum(id) from d").unwrap();
    ctx.sql("insert into d select 2 as id").unwrap().collect().unwrap();
    assert_eq!(lf.collect_profiled().unwrap().2.reads, vec![read(&path, Some(1))]);

    // time travel reads the version asked for
    let old = SessionContext::new();
    old.register_delta("d", &path, &storage(), Some(VersionSpec::Version(0)), false).unwrap();
    assert_eq!(reads_of(&old, "select sum(id) from d"), vec![read(&path, Some(0))]);
}

#[test]
fn parquet_read_reports_its_path_without_a_version() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = Dir::new("parquet");
    let path = dir.join("f.parquet");
    let ctx = SessionContext::new();
    let (schema, batches) = ctx.sql("select 1 as id").unwrap().collect().unwrap();
    write_parquet(&path, schema, &batches, "zstd", None).unwrap();
    let stats = ctx.read_parquet(&path).unwrap().collect_profiled().unwrap().2;
    assert_eq!(stats.reads, vec![read(&path, None)]);
}

#[test]
fn a_join_reports_each_table_once() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = Dir::new("join");
    let (a, b) = (dir.join("a"), dir.join("b"));
    let ctx = SessionContext::new();
    delta(&ctx, "a", &a);
    delta(&ctx, "b", &b);
    let mut got = reads_of(&ctx, "select a.id from a join b on a.id = b.id join a a2 on a2.id = b.id");
    got.sort_by(|x, y| x.location.cmp(&y.location));
    assert_eq!(got, vec![read(&a, Some(0)), read(&b, Some(0))]);
}

#[test]
fn insert_notes_a_write_that_matches_the_read() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = Dir::new("write");
    let path = dir.join("t");
    let ctx = SessionContext::new();
    record_plans(true);
    take_writes();
    delta(&ctx, "d", &path);
    take_writes();

    ctx.sql("insert into d select 2 as id").unwrap().collect().unwrap();
    let writes = take_writes();
    assert_eq!(writes.len(), 1, "{writes:?}");
    let read = reads_of(&ctx, "select sum(id) from d").remove(0);
    assert_eq!((writes[0].location.as_str(), writes[0].version), (read.location.as_str(), Some(1)));
    assert_eq!(read.version, Some(1));
    assert!(take_writes().is_empty());

    record_plans(false);
    ctx.sql("insert into d select 3 as id").unwrap().collect().unwrap();
    assert!(take_writes().is_empty());
}

#[test]
fn table_locations_map_to_catalog_keys() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = Dir::new("locations");
    let path = dir.join("t");
    let ctx = SessionContext::new();
    delta(&ctx, "d", &path);
    ctx.sql("create view v as select * from d").unwrap().collect().unwrap();
    ctx.register_delta("later", &path, &storage(), None, true).unwrap();
    assert_eq!(ctx.table_locations(), vec![(path, "main.main.d".to_string())]);
}

#[test]
fn a_query_that_reads_the_clock_or_chance_is_volatile() {
    let _g = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
    let dir = Dir::new("volatile");
    let ctx = SessionContext::new();
    delta(&ctx, "d", &dir.join("t"));
    let volatile = |sql: &str| ctx.sql(sql).unwrap().collect_profiled().unwrap().2.volatile;
    assert!(!volatile("select sum(id) from d"));
    assert!(volatile("select id from d where current_date >= date '2020-01-01'"));
    assert!(volatile("select id, now() as at from d"));
    assert!(volatile("select id from d order by random()"));
    // a view hides the function from the query's text, not from its plan
    ctx.sql("create view recent as select id from d where current_date >= date '2020-01-01'").unwrap().collect().unwrap();
    assert!(volatile("select count(*) from recent"));
}
