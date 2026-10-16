//! CSV files with quoted fields that hold newlines, read over many byte
//! ranges. The files are written so such fields straddle every range cut
//! (the newline just before, at, and just after it), and every row read back
//! is compared to the row written.

use std::path::PathBuf;

use arrow::array::{Array, AsArray};
use arrow::datatypes::Int64Type;
use iara_core::SessionContext;
use iara_core::io::csv::CsvOptions;

const CHUNK: usize = 64 * 1024;

struct Dir(PathBuf);

impl Dir {
    fn new(name: &str) -> Dir {
        let p = std::env::temp_dir().join(format!("wh_csv_multiline_{name}_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&p);
        std::fs::create_dir_all(&p).unwrap();
        Dir(p)
    }
    fn file(&self, name: &str, content: &str) -> String {
        let p = self.0.join(name);
        std::fs::write(&p, content).unwrap();
        p.to_str().unwrap().to_string()
    }
}

impl Drop for Dir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// `id,"text",n` rows; `escapes` puts `""` pairs around the newline.
/// Returns the file and the expected (id, text) pairs.
fn build(rows: usize, escapes: bool) -> (String, Vec<(i64, String)>) {
    let mut csv = String::from("id,text,n\n");
    let mut expect = vec![];
    for id in 0..rows as i64 {
        let next_cut = (csv.len() / CHUNK + 1) * CHUNK;
        let head = format!("{id},\"");
        let text = if csv.len() + head.len() + 8 < next_cut && next_cut - csv.len() < 200 {
            // aim a newline at the cut - 1, the cut, or the cut + 1
            let target = next_cut - 1 + (id as usize % 3);
            let pad = target - csv.len() - head.len() - if escapes { 2 } else { 0 };
            let (pre, post) = if escapes { ("\"", "\"tail") } else { ("", "tail") };
            format!("{}{pre}\n{post}\nlast", "x".repeat(pad))
        } else if id % 7 == 0 {
            format!("two\nlines {id}")
        } else {
            format!("plain {id}")
        };
        let quoted = text.replace('"', "\"\"");
        csv.push_str(&format!("{head}{quoted}\",{}\n", id * 3));
        expect.push((id, text));
    }
    (csv, expect)
}

fn read(path: &str, o: CsvOptions) -> (SessionContext, Vec<(i64, String)>) {
    let ctx = SessionContext::new();
    ctx.register_csv("t", path, o).unwrap();
    let (_, batches) = ctx.sql("select id, text from t order by id").unwrap().collect().unwrap();
    let mut got = vec![];
    for b in &batches {
        let ids = b.column(0).as_primitive::<Int64Type>();
        let text = b.column(1).as_string::<i32>();
        for i in 0..b.num_rows() {
            assert!(text.is_valid(i));
            got.push((ids.value(i), text.value(i).to_string()));
        }
    }
    (ctx, got)
}

fn chunked() -> CsvOptions {
    CsvOptions { chunk_bytes: Some(CHUNK), ..Default::default() }
}

fn morsels(ctx: &SessionContext) -> usize {
    let plan = ctx.sql("select id from t").unwrap().explain(true).unwrap();
    let at = plan.find("morsels=").unwrap_or_else(|| panic!("no morsel count in\n{plan}")) + 8;
    plan[at..].chars().take_while(|c| c.is_ascii_digit()).collect::<String>().parse().unwrap()
}

fn check(escapes: bool) {
    let d = Dir::new(if escapes { "esc" } else { "plain" });
    let (csv, expect) = build(120_000, escapes);
    assert!(csv.len() > 20 * CHUNK, "the file spans many ranges");
    let p = d.file("big.csv", &csv);
    let (ctx, got) = read(&p, chunked());
    assert!(morsels(&ctx) > 20, "quoted files stay parallel");
    assert_eq!(got.len(), expect.len());
    for (g, e) in got.iter().zip(&expect) {
        assert_eq!(g, e);
    }
}

#[test]
fn multiline_fields_at_range_boundaries() {
    check(false);
}

#[test]
fn multiline_fields_with_doubled_quotes() {
    check(true);
}

#[test]
fn ordinary_files_still_use_parallel_ranges() {
    let d = Dir::new("ordinary");
    let mut csv = String::from("id,text,n\n");
    for id in 0..120_000 {
        // quoted but on one line
        csv.push_str(&format!("{id},\"a, b {id}\",{id}\n"));
    }
    let p = d.file("ord.csv", &csv);
    let (ctx, got) = read(&p, chunked());
    assert!(morsels(&ctx) > 20, "{} morsels", morsels(&ctx));
    assert_eq!(got.len(), 120_000);
    assert_eq!(got[123], (123, "a, b 123".to_string()));
}

#[test]
fn unreliable_parity_reads_the_file_whole() {
    let d = Dir::new("whole");
    let (csv, expect) = build(30_000, false);
    let p = d.file("w.csv", &csv);
    for o in [
        CsvOptions { parallel: false, ..chunked() },
        CsvOptions { escape: Some(b'\\'), ..chunked() },
        CsvOptions { comment: Some(b'#'), ..chunked() },
    ] {
        let (ctx, got) = read(&p, o);
        assert_eq!(morsels(&ctx), 1);
        assert_eq!(got, expect);
    }
}

#[test]
fn stray_quote_in_an_unquoted_field_reads_the_file_whole() {
    let d = Dir::new("stray");
    let mut csv = String::from("id,text,n\n0,5\" pipe,0\n");
    for id in 1..20_000 {
        csv.push_str(&format!("{id},row {id},{id}\n"));
    }
    let p = d.file("s.csv", &csv);
    let (ctx, got) = read(&p, chunked());
    assert_eq!(morsels(&ctx), 1);
    assert_eq!(got.len(), 20_000);
    assert_eq!(got[0], (0, "5\" pipe".to_string()));
}
