//! A query's profile reports the object store requests it made. Requests are
//! counted process-wide (a query's share is the difference over its life), so
//! this file holds one test only: nothing else runs beside it.

use std::sync::Arc;

use arrow::array::{ArrayRef, Float64Array, Int64Array};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use iara_core::SessionContext;
use iara_core::io::object::{StorageRequests, storage_requests};
use iara_core::io::parquet::write_parquet;

fn write_files() {
    let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, false), Field::new("amount", DataType::Float64, false)]));
    for i in 0..3i64 {
        let ids: Vec<i64> = (i * 1000..(i + 1) * 1000).collect();
        let amounts: Vec<f64> = ids.iter().map(|v| *v as f64 * 0.5).collect();
        let cols: Vec<ArrayRef> = vec![Arc::new(Int64Array::from(ids)), Arc::new(Float64Array::from(amounts))];
        let batch = RecordBatch::try_new(schema.clone(), cols).unwrap();
        write_parquet(&format!("memory://query-requests/t/part-{i}.parquet"), schema.clone(), &[batch], "zstd", Some(250)).unwrap();
    }
}

fn table() -> SessionContext {
    let ctx = SessionContext::new();
    ctx.register_parquet("t", "memory://query-requests/t").unwrap();
    ctx
}

#[test]
fn queries_report_their_own_requests() {
    write_files();
    let start = storage_requests();
    let _warm = table();
    let registered = storage_requests().since(start);
    assert_eq!((registered.list, registered.head, registered.get), (1, 0, 3), "{registered:?}");

    // a table object over remembered footers: the scan is all that reads
    let ctx = table();
    assert_eq!(storage_requests().since(start), registered, "the second table object asked for nothing");
    let (_, _, stats) = ctx.sql("select sum(amount) from t").unwrap().collect_profiled().unwrap();
    assert_eq!((stats.requests.list, stats.requests.head, stats.requests.get), (0, 0, 3), "{:?}", stats.requests);
    assert!(stats.requests.bytes > 0);
    let total = storage_requests().since(start);
    assert_eq!(total.get, registered.get + stats.requests.get);
    assert_eq!(total.bytes, registered.bytes + stats.requests.bytes);

    // answered from footers: no request at all
    let (_, _, stats) = ctx.sql("select count(*) from t").unwrap().collect_profiled().unwrap();
    assert_eq!(stats.requests, StorageRequests::default());
}
