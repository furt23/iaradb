//! Line boundaries for splitting CSV files into byte ranges.

/// File offset of the first line that starts at or after `pos`. `d` holds
/// the file's bytes from offset `base` (with `base <= pos - 1`, so the byte
/// before `pos` is visible). `None` when `d` ends before that line start is
/// found and does not reach the end of the file: more bytes are needed.
pub fn line_start(d: &[u8], base: usize, pos: usize, file_len: usize) -> Option<usize> {
    if pos == 0 {
        return Some(0);
    }
    if pos >= file_len {
        return Some(file_len);
    }
    let i = pos - 1 - base;
    if i >= d.len() {
        return None;
    }
    match memchr::memchr(b'\n', &d[i..]) {
        Some(j) => Some(base + i + j + 1),
        None if base + d.len() >= file_len => Some(file_len),
        None => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const F: &[u8] = b"a,b\n1,2\n33,44\n5,6";

    #[test]
    fn whole_file() {
        let n = F.len();
        assert_eq!(line_start(F, 0, 0, n), Some(0));
        assert_eq!(line_start(F, 0, 1, n), Some(4));
        assert_eq!(line_start(F, 0, 4, n), Some(4));
        assert_eq!(line_start(F, 0, 5, n), Some(8));
        assert_eq!(line_start(F, 0, 15, n), Some(n));
        assert_eq!(line_start(F, 0, 99, n), Some(n));
    }

    #[test]
    fn windows() {
        let n = F.len();
        // window over bytes 7..10 ("\n33"): the line at 8 is visible
        assert_eq!(line_start(&F[7..10], 7, 8, n), Some(8));
        // window over 8..11 ("33,"): no newline after 9, more bytes needed
        assert_eq!(line_start(&F[8..11], 8, 10, n), None);
        // the window reaching the end of the file settles it
        assert_eq!(line_start(&F[14..], 14, 15, n), Some(n));
    }
}
