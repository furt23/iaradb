//! Byte ranges of CSV files that never cut a quoted field.
//!
//! A quoted field may hold newlines (RFC 4180), so a plain "cut at the next
//! `\n`" can land inside one. How each file is split:
//! - local file: the quotes of every nominal range are counted in parallel;
//!   a prefix sum gives the quote parity at each cut, and a cut moves to the
//!   first `\n` at even parity (outside quotes). `""` keeps the parity;
//! - remote file: parity would need the whole file, so a file whose sample
//!   (the bytes fetched for schema inference) holds a quote is read as one
//!   range; with no quote in the sample the ranges are kept. A quote that
//!   first appears past the sample is not seen: set `parallel=false` there;
//! - no quote byte, `parallel=false`: unchanged (a newline always ends a
//!   record / one range per file);
//! - an escape byte other than the quote, a comment byte (a comment line may
//!   hold quotes), or an odd number of quotes in a file (a stray quote in an
//!   unquoted field): parity is unreliable, the file is one range.

use rayon::prelude::*;

use super::CsvOptions;
use super::ranges::{self, ByteRange};
use crate::io::blob::Blob;

#[derive(Debug, PartialEq)]
enum Mode {
    /// One range per file.
    Sequential,
    /// Ranges cut at any newline.
    Plain,
    /// Ranges cut at newlines outside quotes (local files).
    Aligned(u8),
}

fn mode(o: &CsvOptions) -> Mode {
    if !o.parallel {
        Mode::Sequential
    } else if o.quote == 0 {
        Mode::Plain
    } else if o.comment.is_some() || o.escape.is_some_and(|e| e != o.quote) {
        Mode::Sequential
    } else {
        Mode::Aligned(o.quote)
    }
}

/// The ranges to scan. `starts[i]` is where the data of file `i` begins;
/// `sample_quoted` tells whether the schema sample holds a quote byte.
pub fn plan(files: &[Blob], o: &CsvOptions, starts: &[usize], sample_quoted: bool) -> Vec<ByteRange> {
    let m = mode(o);
    let parallel = m != Mode::Sequential;
    let nominal = ranges::plan(files, parallel, o.chunk_bytes, starts);
    let Mode::Aligned(quote) = m else {
        return nominal;
    };
    let mut out = vec![];
    for group in nominal.chunk_by(|a, b| a.file == b.file) {
        let file = group[0].file;
        match &files[file] {
            Blob::Mapped(d) => out.extend(align(d, quote, file, group)),
            Blob::Object(_) if sample_quoted => out.push(whole(file, group)),
            Blob::Object(_) => out.extend_from_slice(group),
        }
    }
    out
}

/// One range over all of a file's nominal ranges.
fn whole(file: usize, group: &[ByteRange]) -> ByteRange {
    ByteRange { file, start: group[0].start, end: group[group.len() - 1].end }
}

/// The nominal ranges of a mapped file moved to record starts.
fn align(d: &[u8], quote: u8, file: usize, group: &[ByteRange]) -> Vec<ByteRange> {
    if group.len() < 2 {
        return group.to_vec();
    }
    let counts: Vec<usize> = group.par_iter().map(|r| memchr::memchr_iter(quote, &d[r.start..r.end]).count()).collect();
    if counts.iter().sum::<usize>() % 2 == 1 {
        return vec![whole(file, group)];
    }
    // parity of the quotes before each range (the first range starts at 0)
    let mut parity = vec![false; group.len()];
    for i in 1..group.len() {
        parity[i] = parity[i - 1] ^ (counts[i - 1] % 2 == 1);
    }
    let first = group[0].start;
    let mut cuts: Vec<usize> = (1..group.len()).into_par_iter().map(|i| record_start(d, quote, group[i].start, parity[i])).collect();
    cuts.insert(0, first);
    cuts.push(group[group.len() - 1].end);
    cuts.windows(2).filter(|w| w[0] < w[1]).map(|w| ByteRange { file, start: w[0], end: w[1] }).collect()
}

