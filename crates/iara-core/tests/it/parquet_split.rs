//! A row group is split into row ranges for parallelism only where its
//! column chunks have pages to split at: every range decompresses the pages
//! it reads whole, so ranges of a one-page chunk would each decompress it all.
//! Such a row group is decoded once, and its batches go to several morsels.

use std::sync::Arc;

use arrow::array::Int64Array;
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use iara_core::SessionContext;
use parquet::arrow::ArrowWriter;
use parquet::file::properties::WriterProperties;

use crate::support::dir::TempDir;

const ROWS: usize = 2_000_000;

/// One row group of two Int64 columns (16 MB each), in pages of `page_bytes`.
fn write(path: &str, page_bytes: usize) {
    let schema = Arc::new(Schema::new(vec![Field::new("a", DataType::Int64, false), Field::new("b", DataType::Int64, false)]));
    let cols: Vec<Arc<dyn arrow::array::Array>> = vec![
        Arc::new(Int64Array::from_iter_values(0..ROWS as i64)),
        Arc::new(Int64Array::from_iter_values((0..ROWS as i64).map(|i| i * 7 % 1000))),
    ];
    let batch = RecordBatch::try_new(schema.clone(), cols).unwrap();
    let props = WriterProperties::builder()
        .set_max_row_group_row_count(Some(ROWS))
        .set_dictionary_enabled(false)
        .set_data_page_size_limit(page_bytes)
        .set_data_page_row_count_limit(usize::MAX)
        .build();
    let mut w = ArrowWriter::try_new(std::fs::File::create(path).unwrap(), schema, Some(props)).unwrap();
    w.write(&batch).unwrap();
    w.close().unwrap();
}

/// The scan's (`morsels`, `decodes`: how many times rows are decoded, when morsels share a decode).
fn morsels(path: &str) -> (usize, Option<usize>) {
    let ctx = SessionContext::new();
    ctx.register_parquet("t", path).unwrap();
    let plan = ctx.sql("select sum(a + b) from t").unwrap().explain(true).unwrap();
    let number = |key: &str| {
        let at = plan.find(key)? + key.len();
        plan[at..].chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse::<usize>().ok()
    };
    // the query gives the same sum however the rows are shared out
    let (_, batches) = ctx.sql("select sum(a + b), count(*) from t").unwrap().collect().unwrap();
    let rows = ROWS as i64;
    assert_eq!(crate::support::render(&batches), format!("{},{rows}", rows * (rows - 1) / 2 + (0..rows).map(|i| i * 7 % 1000).sum::<i64>()));
    (number("morsels=").unwrap_or_else(|| panic!("no morsel count in\n{plan}")), number("decodes="))
}

#[test]
fn ranges_follow_the_pages() {
    let d = TempDir::new("split");
    let (one, many) = (d.join("one_page.parquet"), d.join("many_pages.parquet"));
    write(&one, usize::MAX);
    write(&many, 256 << 10);
    // one page per chunk: a range would decompress it for every part, so it is decoded once
    let (shared, decodes) = morsels(&one);
    assert!(shared > 1 && decodes == Some(1), "{shared} morsels, {decodes:?} decodes");
    // a chunk of 60 pages is split into ranges, each decoded by its morsel
    let (ranges, decodes) = morsels(&many);
    assert!(ranges > 1 && decodes.is_none_or(|d| d > 1), "{ranges} morsels, {decodes:?} decodes");
}

/// A small table, local or on an object store: the morsels that share a decode give its
/// rows once, in the file's order, and a remote row group is still fetched once.
#[test]
fn morsels_that_share_a_decode_give_the_rows_in_order() {
    use arrow::array::{Array, AsArray, StringArray};
    use arrow::datatypes::Int64Type;
    use iara_core::io::object::scope_requests;
    use iara_core::io::parquet::write_parquet;

    const N: i64 = 150_000;
    let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int64, false), Field::new("s", DataType::Utf8, true)]));
    let ids = Int64Array::from_iter_values(0..N);
    // long enough that the file is not read whole with its footer
    let text = StringArray::from_iter((0..N).map(|i| (i % 7 != 0).then(|| format!("row {i} of the table {}", i * 2_654_435_761 % 1_000_003))));
    let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(ids), Arc::new(text)]).unwrap();
    let d = TempDir::new("shared");
    for (path, remote) in [(d.join("t.parquet"), false), ("memory://shared-decode/t.parquet".to_string(), true)] {
        write_parquet(&path, schema.clone(), std::slice::from_ref(&batch), "none", None).unwrap();
        let ctx = SessionContext::new();
        ctx.register_parquet("t", &path).unwrap();
        let plan = ctx.sql("select id, s from t").unwrap().explain(true).unwrap();
        assert!(plan.contains("decodes="), "{plan}");
        let before = scope_requests("memory://shared-decode");
        let ids_of = |sql: &str| -> Vec<i64> {
            let (_, batches) = ctx.sql(sql).unwrap().collect().unwrap();
            batches.iter().flat_map(|b| b.column(0).as_primitive::<Int64Type>().values().to_vec()).collect()
        };
        assert_eq!(ids_of("select id, s from t"), (0..N).collect::<Vec<_>>());
        if remote {
            let read = scope_requests("memory://shared-decode").since(before);
            assert_eq!(read.get, 1, "the row group is fetched once for all its morsels: {read:?}");
        }
        assert_eq!(ids_of("select id from t where s is null and id > 100"), (0..N).filter(|i| i % 7 == 0 && *i > 100).collect::<Vec<_>>());
        assert_eq!(ids_of("select id from t limit 12345"), (0..12_345).collect::<Vec<_>>());
        assert_eq!(ids_of("select count(*), count(s) from t"), vec![N]);
        let (_, batches) = ctx.sql("select s, count(*) from t group by s having count(*) > 1 order by s limit 1").unwrap().collect().unwrap();
        assert!(batches[0].column(0).is_null(0) && batches[0].column(1).as_primitive::<Int64Type>().value(0) == (N + 6) / 7);
    }
}
