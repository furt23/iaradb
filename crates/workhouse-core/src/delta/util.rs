//! Small helpers of the log format: URI path encoding and random ids.

use std::hash::{BuildHasher, Hasher};

/// Whether a byte of a relative path is written as is.
fn is_plain(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~' | b'/' | b'=')
}

/// A relative file path as the log writes it (percent encoded URI path).
pub fn percent_encode_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for &b in path.as_bytes() {
        if is_plain(b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// The inverse of [`percent_encode_path`]; malformed escapes stay as written.
pub fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && let Some(v) = hex2(b[i + 1], b[i + 2]) {
            out.push(v);
            i += 3;
        } else {
            out.push(b[i]);
            i += 1;
        }
    }
    String::from_utf8(out).unwrap_or_else(|e| String::from_utf8_lossy(e.as_bytes()).into_owned())
}

fn hex2(a: u8, b: u8) -> Option<u8> {
    let d = |c: u8| (c as char).to_digit(16);
    Some((d(a)? * 16 + d(b)?) as u8)
}

/// A random (version 4) UUID, for table ids and temporary file names.
pub fn new_uuid() -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    // RandomState seeds itself from the OS: a fresh one per half
    let half = |salt: u64| {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(nanos);
        h.write_u64(n);
        h.write_u64(salt);
        h.write_u32(std::process::id());
        h.finish()
    };
    let mut bytes = [0u8; 16];
    bytes[..8].copy_from_slice(&half(1).to_be_bytes());
    bytes[8..].copy_from_slice(&half(2).to_be_bytes());
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let h: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &h[..8], &h[8..12], &h[12..16], &h[16..20], &h[20..])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn paths_round_trip() {
        for p in ["a/b.parquet", "year=2024/x y.parquet", "ü/%/a:b#c.parquet", "p=a%2Fb/f.parquet"] {
            assert_eq!(percent_decode(&percent_encode_path(p)), p);
        }
        assert_eq!(percent_encode_path("a b/ü"), "a%20b/%C3%BC");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("a%zzb"), "a%zzb");
    }

    #[test]
    fn uuids_are_distinct_and_well_formed() {
        let (a, b) = (new_uuid(), new_uuid());
        assert_ne!(a, b);
        assert_eq!(a.len(), 36);
        assert_eq!(a.as_bytes()[14], b'4');
    }
}
