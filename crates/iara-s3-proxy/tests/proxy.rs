//! The proxy against an in-process fake object store that recomputes every SigV4 signature.

mod common;

use bytes::Bytes;
use common::*;
use http_body_util::{BodyExt, Empty, Full, StreamBody};
use hyper::body::Frame;
use hyper::Response;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Notify;
use tokio::time::timeout;

const MB: usize = 1 << 20;

fn object(path: &str) -> String {
    format!("/{BUCKET}/{path}")
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn ranged_get_is_forwarded_with_a_valid_signature() {
    let fake = start_fake(|_req| async {
        Response::builder()
            .status(206)
            .header("content-range", "bytes 10-19/100")
            .header("content-type", "application/octet-stream")
            .header("etag", "\"abc123\"")
            .header("accept-ranges", "bytes")
            .header("last-modified", "Wed, 21 Oct 2015 07:28:00 GMT")
            .header("x-amz-request-id", "req-1")
            .body(full("0123456789"))
            .unwrap()
    })
    .await;
    let proxy = start_proxy(&fake.url(), None).await;
    let got = send(proxy.addr, "GET", &object("data/part-0.parquet"), &[("range", "bytes=10-19")], "").await;

    assert_eq!(got.status, 206);
    assert_eq!(got.text(), "0123456789");
    assert_eq!(got.header("content-range"), Some("bytes 10-19/100"));
    assert_eq!(got.header("content-length"), Some("10"));
    assert_eq!(got.header("etag"), Some("\"abc123\""));
    assert_eq!(got.header("accept-ranges"), Some("bytes"));
    assert_eq!(got.header("last-modified"), Some("Wed, 21 Oct 2015 07:28:00 GMT"));
    assert_eq!(got.header("content-type"), Some("application/octet-stream"));
    assert_eq!(got.header("x-amz-request-id"), Some("req-1"));

    let seen = fake.only();
    seen.assert_signed_ok();
    assert_eq!((seen.method.as_str(), seen.path.as_str()), ("GET", "/team-bucket/data/part-0.parquet"));
    assert_eq!(seen.header("range"), Some("bytes=10-19"));
    assert!(seen.signed("range"), "{:?}", seen.signed_headers);
    assert_eq!(seen.header("x-amz-content-sha256"), Some("UNSIGNED-PAYLOAD"));
    assert_eq!(seen.signed_headers, ["host", "range", "x-amz-content-sha256", "x-amz-date"]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn client_credentials_and_foreign_headers_are_not_forwarded() {
    let fake = start_ok_fake().await;
    let proxy = start_proxy(&fake.url(), None).await;
    let client_date = "20200101T000000Z";
    let got = send(
        proxy.addr,
        "GET",
        &object("k"),
        &[
            ("authorization", "AWS4-HMAC-SHA256 Credential=DUMMYKEY/20200101/us-east-1/s3/aws4_request, SignedHeaders=host;x-amz-date, Signature=deadbeef"),
            ("x-amz-date", client_date),
            ("x-amz-content-sha256", "DUMMYSHA"),
            ("x-amz-security-token", "DUMMYTOKEN"),
            ("x-amz-meta-owner", "rafael"),
            ("cookie", "session=1"),
            ("user-agent", "Boto3/1.0"),
            ("accept-encoding", "identity"),
            ("proxy-authorization", "Basic xyz"),
            ("host", "some-other-bucket.s3.amazonaws.com"),
        ],
        "",
    )
    .await;
    assert_eq!(got.status, 200);

    let seen = fake.only();
    seen.assert_signed_ok();
    let auth = seen.header("authorization").unwrap();
    assert!(auth.starts_with(&format!("AWS4-HMAC-SHA256 Credential={AK}/")), "{auth}");
    for (name, values) in &seen.headers {
        for v in values {
            assert!(!v.contains("DUMMY") && !v.contains("deadbeef"), "{name}: {v}");
        }
    }
    for gone in ["cookie", "user-agent", "accept-encoding", "proxy-authorization", "x-amz-security-token"] {
        assert!(seen.header(gone).is_none(), "{gone} was forwarded");
    }
    assert_ne!(seen.header("x-amz-date"), Some(client_date));
    assert_eq!(seen.header("x-amz-content-sha256"), Some("UNSIGNED-PAYLOAD"));
    assert_eq!(seen.header("x-amz-meta-owner"), Some("rafael"));
    assert!(seen.signed("x-amz-meta-owner"));
    // the Host header the client sent is ignored: the endpoint's host is signed and sent
    assert_eq!(seen.header("host"), Some(fake.addr.to_string().as_str()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn session_token_is_signed_and_sent_when_configured() {
    let fake = start_ok_fake().await;
    let proxy = start_proxy(&fake.url(), Some("SESSION/TOKEN==")).await;
    let got = send(proxy.addr, "GET", &object("k"), &[("x-amz-security-token", "DUMMYTOKEN")], "").await;
    assert_eq!(got.status, 200);
    let seen = fake.only();
    seen.assert_signed_ok();
    assert_eq!(seen.header("x-amz-security-token"), Some("SESSION/TOKEN=="));
    assert!(seen.signed("x-amz-security-token"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn response_body_streams_without_buffering() {
    let gate = Arc::new(Notify::new());
    let g = gate.clone();
    let fake = start_fake(move |_req| {
        let g = g.clone();
        async move {
            // the second chunk is only produced after the client has read the first one through the proxy
            let chunks = futures_util::stream::unfold(0usize, move |i| {
                let g = g.clone();
                async move {
                    if i == 8 {
                        return None;
                    }
                    if i == 1 {
                        g.notified().await;
                    }
                    Some((Ok::<_, Infallible>(Frame::data(Bytes::from(vec![i as u8; MB]))), i + 1))
                }
            });
            Response::builder()
                .status(200)
                .header("content-length", (8 * MB).to_string())
                .body(StreamBody::new(chunks).boxed_unsync())
                .unwrap()
        }
    })
    .await;
    let proxy = start_proxy(&fake.url(), None).await;

    let resp = timeout(
        Duration::from_secs(10),
        send_body_streaming(proxy.addr, "GET", &object("big.parquet"), &[], Empty::<Bytes>::new()),
    )
    .await
    .expect("the proxy held back the response headers");
    assert_eq!(resp.status(), 200);
    assert_eq!(resp.headers()["content-length"], (8 * MB).to_string().as_str());
    let mut body = resp.into_body();
    let first = timeout(Duration::from_secs(10), body.frame())
        .await
        .expect("the proxy buffered the response instead of streaming it")
        .unwrap()
        .unwrap()
        .into_data()
        .unwrap();
    assert!(!first.is_empty() && first.iter().all(|b| *b == 0));
    gate.notify_one();

    let mut total = first.len();
    let mut last = 0u8;
    while let Some(frame) = timeout(Duration::from_secs(10), body.frame()).await.expect("stalled") {
        let data = frame.unwrap().into_data().unwrap();
        total += data.len();
        last = *data.last().unwrap();
    }
    assert_eq!(total, 8 * MB);
    assert_eq!(last, 7);
    fake.only().assert_signed_ok();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn request_body_streams_without_buffering() {
    let first_seen = Arc::new(Notify::new());
    let f = first_seen.clone();
    let fake = start_fake(move |req| {
        let f = f.clone();
        async move {
            let mut body = req.into_body();
            let (mut total, mut first) = (0usize, true);
            while let Some(frame) = body.frame().await {
                if let Ok(data) = frame.unwrap().into_data() {
                    total += data.len();
                    if std::mem::take(&mut first) {
                        f.notify_one();
                    }
                }
            }
            Response::builder()
                .status(200)
                .header("etag", "\"stored\"")
                .header("x-received", total.to_string())
                .body(full(""))
                .unwrap()
        }
    })
    .await;
    let proxy = start_proxy(&fake.url(), None).await;

    // 16 MB in 1 MB chunks; the second chunk is only sent once the store has received the first
    let f = first_seen.clone();
    let chunks = futures_util::stream::unfold(0usize, move |i| {
        let f = f.clone();
        async move {
            if i == 16 {
                return None;
            }
            if i == 1 {
                timeout(Duration::from_secs(10), f.notified())
                    .await
                    .expect("the proxy buffered the request instead of streaming it");
            }
            Some((Ok::<_, Infallible>(Frame::data(Bytes::from(vec![i as u8; MB]))), i + 1))
        }
    });
    let len = (16 * MB).to_string();
    let got = timeout(
        Duration::from_secs(30),
        send_body(
            proxy.addr,
            "PUT",
            &object("out/big.bin"),
            &[("content-length", &len), ("content-type", "application/octet-stream")],
            Box::pin(StreamBody::new(chunks)),
        ),
    )
    .await
    .expect("upload stalled");
    assert_eq!(got.status, 200);
    assert_eq!(got.header("etag"), Some("\"stored\""));
    assert_eq!(got.header("x-received"), Some(len.as_str()));
    let seen = fake.only();
    seen.assert_signed_ok();
    assert_eq!(seen.header("content-length"), Some(len.as_str()));
    assert_eq!(seen.header("content-type"), Some("application/octet-stream"));
    assert!(seen.signed("content-type"));
    assert_eq!(seen.header("x-amz-content-sha256"), Some("UNSIGNED-PAYLOAD"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn put_if_none_match_forwards_the_header_and_the_412() {
    let fake = start_fake(|req| async move {
        let exists = req.uri().path().ends_with("/exists");
        let guarded = req.headers().get("if-none-match").is_some_and(|v| v == "*");
        if exists && guarded {
            Response::builder()
                .status(412)
                .header("content-type", "application/xml")
                .body(full("<Error><Code>PreconditionFailed</Code></Error>"))
                .unwrap()
        } else {
            reply(200, "")
        }
    })
    .await;
    let proxy = start_proxy(&fake.url(), None).await;

    let got = send(proxy.addr, "PUT", &object("exists"), &[("if-none-match", "*")], "data").await;
    assert_eq!(got.status, 412);
    assert!(got.text().contains("PreconditionFailed"), "{}", got.text());
    let got = send(proxy.addr, "PUT", &object("fresh"), &[("if-none-match", "*")], "data").await;
    assert_eq!(got.status, 200);

    let seen = fake.seen();
    assert_eq!(seen.len(), 2);
    for s in &seen {
        s.assert_signed_ok();
        assert_eq!(s.header("if-none-match"), Some("*"));
    }
    // conditional headers are forwarded but not part of the signature
    assert!(!seen[0].signed("if-none-match"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn multipart_upload_requests_sign_correctly() {
    let fake = start_fake(|req| async move {
        match req.uri().query().unwrap_or("") {
            "uploads" => reply(200, "<InitiateMultipartUploadResult><UploadId>x</UploadId></InitiateMultipartUploadResult>"),
            q if q.starts_with("partNumber") => Response::builder().status(200).header("etag", "\"part1\"").body(full("")).unwrap(),
            _ => reply(200, "<CompleteMultipartUploadResult/>"),
        }
    })
    .await;
    let proxy = start_proxy(&fake.url(), None).await;
    let key = object("big/file.parquet");

    let got = send(proxy.addr, "POST", &format!("{key}?uploads"), &[("content-type", "application/octet-stream")], "").await;
    assert_eq!(got.status, 200);
    assert!(got.text().contains("UploadId"));
    let got = send(proxy.addr, "PUT", &format!("{key}?partNumber=1&uploadId=x"), &[("content-md5", "1B2M2Y8AsgTpgAmY7PhCfg==")], "part body").await;
    assert_eq!(got.status, 200);
    assert_eq!(got.header("etag"), Some("\"part1\""));
    // parameters out of order, an upload id that needs encoding
    let got = send(proxy.addr, "PUT", &format!("{key}?uploadId=2~Abc%2Bdef%3D%3D&partNumber=2"), &[], "part").await;
    assert_eq!(got.status, 200);
    let got = send(proxy.addr, "POST", &format!("{key}?uploadId=x"), &[("content-type", "application/xml")], "<CompleteMultipartUpload/>").await;
    assert_eq!(got.status, 200);
    let got = send(proxy.addr, "DELETE", &format!("{key}?uploadId=x"), &[], "").await;
    assert_eq!(got.status, 200);
    let got = send(proxy.addr, "GET", &format!("/{BUCKET}?uploads&prefix=big%2F"), &[], "").await;
    assert_eq!(got.status, 200);

    let seen = fake.seen();
    assert_eq!(seen.len(), 6);
    let queries: Vec<&str> = seen.iter().map(|s| s.query.as_str()).collect();
    assert_eq!(
        queries,
        ["uploads", "partNumber=1&uploadId=x", "uploadId=2~Abc%2Bdef%3D%3D&partNumber=2", "uploadId=x", "uploadId=x", "uploads&prefix=big%2F"]
    );
    for s in &seen {
        s.assert_signed_ok();
    }
    assert!(seen[1].signed("content-md5"));
    assert!(seen[0].signed("content-type"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn paths_and_queries_reach_the_store_exactly_as_sent() {
    let fake = start_ok_fake().await;
    let proxy = start_proxy(&fake.url(), None).await;
    let targets = [
        "/team-bucket/year%3D2024/a%20b%2Bc.parquet",
        "/team-bucket/hive/year=2024/month=01/part-0.parquet",
        "/team-bucket/caf%C3%A9/%E2%82%AC.txt",
        "/team-bucket/a%2Fb",
        "/team-bucket/odd$name,(1)!*'.bin",
        "/team-bucket//double//slash",
        "/team-bucket/dir/?list-type=2&prefix=a%2Fb%20c&delimiter=%2F&continuation-token=1%2BAbC%3D%3D&start-after=x+y",
        "/team-bucket?list-type=2&max-keys=1000",
        "/team-bucket/k?versionId=a&acl",
    ];
    for target in targets {
        let got = send(proxy.addr, "GET", target, &[], "").await;
        assert_eq!(got.status, 200, "{target}");
    }
    let seen = fake.seen();
    assert_eq!(seen.len(), targets.len());
    for (target, s) in targets.iter().zip(&seen) {
        s.assert_signed_ok();
        let sent = match s.query.as_str() {
            "" => s.path.clone(),
            q => format!("{}?{q}", s.path),
        };
        assert_eq!(&sent, target);
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn other_buckets_and_odd_paths_get_a_403_without_reaching_the_store() {
    let fake = start_ok_fake().await;
    let proxy = start_proxy(&fake.url(), None).await;
    let denied = [
        "/other-bucket/key",
        "/other-bucket",
        "/",
        "/team-bucketx/key",
        "/team-buck/key",
        "/team-bucket-2",
        "//team-bucket/key",
        "/TEAM-BUCKET/key",
        "/%74eam-bucket/key",
        "/team-bucket/../other-bucket/key",
        "/team-bucket/%2e%2E/other-bucket/key",
        "/team-bucket/a/./b",
        "/team-bucket/a/..",
    ];
    for target in denied {
        let got = send(proxy.addr, "GET", target, &[], "").await;
        assert_eq!(got.status, 403, "{target}");
        assert_eq!(got.header("content-type"), Some("application/xml"), "{target}");
        assert!(got.text().contains("<Code>AccessDenied</Code>"), "{target}: {}", got.text());
    }
    let got = send(proxy.addr, "GET", "/other-bucket/key", &[], "").await;
    assert!(got.text().contains("<Message>this proxy serves only s3://team-bucket</Message>"), "{}", got.text());
    assert!(got.text().starts_with("<?xml"));
    assert!(fake.seen().is_empty(), "{:?}", fake.seen());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bucket_level_requests_are_limited_to_listing_and_bulk_delete() {
    let fake = start_ok_fake().await;
    let proxy = start_proxy(&fake.url(), None).await;
    let allowed = [
        ("GET", "/team-bucket?list-type=2"),
        ("GET", "/team-bucket/?list-type=2"),
        ("HEAD", "/team-bucket"),
        ("POST", "/team-bucket?delete"),
        ("DELETE", "/team-bucket/some/key"),
        ("PUT", "/team-bucket/some/key?tagging"),
    ];
    for (method, target) in allowed {
        let got = send(proxy.addr, method, target, &[], "").await;
        assert_eq!(got.status, 200, "{method} {target}");
    }
    let refused = [
        ("PUT", "/team-bucket"),
        ("DELETE", "/team-bucket"),
        ("PUT", "/team-bucket?cors"),
        ("PUT", "/team-bucket/?policy"),
        ("POST", "/team-bucket"),
        ("DELETE", "/team-bucket?lifecycle"),
    ];
    for (method, target) in refused {
        let got = send(proxy.addr, method, target, &[], "").await;
        assert_eq!(got.status, 403, "{method} {target}");
        assert!(got.text().contains("AccessDenied"));
    }
    assert_eq!(fake.seen().len(), allowed.len());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn head_requests_return_the_headers_without_a_body() {
    let fake = start_fake(|_req| async {
        Response::builder()
            .status(200)
            .header("content-length", "123")
            .header("etag", "\"h\"")
            .body(full(""))
            .unwrap()
    })
    .await;
    let proxy = start_proxy(&fake.url(), None).await;
    let got = send(proxy.addr, "HEAD", &object("k"), &[], "").await;
    assert_eq!(got.status, 200);
    assert_eq!(got.header("content-length"), Some("123"));
    assert_eq!(got.header("etag"), Some("\"h\""));
    assert!(got.body.is_empty());
    fake.only().assert_signed_ok();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn errors_from_the_store_pass_through_unchanged() {
    let fake = start_fake(|_req| async {
        Response::builder()
            .status(404)
            .header("content-type", "application/xml")
            .body(full("<Error><Code>NoSuchKey</Code></Error>"))
            .unwrap()
    })
    .await;
    let proxy = start_proxy(&fake.url(), None).await;
    let got = send(proxy.addr, "GET", &object("missing"), &[], "").await;
    assert_eq!(got.status, 404);
    assert_eq!(got.text(), "<Error><Code>NoSuchKey</Code></Error>");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn many_parallel_ranged_gets() {
    let fake = start_fake(|req| async move {
        let range = req.headers().get("range").unwrap().to_str().unwrap().to_string();
        Response::builder()
            .status(206)
            .header("content-range", format!("{}/1000", range.replace("bytes=", "bytes ")))
            .body(full(vec![b'x'; 100]))
            .unwrap()
    })
    .await;
    let proxy = start_proxy(&fake.url(), None).await;
    let addr = proxy.addr;
    let tasks: Vec<_> = (0..64)
        .map(|i| {
            tokio::spawn(async move {
                let range = format!("bytes={}-{}", i * 100, i * 100 + 99);
                let got = send_body(addr, "GET", &object(&format!("part-{i}.parquet")), &[("range", &range)], Empty::<Bytes>::new()).await;
                (got.status, got.body.len())
            })
        })
        .collect();
    for t in tasks {
        assert_eq!(t.await.unwrap(), (hyper::StatusCode::PARTIAL_CONTENT, 100));
    }
    let seen = fake.seen();
    assert_eq!(seen.len(), 64);
    for s in &seen {
        s.assert_signed_ok();
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn keys_can_be_rotated_without_restarting() {
    let fake = start_ok_fake().await;
    let proxy = start_proxy(&fake.url(), None).await;
    assert_eq!(send(proxy.addr, "GET", &object("k"), &[], "").await.status, 200);

    // the store switches to new keys: until the proxy reloads, its signatures are refused
    *fake.keys.lock().unwrap() = ("AKIANEWKEYID0000002".to_string(), "newSecretKey0123456789".to_string());
    assert_eq!(send(proxy.addr, "GET", &object("k"), &[], "").await.status, 403);

    // a broken file is rejected and the old keys stay in place
    std::fs::write(&proxy.keys_file, "{ not json").unwrap();
    assert!(proxy.proxy.reload_keys().is_err());
    assert_eq!(send(proxy.addr, "GET", &object("k"), &[], "").await.status, 403);

    write_keys(&proxy.keys_file, "AKIANEWKEYID0000002", "newSecretKey0123456789", None);
    proxy.proxy.reload_keys().unwrap();
    assert_eq!(send(proxy.addr, "GET", &object("k"), &[], "").await.status, 200);
    let seen = fake.seen();
    assert_eq!(seen.last().unwrap().signature, Ok(()));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn unreachable_store_gives_a_502() {
    let proxy = start_proxy("http://127.0.0.1:1", None).await;
    let got = send(proxy.addr, "GET", &object("k"), &[], "").await;
    assert_eq!(got.status, 502);
    assert!(got.text().contains("<Code>ServiceUnavailable</Code>"), "{}", got.text());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn signed_streaming_uploads_are_refused_and_unsigned_trailer_ones_pass() {
    let fake = start_ok_fake().await;
    let proxy = start_proxy(&fake.url(), None).await;
    let got = send(proxy.addr, "PUT", &object("k"), &[("x-amz-content-sha256", "STREAMING-AWS4-HMAC-SHA256-PAYLOAD")], "x").await;
    assert_eq!(got.status, 501);
    assert!(fake.seen().is_empty());

    let got = send(
        proxy.addr,
        "PUT",
        &object("k"),
        &[
            ("x-amz-content-sha256", "STREAMING-UNSIGNED-PAYLOAD-TRAILER"),
            ("content-encoding", "aws-chunked"),
            ("x-amz-trailer", "x-amz-checksum-crc32"),
            ("x-amz-decoded-content-length", "1"),
        ],
        "1\r\nx\r\n0\r\nx-amz-checksum-crc32:AAAAAA==\r\n\r\n",
    )
    .await;
    assert_eq!(got.status, 200);
    let seen = fake.only();
    seen.assert_signed_ok();
    assert_eq!(seen.header("x-amz-content-sha256"), Some("STREAMING-UNSIGNED-PAYLOAD-TRAILER"));
    assert_eq!(seen.header("content-encoding"), Some("aws-chunked"));
    assert!(seen.signed("x-amz-trailer") && seen.signed("x-amz-decoded-content-length"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_large_object_downloads_intact() {
    let fake = start_fake(|_req| async {
        let data: Vec<u8> = (0..4 * MB).map(|i| (i % 251) as u8).collect();
        reply(200, data)
    })
    .await;
    let proxy = start_proxy(&fake.url(), None).await;
    let got = send_body(proxy.addr, "GET", &object("big"), &[], Full::new(Bytes::new())).await;
    assert_eq!(got.body.len(), 4 * MB);
    assert!(got.body.iter().enumerate().all(|(i, b)| *b == (i % 251) as u8));
}
