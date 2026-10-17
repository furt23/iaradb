//! AWS Signature Version 4 (header-based) for S3-style requests.

use crate::encoding::canonical_query;
use hmac::{Hmac, KeyInit, Mac};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::time::{SystemTime, UNIX_EPOCH};

/// `x-amz-content-sha256` value for a payload that is not hashed.
pub const UNSIGNED_PAYLOAD: &str = "UNSIGNED-PAYLOAD";

/// Everything the signature covers besides the credentials.
pub struct SigningRequest<'a> {
    pub method: &'a str,
    /// Canonical URI: the path exactly as sent on the wire (already percent-encoded, never encoded again).
    pub path: &'a str,
    /// Raw query string without the leading `?`.
    pub query: &'a str,
    /// Headers to sign: lowercase name and raw value. Must include `host`, `x-amz-date` and
    /// `x-amz-content-sha256`. Repeated names are joined with a comma.
    pub headers: &'a [(String, String)],
    /// Value of the `x-amz-content-sha256` header (the hex digest, or `UNSIGNED-PAYLOAD`).
    pub payload_hash: &'a str,
}

/// The pieces of a computed signature.
pub struct Signature {
    pub signed_headers: String,
    pub signature: String,
    /// Value for the `Authorization` header.
    pub authorization: String,
}

fn hmac(key: &[u8], data: &[u8]) -> Vec<u8> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

/// Header value as SigV4 canonicalizes it: trimmed, runs of spaces collapsed.
fn normalize_value(v: &str) -> String {
    v.split_ascii_whitespace().collect::<Vec<_>>().join(" ")
}

/// Returns `(canonical headers block, signed headers list)`.
fn canonical_headers(headers: &[(String, String)]) -> (String, String) {
    let mut by_name: BTreeMap<String, Vec<String>> = BTreeMap::new();
    for (name, value) in headers {
        by_name
            .entry(name.to_ascii_lowercase())
            .or_default()
            .push(normalize_value(value));
    }
    let mut block = String::new();
    for (name, values) in &by_name {
        block.push_str(name);
        block.push(':');
        block.push_str(&values.join(","));
        block.push('\n');
    }
    let signed = by_name.keys().cloned().collect::<Vec<_>>().join(";");
    (block, signed)
}

/// The canonical request string, plus the signed headers list.
pub fn canonical_request(req: &SigningRequest) -> (String, String) {
    let (block, signed) = canonical_headers(req.headers);
    let text = format!(
        "{}\n{}\n{}\n{}\n{}\n{}",
        req.method,
        req.path,
        canonical_query(req.query),
        block,
        signed,
        req.payload_hash
    );
    (text, signed)
}

/// Signs `req` for `service` in `region` with the credentials. `amz_date` is `YYYYMMDDTHHMMSSZ`.
pub fn sign(
    access_key_id: &str,
    secret_access_key: &str,
    region: &str,
    service: &str,
    amz_date: &str,
    req: &SigningRequest,
) -> Signature {
    let (canonical, signed_headers) = canonical_request(req);
    let day = &amz_date[..8];
    let scope = format!("{day}/{region}/{service}/aws4_request");
    let to_sign = format!(
        "AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}",
        hex::encode(Sha256::digest(canonical.as_bytes()))
    );
    let k_date = hmac(format!("AWS4{secret_access_key}").as_bytes(), day.as_bytes());
    let k_region = hmac(&k_date, region.as_bytes());
    let k_service = hmac(&k_region, service.as_bytes());
    let k_signing = hmac(&k_service, b"aws4_request");
    let signature = hex::encode(hmac(&k_signing, to_sign.as_bytes()));
    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={access_key_id}/{scope}, SignedHeaders={signed_headers}, Signature={signature}"
    );
    Signature {
        signed_headers,
        signature,
        authorization,
    }
}

