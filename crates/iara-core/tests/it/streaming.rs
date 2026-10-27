//! Streaming results: the same rows as `collect`, in order, without
//! collecting; results written to files as they are produced.

use std::sync::Arc;

use arrow::array::{ArrayRef, Float64Array, Int64Array, StringArray};
use arrow::compute::concat_batches;
use arrow::datatypes::{DataType, Field, Schema, SchemaRef};
use arrow::record_batch::RecordBatch;
use iara_core::exec::memory;
use iara_core::exec::spill::spilled_bytes;
use iara_core::io::StorageOptions;
use iara_core::io::parquet::ParquetOptions;
use iara_core::{LazyFrame, SessionContext};

fn table(rows: i64) -> (SchemaRef, Vec<RecordBatch>) {
    let schema = Arc::new(Schema::new(vec![
        Field::new("id", DataType::Int64, false),
        Field::new("g", DataType::Int64, false),
        Field::new("s", DataType::Utf8, false),
        Field::new("x", DataType::Float64, false),
    ]));
    let batches = (0..rows)
        .step_by(50_000)
        .map(|start| {
            let ids: Vec<i64> = (start..(start + 50_000).min(rows)).collect();
            let cols: Vec<ArrayRef> = vec![
                Arc::new(Int64Array::from(ids.clone())),
                Arc::new(Int64Array::from(ids.iter().map(|i| (i * 37) % 1000).collect::<Vec<_>>())),
                Arc::new(StringArray::from(ids.iter().map(|i| format!("row-{:08}", (i * 7) % 300_007)).collect::<Vec<_>>())),
                Arc::new(Float64Array::from(ids.iter().map(|i| (*i % 97) as f64).collect::<Vec<_>>())),
            ];
            RecordBatch::try_new(schema.clone(), cols).unwrap()
        })
        .collect();
    (schema, batches)
}

/// (schema, batches, number of emits)
fn streamed(lf: &LazyFrame) -> (SchemaRef, RecordBatch, usize) {
    let mut started: Option<SchemaRef> = None;
    let out = parking_lot::Mutex::new(vec![]);
    let (schema, _) = lf
        .stream(
            &mut |s| {
                started = Some(s.clone());
                Ok(())
            },
            &mut |b| {
                out.lock().push(b);
                Ok(())
            },
        )
        .unwrap();
    assert_eq!(started.as_ref(), Some(&schema), "the schema comes first");
    let batches = out.into_inner();
    let n = batches.len();
    (schema.clone(), concat_batches(&schema, &batches).unwrap(), n)
}

fn collected(lf: &LazyFrame) -> RecordBatch {
    let (schema, batches) = lf.collect().unwrap();
    concat_batches(&schema, &batches).unwrap()
}

const QUERIES: &[&str] = &[
    "select id, s, x * 2 as y from t where g < 500",
    "select * from t order by s desc, id",
    "select id, s from t where x > 10 limit 1000 offset 25000",
    "select g, count(*) as n, sum(x) as sx from t group by g order by g",
    "select a.id, b.s from t a join t b on a.id = b.id where a.g = 7 order by a.id",
];

#[test]
fn streams_match_collect_and_sinks_write_files() {
    let _memory = crate::support::memory_lock();
    let (schema, batches) = table(400_000);
    let ctx = SessionContext::new();
    ctx.register_batches("t", schema, batches).unwrap();

    for q in QUERIES {
        let lf = ctx.sql(q).unwrap();
        let (_, got, _) = streamed(&lf);
        assert_eq!(got, collected(&lf), "{q}");
    }

    // files written as the result streams, local and on an object store
    let dir = std::env::temp_dir().join(format!("wh-streaming-{}", std::process::id()));
    let lf = ctx.sql("select id, g, s from t where id % 3 = 0 order by g, id").unwrap();
    let expected = collected(&lf);
    let none = StorageOptions::new();
    for path in [dir.join("out.parquet").to_string_lossy().to_string(), "memory://streaming/out.parquet".to_string()] {
        assert_eq!(lf.sink_parquet(&path, &ParquetOptions { row_group_size: Some(10_000), ..Default::default() }, &none).unwrap(), expected.num_rows());
        let back = collected(&ctx.read_parquet(&path).unwrap());
        // strings come back as views: compare values, not physical types
        let cols: Vec<ArrayRef> =
            back.columns().iter().zip(expected.columns()).map(|(c, e)| arrow::compute::cast(c, e.data_type()).unwrap()).collect();
        assert_eq!(&cols, expected.columns(), "{path}");
    }
    let csv = dir.join("out.csv").to_string_lossy().to_string();
    assert_eq!(lf.sink_csv(&csv, true, b',', &none).unwrap(), expected.num_rows());
    let text = std::fs::read_to_string(&csv).unwrap();
    assert_eq!(text.lines().count(), expected.num_rows() + 1);
    let _ = std::fs::remove_dir_all(&dir);

    // a sort that spills is merged straight into the stream, batch by batch
    let lf = ctx.sql("select * from t order by s, id desc").unwrap();
    let want = collected(&lf);
    memory::pool().set_limit(2 << 20);
    let before = spilled_bytes();
    let (_, got, emits) = streamed(&lf);
    memory::pool().set_limit(usize::MAX);
    assert!(spilled_bytes() > before, "the sort did not spill");
    assert!(emits > 1, "the merge did not stream");
    assert_eq!(got, want);
}
