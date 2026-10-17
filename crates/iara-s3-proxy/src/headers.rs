//! Which headers cross the proxy in each direction.

use crate::sigv4::UNSIGNED_PAYLOAD;
use hyper::header::{HeaderMap, HeaderName, HeaderValue, CONNECTION};

/// Client headers forwarded to the object store, besides `x-amz-*`.
const FORWARDED: &[&str] = &[
    "range",
    "content-type",
    "content-length",
    "content-md5",
    "content-encoding",
    "content-disposition",
    "content-language",
    "cache-control",
    "expires",
    "if-match",
    "if-none-match",
    "if-modified-since",
    "if-unmodified-since",
];

/// Forwarded headers that are part of the signature (`x-amz-*` ones are always signed).
const SIGNED: &[&str] = &["content-type", "content-md5", "range"];

/// `x-amz-*` headers the proxy generates itself; the client's copies are dropped.
const REGENERATED: &[&str] = &["x-amz-date", "x-amz-content-sha256", "x-amz-security-token"];

/// Response headers that stay on the hop they arrived on.
const HOP_BY_HOP: &[&str] = &[
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
];

/// Why a request cannot be forwarded.
#[derive(Debug, PartialEq, Eq)]
pub enum Rejected {
    /// A header that is signed has a value that is not plain ASCII.
    BadHeader(String),
    /// The body uses a signed streaming format the proxy cannot re-sign.
    SignedStreaming,
}

/// The headers of the upstream request that come from the client.
pub struct Prepared {
    /// Headers to send as they are.
    pub forward: Vec<(HeaderName, HeaderValue)>,
    /// The subset to sign, as lowercase name and text value.
    pub sign: Vec<(String, String)>,
    /// Value for `x-amz-content-sha256`.
    pub payload_hash: &'static str,
}

fn is_amz(name: &str) -> bool {
    name.starts_with("x-amz-") && !REGENERATED.contains(&name)
}

/// Picks the forwarded headers out of the client's, and decides the payload hash.
pub fn prepare(src: &HeaderMap) -> Result<Prepared, Rejected> {
    let payload_hash = match src.get("x-amz-content-sha256").and_then(|v| v.to_str().ok()) {
        // no per-chunk signatures: the body can pass through as is
        Some("STREAMING-UNSIGNED-PAYLOAD-TRAILER") => "STREAMING-UNSIGNED-PAYLOAD-TRAILER",
        Some(v) if v.starts_with("STREAMING-") => return Err(Rejected::SignedStreaming),
        _ => UNSIGNED_PAYLOAD,
    };
    let mut forward = Vec::new();
    let mut sign = Vec::new();
    for (name, value) in src {
        let n = name.as_str();
        if !(FORWARDED.contains(&n) || is_amz(n)) {
            continue;
        }
        forward.push((name.clone(), value.clone()));
        if SIGNED.contains(&n) || is_amz(n) {
            let text = value
                .to_str()
                .map_err(|_| Rejected::BadHeader(n.to_string()))?;
            sign.push((n.to_string(), text.to_string()));
        }
    }
    Ok(Prepared { forward, sign, payload_hash })
}

/// Removes hop-by-hop headers (and the ones the `Connection` header names) from a response.
pub fn strip_hop_by_hop(headers: &mut HeaderMap) {
    let named: Vec<String> = headers
        .get_all(CONNECTION)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    for name in HOP_BY_HOP {
        headers.remove(*name);
    }
    for name in named {
        headers.remove(name.as_str());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, &str)]) -> HeaderMap {
        let mut m = HeaderMap::new();
        for (n, v) in pairs {
            m.append(HeaderName::from_bytes(n.as_bytes()).unwrap(), HeaderValue::from_str(v).unwrap());
        }
        m
    }

    #[test]
    fn forwards_the_listed_headers_and_drops_the_rest() {
        let src = map(&[
            ("authorization", "AWS4-HMAC-SHA256 Credential=dummy"),
            ("host", "127.0.0.1:9000"),
            ("connection", "keep-alive"),
            ("user-agent", "boto3"),
            ("accept-encoding", "identity"),
            ("cookie", "a=b"),
            ("x-amz-date", "19990101T000000Z"),
            ("x-amz-content-sha256", "abc"),
            ("x-amz-security-token", "dummy"),
            ("range", "bytes=0-9"),
            ("if-none-match", "*"),
            ("content-type", "text/plain"),
            ("x-amz-meta-owner", "me"),
            ("x-amz-copy-source", "/b/k"),
            ("expect", "100-continue"),
        ]);
        let p = prepare(&src).unwrap();
        let mut fwd: Vec<&str> = p.forward.iter().map(|(n, _)| n.as_str()).collect();
        fwd.sort();
        assert_eq!(fwd, ["content-type", "if-none-match", "range", "x-amz-copy-source", "x-amz-meta-owner"]);
        let mut sig: Vec<&str> = p.sign.iter().map(|(n, _)| n.as_str()).collect();
        sig.sort();
        assert_eq!(sig, ["content-type", "range", "x-amz-copy-source", "x-amz-meta-owner"]);
        assert_eq!(p.payload_hash, UNSIGNED_PAYLOAD);
    }

    #[test]
    fn streaming_payloads() {
        let ok = map(&[("x-amz-content-sha256", "STREAMING-UNSIGNED-PAYLOAD-TRAILER")]);
        assert_eq!(prepare(&ok).unwrap().payload_hash, "STREAMING-UNSIGNED-PAYLOAD-TRAILER");
        let signed = map(&[("x-amz-content-sha256", "STREAMING-AWS4-HMAC-SHA256-PAYLOAD")]);
        assert_eq!(prepare(&signed).err(), Some(Rejected::SignedStreaming));
    }

    #[test]
    fn signed_header_with_non_ascii_value_is_rejected() {
        let mut m = HeaderMap::new();
        m.insert("x-amz-meta-name", HeaderValue::from_bytes("caf\u{e9}".as_bytes()).unwrap());
        assert_eq!(prepare(&m).err(), Some(Rejected::BadHeader("x-amz-meta-name".into())));
    }

    #[test]
    fn hop_by_hop_response_headers_are_stripped() {
        let mut m = map(&[
            ("etag", "\"x\""),
            ("connection", "keep-alive, x-custom"),
            ("keep-alive", "timeout=5"),
            ("transfer-encoding", "chunked"),
            ("x-custom", "1"),
            ("x-amz-request-id", "r"),
            ("content-range", "bytes 0-9/100"),
        ]);
        strip_hop_by_hop(&mut m);
        let mut left: Vec<&str> = m.keys().map(|k| k.as_str()).collect();
        left.sort();
        assert_eq!(left, ["content-range", "etag", "x-amz-request-id"]);
    }
}
