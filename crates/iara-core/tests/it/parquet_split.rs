//! A row group is split into row ranges for parallelism only where its
//! column chunks have pages to split at: every range decompresses the pages
//! it reads whole, so ranges of a one-page chunk would each decompress it all.

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

fn morsels(path: &str) -> usize {
    let ctx = SessionContext::new();
    ctx.register_parquet("t", path).unwrap();
    let plan = ctx.sql("select sum(a + b) from t").unwrap().explain(true).unwrap();
    let at = plan.find("morsels=").unwrap_or_else(|| panic!("no morsel count in\n{plan}")) + 8;
    plan[at..].chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap()
}

#[test]
fn ranges_follow_the_pages() {
    let d = TempDir::new("split");
    let (one, many) = (d.join("one_page.parquet"), d.join("many_pages.parquet"));
    write(&one, usize::MAX);
    write(&many, 256 << 10);
    assert_eq!(morsels(&one), 1, "one page per chunk: one range would decompress it for every part");
    assert!(morsels(&many) > 1, "a chunk of 60 pages is split");
}
