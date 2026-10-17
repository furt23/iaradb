//! Percent-encoding helpers for the SigV4 canonical query string.

/// Percent-decodes `input`. A `%` not followed by two hex digits is kept as is.
/// With `plus_is_space`, `+` decodes to a space (form-style query strings).
pub fn percent_decode(input: &str, plus_is_space: bool) -> Vec<u8> {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let escaped = match (bytes[i], bytes.get(i + 1), bytes.get(i + 2)) {
            (b'%', Some(&h), Some(&l)) => hex_val(h).zip(hex_val(l)),
            _ => None,
        };
        match bytes[i] {
            b'%' if escaped.is_some() => {
                let (h, l) = escaped.unwrap_or_default();
                out.push(h << 4 | l);
                i += 3;
            }
            b'+' if plus_is_space => {
                out.push(b' ');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    out
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

/// Encodes with the RFC 3986 unreserved set (`A-Z a-z 0-9 - _ . ~`), uppercase hex.
pub fn encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(bytes.len());
    for &b in bytes {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.' | b'~') {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 15) as usize] as char);
        }
    }
    out
}

/// SigV4 canonical query string: each parameter decoded and re-encoded, sorted by
/// encoded name then value. A parameter without `=` gets an empty value.
pub fn canonical_query(raw: &str) -> String {
    let mut pairs: Vec<(String, String)> = raw
        .split('&')
        .filter(|p| !p.is_empty())
        .map(|p| {
            let (name, value) = p.split_once('=').unwrap_or((p, ""));
            (encode(&percent_decode(name, true)), encode(&percent_decode(value, true)))
        })
        .collect();
    pairs.sort();
    pairs
        .iter()
        .map(|(n, v)| format!("{n}={v}"))
        .collect::<Vec<_>>()
        .join("&")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decode_handles_escapes_plus_and_garbage() {
        assert_eq!(percent_decode("a%20b%2Fc", false), b"a b/c");
        assert_eq!(percent_decode("a+b", true), b"a b");
        assert_eq!(percent_decode("a+b", false), b"a+b");
        assert_eq!(percent_decode("100%", false), b"100%");
        assert_eq!(percent_decode("%zz%4", false), b"%zz%4");
        assert_eq!(percent_decode("%e2%82%ac", false), "\u{20ac}".as_bytes());
        assert_eq!(percent_decode("%41", false), b"A");
    }

    #[test]
    fn encode_keeps_only_unreserved() {
        assert_eq!(encode(b"a-b_c.d~e"), "a-b_c.d~e");
        assert_eq!(encode(b"a b/c=d&e+f"), "a%20b%2Fc%3Dd%26e%2Bf");
        assert_eq!(encode("\u{20ac}".as_bytes()), "%E2%82%AC");
    }

    #[test]
    fn canonical_query_sorts_and_normalizes() {
        assert_eq!(canonical_query(""), "");
        assert_eq!(canonical_query("uploads"), "uploads=");
        assert_eq!(canonical_query("max-keys=2&prefix=J"), "max-keys=2&prefix=J");
        assert_eq!(canonical_query("prefix=J&max-keys=2"), "max-keys=2&prefix=J");
        assert_eq!(
            canonical_query("uploadId=x&partNumber=1"),
            "partNumber=1&uploadId=x"
        );
        // lowercase escapes and unneeded escapes are normalized
        assert_eq!(canonical_query("prefix=a%2fb%41&delimiter=/"), "delimiter=%2F&prefix=a%2FbA");
        assert_eq!(canonical_query("a=2&a=1&b"), "a=1&a=2&b=");
        assert_eq!(canonical_query("&&x=1&"), "x=1");
    }
}