/// Formats Unix seconds as `YYYYMMDDTHHMMSSZ` (UTC).
pub fn format_amz_date(unix_secs: u64) -> String {
    let days = (unix_secs / 86_400) as i64;
    let rem = unix_secs % 86_400;
    // civil-from-days (proleptic Gregorian), after Howard Hinnant
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!(
        "{y:04}{m:02}{d:02}T{:02}{:02}{:02}Z",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// The current time as `YYYYMMDDTHHMMSSZ`.
pub fn amz_date_now() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format_amz_date(secs)
}

#[cfg(test)]
mod tests {
    use super::*;

    const AK: &str = "AKIAIOSFODNN7EXAMPLE";
    const SK: &str = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const EMPTY_SHA: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const HOST: &str = "examplebucket.s3.amazonaws.com";

    fn h(name: &str, value: &str) -> (String, String) {
        (name.to_string(), value.to_string())
    }

    fn s3_headers(extra: &[(&str, &str)], payload: &str) -> Vec<(String, String)> {
        let mut v = vec![
            h("host", HOST),
            h("x-amz-content-sha256", payload),
            h("x-amz-date", "20130524T000000Z"),
        ];
        v.extend(extra.iter().map(|(n, x)| h(n, x)));
        v
    }

    fn sig_s3(method: &str, path: &str, query: &str, headers: &[(String, String)], payload: &str) -> Signature {
        let req = SigningRequest { method, path, query, headers, payload_hash: payload };
        sign(AK, SK, "us-east-1", "s3", "20130524T000000Z", &req)
    }

    // AWS docs, "Signature Calculations for the Authorization Header", Example: GET Object
    #[test]
    fn aws_example_get_object_with_range() {
        let headers = s3_headers(&[("range", "bytes=0-9")], EMPTY_SHA);
        let s = sig_s3("GET", "/test.txt", "", &headers, EMPTY_SHA);
        assert_eq!(s.signed_headers, "host;range;x-amz-content-sha256;x-amz-date");
        assert_eq!(
            s.signature,
            "f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
        assert_eq!(
            s.authorization,
            "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, \
             SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, \
             Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
        );
    }

    // Example: GET Bucket Lifecycle (a subresource query without a value)
    #[test]
    fn aws_example_get_bucket_lifecycle() {
        let headers = s3_headers(&[], EMPTY_SHA);
        let s = sig_s3("GET", "/", "lifecycle", &headers, EMPTY_SHA);
        assert_eq!(
            s.signature,
            "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543"
        );
    }

    // Example: GET Bucket (List Objects), two query parameters
    #[test]
    fn aws_example_list_objects_with_query() {
        let headers = s3_headers(&[], EMPTY_SHA);
        let s = sig_s3("GET", "/", "max-keys=2&prefix=J", &headers, EMPTY_SHA);
        assert_eq!(
            s.signature,
            "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7"
        );
        // the order the client wrote the parameters in does not matter
        let swapped = sig_s3("GET", "/", "prefix=J&max-keys=2", &headers, EMPTY_SHA);
        assert_eq!(swapped.signature, s.signature);
    }

    // Example: PUT Object (encoded path, extra signed headers, a real payload hash)
    #[test]
    fn aws_example_put_object() {
        let payload = "44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072";
        let headers = s3_headers(
            &[
                ("date", "Fri, 24 May 2013 00:00:00 GMT"),
                ("x-amz-storage-class", "REDUCED_REDUNDANCY"),
            ],
            payload,
        );
        let s = sig_s3("PUT", "/test%24file.text", "", &headers, payload);
        assert_eq!(
            s.signed_headers,
            "date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class"
        );
        assert_eq!(
            s.signature,
            "98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd"
        );
    }

    // AWS docs, "Create a signed AWS API request": IAM ListUsers (a non-S3 service, query plus Content-Type)
    #[test]
    fn aws_example_iam_list_users() {
        let headers = vec![
            h("content-type", "application/x-www-form-urlencoded; charset=utf-8"),
            h("host", "iam.amazonaws.com"),
            h("x-amz-date", "20150830T123600Z"),
        ];
        let req = SigningRequest {
            method: "GET",
            path: "/",
            query: "Action=ListUsers&Version=2010-05-08",
            headers: &headers,
            payload_hash: EMPTY_SHA,
        };
        let s = sign(
            "AKIDEXAMPLE",
            "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
            "us-east-1",
            "iam",
            "20150830T123600Z",
            &req,
        );
        assert_eq!(s.signed_headers, "content-type;host;x-amz-date");
        assert_eq!(
            s.signature,
            "5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7"
        );
    }

    #[test]
    fn header_values_are_trimmed_and_collapsed_and_repeats_joined() {
        let a = vec![h("x-amz-meta-a", "  one   two "), h("x-amz-meta-b", "1"), h("x-amz-meta-b", "2")];
        let (block, signed) = canonical_headers(&a);
        assert_eq!(block, "x-amz-meta-a:one two\nx-amz-meta-b:1,2\n");
        assert_eq!(signed, "x-amz-meta-a;x-amz-meta-b");
    }

    #[test]
    fn path_is_signed_as_given_without_double_encoding() {
        let headers = s3_headers(&[], UNSIGNED_PAYLOAD);
        let (canon, _) = canonical_request(&SigningRequest {
            method: "GET",
            path: "/b/year%3D2024/a%20b.parquet",
            query: "",
            headers: &headers,
            payload_hash: UNSIGNED_PAYLOAD,
        });
        assert!(canon.starts_with("GET\n/b/year%3D2024/a%20b.parquet\n\nhost:"), "{canon}");
    }

    #[test]
    fn amz_date_formats_known_instants() {
        assert_eq!(format_amz_date(0), "19700101T000000Z");
        assert_eq!(format_amz_date(1_369_353_600), "20130524T000000Z");
        assert_eq!(format_amz_date(1_440_938_160), "20150830T123600Z");
        assert_eq!(format_amz_date(951_782_400), "20000229T000000Z");
        assert_eq!(format_amz_date(1_709_251_199), "20240229T235959Z");
        assert_eq!(format_amz_date(1_709_251_200), "20240301T000000Z");
    }

    #[test]
    fn amz_date_now_has_the_right_shape() {
        let d = amz_date_now();
        assert_eq!(d.len(), 16);
        assert!(d.ends_with('Z') && d.as_bytes()[8] == b'T');
        assert!(d.starts_with("20"));
    }
}
