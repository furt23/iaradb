//! JSON / NDJSON reading and writing, and the CSV read options.

use std::path::PathBuf;
use std::sync::Arc;

use arrow::array::{ArrayRef, BooleanArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use arrow::util::pretty::pretty_format_batches;
use workhouse_core::SessionContext;
use workhouse_core::io::csv::CsvOptions;
use workhouse_core::io::json::{JsonFormat, JsonNested, JsonOptions, read_json, write_json};
use workhouse_core::io::{StorageOptions, csv::CsvEncoding};

struct Dir(PathBuf);

impl Dir {
    fn new(name: &str) -> Dir {
        let p = std::env::temp_dir().join(format!("wh_json_io_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Dir(p)
    }
    fn file(&self, name: &str, content: impl AsRef<[u8]>) -> String {
        let p = self.0.join(name);
        std::fs::write(&p, content).unwrap();
        p.to_str().unwrap().to_string()
    }
    fn path(&self, name: &str) -> String {
        self.0.join(name).to_str().unwrap().to_string()
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn show(ctx: &SessionContext, sql: &str) -> String {
    let (_, batches) = ctx.sql(sql).unwrap().collect().unwrap();
    pretty_format_batches(&batches).unwrap().to_string()
}

fn json_ctx(path: &str, opts: JsonOptions) -> SessionContext {
    let ctx = SessionContext::new();
    workhouse_core::io::json::register_json(&ctx, "t", path, opts, &StorageOptions::new(), false).unwrap();
    ctx
}

const SAMPLE: &str = concat!(
    r#"{"id": 1, "name": "Zoë \"Z\"", "score": 1.5, "ok": true, "tags": ["a", "b"], "meta": {"k": 1}}"#, "\n",
    r#"{"id": 2, "name": "日本語", "score": null, "ok": false}"#, "\n",
    "\n",
    r#"{"id": 3, "score": 3, "ok": null, "extra": "late"}"#, "\r\n",
);

#[test]
fn ndjson_types_nulls_unicode_and_nested_text() {
    let d = Dir::new("basic");
    let ctx = json_ctx(&d.file("a.ndjson", SAMPLE), JsonOptions { infer_rows: 2, nested: JsonNested::Text, ..Default::default() });
    let (schema, _) = ctx.sql("select * from t").unwrap().collect().unwrap();
    let types: Vec<_> = schema.fields().iter().map(|f| (f.name().as_str(), f.data_type().clone())).collect();
    assert_eq!(
        types,
        vec![
            ("id", DataType::Int64),
            ("name", DataType::Utf8),
            ("score", DataType::Float64),
            ("ok", DataType::Boolean),
            ("tags", DataType::Utf8),
            ("meta", DataType::Utf8),
        ]
    );
    let out = show(&ctx, "select id, name, score, ok, tags, meta from t order by id");
    for want in ["Zoë \"Z\"", "日本語", r#"["a", "b"]"#, r#"{"k": 1}"#, "1.5", "3.0"] {
        assert!(out.contains(want), "{want} in\n{out}");
    }
    assert!(show(&ctx, "select count(*) as n from t where score is null").contains("| 1 "));
    // a key first seen after the sample is not a column
    assert!(!out.contains("extra"));
}

#[test]
fn array_file_matches_ndjson() {
    let d = Dir::new("array");
    let lines: Vec<&str> = SAMPLE.lines().filter(|l| !l.is_empty()).collect();
    let arr = format!("[\n  {}\n]\n", lines.join(",\n  "));
    let nd = json_ctx(&d.file("a.ndjson", SAMPLE), JsonOptions::default());
    let ar = json_ctx(&d.file("b.json", arr), JsonOptions::default());
    let q = "select id, name, score, ok, tags, meta from t order by id";
    assert_eq!(show(&nd, q), show(&ar, q));
    // a pretty-printed multi-line object is fine in an array
    let pretty = d.file("c.json", "[ {\n \"id\": 1,\n \"v\": \"x\"\n}, {\"id\": 2, \"v\": \"y\"} ]");
    assert!(show(&json_ctx(&pretty, JsonOptions::default()), "select sum(id) as s from t").contains("| 3 "));
    assert!(show(&json_ctx(&pretty, JsonOptions::default()), "select count(*) as n from t").contains("| 2 "));
}

fn big_ndjson(rows: usize) -> String {
    let mut s = String::new();
    for i in 0..rows {
        let name = if i % 11 == 0 { "null".to_string() } else { format!("\"naïve ☃ {}\\n{}\"", i % 97, i) };
        s.push_str(&format!("{{\"id\": {i}, \"name\": {name}, \"x\": {}.25, \"nested\": {{\"a\": [{i}, \"}}\"]}}}}\n", i % 1000));
    }
    s
}

#[test]
fn morsel_ranges_cut_at_line_boundaries() {
    let d = Dir::new("morsels");
    let path = d.file("big.ndjson", big_ndjson(30_000));
    let q = "select count(*) as n, sum(id) as s, count(name) as c, sum(x) as x, min(nested) as m from t";
    let whole = show(&json_ctx(&path, JsonOptions { parallel: false, ..Default::default() }), q);
    assert!(whole.contains("30000"));
    for chunk in [7, 100, 4096, 50_000] {
        let opts = JsonOptions { chunk_bytes: Some(chunk), ..Default::default() };
        assert_eq!(show(&json_ctx(&path, opts), q), whole, "chunk {chunk}");
    }
    // count(*) alone parses nothing
    let opts = JsonOptions { chunk_bytes: Some(4096), ..Default::default() };
    assert!(show(&json_ctx(&path, opts), "select count(*) as n from t").contains("30000"));
}

#[test]
fn remote_matches_local() {
    let d = Dir::new("remote");
    let text = big_ndjson(5_000);
    let local = d.file("t.ndjson", &text);
    let mut out = workhouse_core::io::output::Output::create("memory://json/t.ndjson", &StorageOptions::new()).unwrap();
    std::io::Write::write_all(&mut out, text.as_bytes()).unwrap();
    out.finish().unwrap();
    let q = "select count(*) as n, sum(id) as s, count(name) as c, min(nested) as m from t";
    let opts = JsonOptions { chunk_bytes: Some(1000), ..Default::default() };
    assert_eq!(show(&json_ctx(&local, opts.clone()), q), show(&json_ctx("memory://json/t.ndjson", opts), q));
}

#[test]
fn folders_and_globs() {
    let d = Dir::new("folder");
    d.file("a.ndjson", "{\"v\": 1}\n{\"v\": 2}\n");
    d.file("b.jsonl", "{\"v\": 3}\n");
    d.file("c.json", "[{\"v\": 4}]");
    d.file("ignored.txt", "nope");
    let sum = |p: &str| show(&json_ctx(p, JsonOptions::default()), "select sum(v) as s, count(*) as n from t");
    let all = sum(d.0.to_str().unwrap());
    assert!(all.contains("| 10 | 4 |"), "{all}");
    assert!(sum(&d.path("*.ndjson")).contains("| 3 | 2 |"));
    assert!(sum(&d.path("b.jsonl")).contains("| 3 | 1 |"));
    assert!(workhouse_core::io::json::JsonTable::try_new(&d.path("missing"), JsonOptions::default()).is_err());
}

#[test]
fn errors_are_clear() {
    let d = Dir::new("errors");
    let bad = d.file("bad.ndjson", "{\"a\": 1}\n{\"a\": \n");
    let ctx = json_ctx(&bad, JsonOptions { infer_rows: 1, ..Default::default() });
    let err = ctx.sql("select * from t").unwrap().collect().unwrap_err().to_string();
    assert!(err.contains("invalid JSON"), "{err}");
    // a value that does not fit the inferred type
    let skew = d.file("skew.ndjson", "{\"a\": 1}\n{\"a\": \"x\"}\n");
    let ctx = json_ctx(&skew, JsonOptions { infer_rows: 1, ..Default::default() });
    let err = ctx.sql("select * from t").unwrap().collect().unwrap_err().to_string();
    assert!(err.contains("column 'a'"), "{err}");
    // read as text with a larger sample
    let ctx = json_ctx(&skew, JsonOptions::default());
    assert!(show(&ctx, "select a from t order by a").contains("x"));
    // the format option
    assert!(workhouse_core::io::json::JsonTable::try_new(&skew, JsonOptions { format: JsonFormat::Array, ..Default::default() }).is_err());
}

fn sample_batch() -> RecordBatch {
    let schema = Arc::new(Schema::new(vec![
        Field::new("i", DataType::Int64, true),
        Field::new("f", DataType::Float64, true),
        Field::new("b", DataType::Boolean, true),
        Field::new("s", DataType::Utf8, true),
    ]));
    let cols: Vec<ArrayRef> = vec![
        Arc::new(Int64Array::from(vec![Some(1), None, Some(-3), Some(i64::MAX)])),
        Arc::new(Float64Array::from(vec![Some(1.0), Some(2.5), None, Some(1e300)])),
        Arc::new(BooleanArray::from(vec![Some(true), None, Some(false), Some(true)])),
        Arc::new(StringArray::from(vec![Some("a \"q\" \\ b"), Some("line\nbreak\ttab"), None, Some("héllo 日本 \u{1F600}")])),
    ];
    RecordBatch::try_new(schema, cols).unwrap()
}

#[test]
fn write_then_read_round_trips() {
    let d = Dir::new("roundtrip");
    let batch = sample_batch();
    let path = d.path("out.ndjson");
    write_json(&path, std::slice::from_ref(&batch)).unwrap();
    let text = std::fs::read_to_string(&path).unwrap();
    assert_eq!(text.lines().count(), 4);
    assert!(text.starts_with(r#"{"i":1,"f":1.0,"b":true,"s":"a \"q\" \\ b"}"#), "{text}");
    assert!(text.contains(r#""i":null"#) && text.contains(r#""s":null"#));
    let ctx = SessionContext::new();
    let lf = read_json(&ctx, &path, JsonOptions::default(), &StorageOptions::new()).unwrap();
    let (schema, batches) = lf.collect().unwrap();
    assert_eq!(schema.fields().iter().map(|f| f.data_type().clone()).collect::<Vec<_>>(), batch.schema().fields().iter().map(|f| f.data_type().clone()).collect::<Vec<_>>());
    assert_eq!(batches.iter().map(|b| b.num_rows()).sum::<usize>(), 4);
    let back = arrow::compute::concat_batches(&schema, &batches).unwrap();
    assert_eq!(back, batch);
}

#[test]
fn sql_read_json_from_path_and_copy() {
    let d = Dir::new("sql");
    let a = d.file("a.json", "{\"id\": 1, \"v\": \"x\"}\n{\"id\": 2, \"v\": null}\n");
    let ctx = SessionContext::new();
    assert!(show(&ctx, &format!("select sum(id) as s from read_json('{a}')")).contains("| 3 "));
    assert!(show(&ctx, &format!("select count(*) as n from read_ndjson('{a}', sample_size => 1)")).contains("| 2 "));
    assert!(show(&ctx, &format!("select count(v) as n from '{a}'")).contains("| 1 "));
    let arr = d.file("arr.json", "[{\"id\": 5}]");
    assert!(show(&ctx, &format!("select id from read_json('{arr}', format => 'array')")).contains("| 5 "));
    let out = d.path("copy.json");
    show(&ctx, &format!("copy (select id, v from read_json('{a}') order by id) to '{out}' (format json)"));
    assert_eq!(std::fs::read_to_string(&out).unwrap(), "{\"id\":1,\"v\":\"x\"}\n{\"id\":2,\"v\":null}\n");
    let by_ext = d.path("copy2.ndjson");
    show(&ctx, &format!("copy (select 7 as n) to '{by_ext}'"));
    assert_eq!(std::fs::read_to_string(&by_ext).unwrap(), "{\"n\":7}\n");
}

// ---------------------------------------------------------------------------
// CSV options
// ---------------------------------------------------------------------------

fn csv_ctx(path: &str, opts: CsvOptions) -> SessionContext {
    let ctx = SessionContext::new();
    ctx.register_csv("t", path, opts).unwrap();
    ctx
}

#[test]
fn csv_quote_escape_comment_skip_and_nulls() {
    let d = Dir::new("csv");
    let p = d.file("q.csv", "junk line\nmore junk\n# a comment\nid,name,v\n1,'a,b',NA\n2,'it\\'s',5\n# another\n3,plain,-\n");
    let opts = CsvOptions {
        skip_rows: 2,
        comment: Some(b'#'),
        quote: b'\'',
        escape: Some(b'\\'),
        null_values: vec!["NA".into(), "-".into()],
        ..Default::default()
    };
    let ctx = csv_ctx(&p, opts);
    let out = show(&ctx, "select id, name, v from t order by id");
    assert!(out.contains("a,b") && out.contains("it's") && out.contains("plain"), "{out}");
    assert!(show(&ctx, "select count(v) as n, sum(v) as s from t").contains("| 1 | 5 |"));
    let (schema, _) = ctx.sql("select * from t").unwrap().collect().unwrap();
    assert_eq!(schema.field(2).data_type(), &DataType::Int64);
}

#[test]
fn csv_columns_overrides_dates_and_lossy() {
    let d = Dir::new("csv2");
    let p = d.file("c.csv", "a,b,when\n1,2,2024-02-29\n3,4,2023-01-01\n");
    let sel = CsvOptions { columns: Some(vec!["when".into(), "a".into()]), ..Default::default() };
    let ctx = csv_ctx(&p, sel);
    let (schema, _) = ctx.sql("select * from t").unwrap().collect().unwrap();
    assert_eq!(schema.fields().iter().map(|f| f.name().as_str()).collect::<Vec<_>>(), ["when", "a"]);
    assert!(show(&ctx, "select sum(a) as s from t").contains("| 4 "));
    assert!(show(&ctx, "select a from t where \"when\" = date '2024-02-29'").contains("| 1 "));
    // a type override, and dates kept as text
    let mut o = CsvOptions { try_parse_dates: false, ..Default::default() };
    o.schema_overrides.insert("a".into(), DataType::Float64);
    let (schema, _) = csv_ctx(&p, o.clone()).sql("select * from t").unwrap().collect().unwrap();
    assert_eq!(schema.field(0).data_type(), &DataType::Float64);
    assert_eq!(schema.field(2).data_type(), &DataType::Utf8);
    o.schema_overrides.insert("nope".into(), DataType::Utf8);
    assert!(workhouse_core::io::csv::CsvTable::try_new(&p, o).is_err());
    // invalid UTF-8
    let bad = d.file("bad.csv", b"id,s\n1,caf\xE9\n2,ok\n");
    assert!(workhouse_core::io::csv::CsvTable::try_new(&bad, CsvOptions::default()).is_err());
    let lossy = csv_ctx(&bad, CsvOptions { encoding: CsvEncoding::Utf8Lossy, ..Default::default() });
    assert!(show(&lossy, "select s from t order by id").contains("caf\u{FFFD}"));
}

#[test]
fn csv_options_hold_across_morsels() {
    let d = Dir::new("csv3");
    let mut s = String::from("skipped\n# c\nid,v\n");
    for i in 0..20_000 {
        s.push_str(&format!("{i},{}\n", if i % 5 == 0 { "NA".to_string() } else { i.to_string() }));
        if i % 1000 == 0 {
            s.push_str("# note\n");
        }
    }
    let p = d.file("m.csv", s);
    let q = "select count(*) as n, count(v) as c, sum(v) as s from t";
    let base = CsvOptions { skip_rows: 1, comment: Some(b'#'), null_values: vec!["NA".into()], ..Default::default() };
    let whole = show(&csv_ctx(&p, CsvOptions { parallel: false, ..base.clone() }), q);
    assert!(whole.contains("20000"), "{whole}");
    for chunk in [13, 500, 8192] {
        assert_eq!(show(&csv_ctx(&p, CsvOptions { chunk_bytes: Some(chunk), ..base.clone() }), q), whole, "chunk {chunk}");
    }
}

#[test]
fn sql_read_csv_named_options_and_copy() {
    let d = Dir::new("csvsql");
    let p = d.file("s.csv", "x;y;z\n1;'a;b';NA\n2;c;4\n");
    let ctx = SessionContext::new();
    let q = format!("select * from read_csv('{p}', delim => ';', quote => '''', nullstr => ['NA'], types => {{'x': 'DOUBLE'}}, columns => ['z', 'y', 'x']) order by x");
    // `columns` as a list selects; `types` as a map overrides
    let out = show(&ctx, &q);
    assert!(out.contains("a;b") && out.contains("1.0"), "{out}");
    let (schema, _) = ctx.sql(&q).unwrap().collect().unwrap();
    assert_eq!(schema.fields().iter().map(|f| f.name().as_str()).collect::<Vec<_>>(), ["z", "y", "x"]);
    assert!(show(&ctx, &format!("select count(*) as n from read_csv('{p}', delim => ';', quote => '''', skip => 1, header => false)")).contains("| 2 "));
    let dst = d.path("o.csv");
    show(&ctx, &format!("copy (select 'a|b' as s, null as n) to '{dst}' (format csv, delimiter '|', quote '\"', nullstr 'NULL')"));
    assert_eq!(std::fs::read_to_string(&dst).unwrap(), "s|n\n\"a|b\"|NULL\n");
    assert!(ctx.sql(&format!("select * from read_csv('{p}', encoding => 'latin1')")).is_err());
}