/// Offset just past the first `\n` outside quotes at or after `pos - 1`
/// (what `line_start` finds, for quoted data); `inside` is whether `pos` is
/// inside quotes. The end of the data when there is none.
fn record_start(d: &[u8], quote: u8, pos: usize, inside: bool) -> usize {
    let from = pos - 1;
    // the parity at `from`: undo the quote just before `pos`
    let mut inside = inside ^ (d[from] == quote);
    for j in memchr::memchr2_iter(b'\n', quote, &d[from..]) {
        let p = from + j;
        if d[p] == quote {
            inside = !inside;
        } else if !inside {
            return p + 1;
        }
    }
    d.len()
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;

    use super::*;

    fn blob(s: &str) -> Blob {
        Blob::Mapped(Bytes::from(s.to_string()))
    }

    fn opts(chunk: usize) -> CsvOptions {
        CsvOptions { chunk_bytes: Some(chunk), ..Default::default() }
    }

    /// Text of each range.
    fn pieces(s: &str, o: &CsvOptions) -> Vec<String> {
        let files = [blob(s)];
        plan(&files, o, &[0], false).iter().map(|r| s[r.start..r.end].to_string()).collect()
    }

    #[test]
    fn plain_files_keep_their_ranges() {
        let s = "a,b\n1,2\n3,4\n5,6\n7,8\n";
        let p = pieces(s, &opts(4));
        assert!(p.len() > 1);
        assert_eq!(p.concat(), s);
        assert!(p.iter().all(|x| x.ends_with('\n')));
    }

    #[test]
    fn quoted_single_line_fields_stay_parallel() {
        let s = "a,b\n\"x,y\",2\n\"p\",4\n\"q\",6\n\"r\",8\n";
        let p = pieces(s, &opts(5));
        assert!(p.len() > 1);
        assert_eq!(p.concat(), s);
    }

    #[test]
    fn cuts_never_land_inside_a_quoted_field() {
        let s = "a,b\n1,\"l1\nl2\nl3\"\n2,\"x\"\"\ny\"\n3,\"z\"\n";
        for chunk in 1..s.len() {
            let p = pieces(s, &opts(chunk));
            assert_eq!(p.concat(), s, "chunk {chunk}");
            for piece in &p {
                assert_eq!(piece.matches('"').count() % 2, 0, "chunk {chunk}: {piece:?}");
                assert!(piece.ends_with('\n'));
            }
        }
    }

    #[test]
    fn stray_quote_reads_the_file_whole() {
        let s = "a,b\n5\" pipe,1\n2,3\n4,5\n";
        assert_eq!(pieces(s, &opts(4)).len(), 1);
    }

    #[test]
    fn sequential_modes() {
        let s = "a,b\n1,\"x\ny\"\n2,3\n";
        let no_par = CsvOptions { parallel: false, ..opts(4) };
        assert_eq!(pieces(s, &no_par).len(), 1);
        let esc = CsvOptions { escape: Some(b'\\'), ..opts(4) };
        assert_eq!(pieces(s, &esc).len(), 1);
        let com = CsvOptions { comment: Some(b'#'), ..opts(4) };
        assert_eq!(pieces(s, &com).len(), 1);
        // escape equal to the quote is the standard "" form
        let same = CsvOptions { escape: Some(b'"'), ..opts(4) };
        assert!(pieces(s, &same).len() > 1);
    }

    #[test]
    fn no_quote_byte_cuts_at_any_newline() {
        let s = "a,b\n1,\"x\n2,3\n4,5\n6,7\n";
        let o = CsvOptions { quote: 0, ..opts(4) };
        assert!(pieces(s, &o).len() > 2);
    }

    #[test]
    fn modes() {
        assert_eq!(mode(&CsvOptions::default()), Mode::Aligned(b'"'));
        assert_eq!(mode(&CsvOptions { quote: 0, ..Default::default() }), Mode::Plain);
        assert_eq!(mode(&CsvOptions { parallel: false, ..Default::default() }), Mode::Sequential);
    }

    #[test]
    fn record_start_skips_quoted_newlines() {
        let d = b"a,\"x\ny\"\nb\n";
        // pos 4 is inside the quotes (after `a,"x`); the record ends after `y"\n`
        assert_eq!(record_start(d, b'"', 4, true), 8);
        // pos 8 starts a line
        assert_eq!(record_start(d, b'"', 8, false), 8);
    }
}
