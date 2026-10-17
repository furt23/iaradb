//! Test helpers: a fake object store that verifies SigV4 signatures, a client, a running proxy.
#![allow(dead_code)]

use bytes::Bytes;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::{Body, Incoming};
use hyper::header::HeaderMap;
use hyper::http::request::Parts;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioIo};
use iara_s3_proxy::config::{load_keys, parse_args, Command};
use iara_s3_proxy::proxy::Proxy;
use iara_s3_proxy::sigv4::{self, SigningRequest};
use std::collections::HashMap;
use std::convert::Infallible;
use std::future::Future;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use tokio::net::TcpListener;

pub const AK: &str = "AKIAREALKEYID0000001";
pub const SK: &str = "realSecret/KeyForTests+0123456789abcdefghij";
pub const BUCKET: &str = "team-bucket";

/// Response body type of the fake handlers.
pub type FakeBody = UnsyncBoxBody<Bytes, Infallible>;

pub fn full(data: impl Into<Bytes>) -> FakeBody {
    Full::new(data.into()).boxed_unsync()
}

pub fn reply(status: u16, body: impl Into<Bytes>) -> Response<FakeBody> {
    Response::builder().status(status).body(full(body)).unwrap()
}

/// A directory under the system temp dir, removed on drop.
pub struct TempDir(pub PathBuf);

impl TempDir {
    pub fn new() -> TempDir {
        static N: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "iara-s3-proxy-test-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        TempDir(dir)
    }

    pub fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

/// Writes a keys file readable only by its owner.
pub fn write_keys(path: &Path, access_key_id: &str, secret: &str, token: Option<&str>) {
    let token = token.map(|t| format!(r#","session_token":"{t}""#)).unwrap_or_default();
    std::fs::write(
        path,
        format!(r#"{{"access_key_id":"{access_key_id}","secret_access_key":"{secret}"{token}}}"#),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
    }
}

/// What the fake object store saw of one request.
#[derive(Clone, Debug)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub query: String,
    pub headers: HashMap<String, Vec<String>>,
    pub signed_headers: Vec<String>,
    /// `Ok` when the SigV4 signature recomputed from the request matches, else why not.
    pub signature: Result<(), String>,
}

impl Seen {
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.first()).map(String::as_str)
    }

    pub fn signed(&self, name: &str) -> bool {
        self.signed_headers.iter().any(|h| h == name)
    }

    pub fn assert_signed_ok(&self) {
        assert_eq!(self.signature, Ok(()), "{} {}?{}", self.method, self.path, self.query);
    }
}

/// Recomputes the signature of a received request with the same keys.
fn verify(parts: &Parts, addr: SocketAddr, access_key_id: &str, secret: &str) -> Result<Vec<String>, String> {
    let get = |name: &str| parts.headers.get(name).and_then(|v| v.to_str().ok());
    let auth = get("authorization").ok_or("no Authorization header")?;
    let fields = auth.strip_prefix("AWS4-HMAC-SHA256 ").ok_or("not an AWS4-HMAC-SHA256 header")?;
    let field = |key: &str| {
        fields
            .split(", ")
            .find_map(|f| f.strip_prefix(key))
            .ok_or(format!("no {key} in Authorization"))
    };
    let credential = field("Credential=")?;
    let signed_headers = field("SignedHeaders=")?;
    let signature = field("Signature=")?;
    let scope: Vec<&str> = credential.split('/').collect();
    if scope.len() != 5 || scope[4] != "aws4_request" || scope[3] != "s3" {
        return Err(format!("bad credential scope {credential}"));
    }
    if scope[0] != access_key_id {
        return Err(format!("unexpected access key id {}", scope[0]));
    }
    let amz_date = get("x-amz-date").ok_or("no x-amz-date")?;
    if !amz_date.starts_with(scope[1]) {
        return Err("credential date differs from x-amz-date".into());
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs();
    if amz_date > sigv4::format_amz_date(now + 1).as_str() || amz_date < sigv4::format_amz_date(now - 120).as_str() {
        return Err(format!("x-amz-date {amz_date} is not current"));
    }
    if get("x-amz-content-sha256").is_none() {
        return Err("no x-amz-content-sha256".into());
    }
    let names: Vec<String> = signed_headers.split(';').map(String::from).collect();
    for required in ["host", "x-amz-date", "x-amz-content-sha256"] {
        if !names.iter().any(|n| n == required) {
            return Err(format!("{required} is not signed"));
        }
    }
    if get("host") != Some(addr.to_string().as_str()) {
        return Err(format!("host is {:?}, not {addr}", get("host")));
    }
    let mut headers = Vec::new();
    for name in &names {
        let values: Vec<_> = parts.headers.get_all(name.as_str()).iter().collect();
        if values.is_empty() {
            return Err(format!("signed header {name} is missing"));
        }
        for v in values {
            headers.push((name.clone(), v.to_str().map_err(|e| e.to_string())?.to_string()));
        }
    }
    let payload = get("x-amz-content-sha256").unwrap();
    let expected = sigv4::sign(
        access_key_id,
        secret,
        scope[2],
        "s3",
        amz_date,
        &SigningRequest {
            method: parts.method.as_str(),
            path: parts.uri.path(),
            query: parts.uri.query().unwrap_or(""),
            headers: &headers,
            payload_hash: payload,
        },
    );
    if expected.signature != signature {
        return Err("signature mismatch".into());
    }
    Ok(names)
}

fn to_map(headers: &HeaderMap) -> HashMap<String, Vec<String>> {
    let mut map: HashMap<String, Vec<String>> = HashMap::new();
    for (name, value) in headers {
        map.entry(name.as_str().to_string())
            .or_default()
            .push(String::from_utf8_lossy(value.as_bytes()).into_owned());
    }
    map
}

/// An in-process stand-in for the object store.
pub struct Fake {
    pub addr: SocketAddr,
    seen: Arc<Mutex<Vec<Seen>>>,
    /// The keys it verifies signatures with; replace to simulate a rotation.
    pub keys: Arc<Mutex<(String, String)>>,
}

impl Fake {
    pub fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }

    /// The only request seen so far.
    pub fn only(&self) -> Seen {
        let seen = self.seen();
        assert_eq!(seen.len(), 1, "{seen:#?}");
        seen[0].clone()
    }

    pub fn url(&self) -> String {
        format!("http://{}", self.addr)
    }
}

/// Starts the fake store. Requests whose signature does not verify get 403 without reaching `handler`.
pub async fn start_fake<H, F>(handler: H) -> Fake
where
    H: Fn(Request<Incoming>) -> F + Send + Sync + 'static,
    F: Future<Output = Response<FakeBody>> + Send + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let seen = Arc::new(Mutex::new(Vec::new()));
    let keys = Arc::new(Mutex::new((AK.to_string(), SK.to_string())));
    let handler = Arc::new(handler);
    let (seen2, keys2) = (seen.clone(), keys.clone());
    tokio::spawn(async move {
        loop {
            let (stream, _) = listener.accept().await.unwrap();
            let (handler, seen, keys) = (handler.clone(), seen2.clone(), keys2.clone());
            tokio::spawn(async move {
                let service = service_fn(move |req: Request<Incoming>| {
                    let (handler, seen, keys) = (handler.clone(), seen.clone(), keys.clone());
                    async move {
                        let (parts, body) = req.into_parts();
                        let (id, secret) = keys.lock().unwrap().clone();
                        let checked = verify(&parts, addr, &id, &secret);
                        let ok = checked.is_ok();
                        seen.lock().unwrap().push(Seen {
                            method: parts.method.to_string(),
                            path: parts.uri.path().to_string(),
                            query: parts.uri.query().unwrap_or("").to_string(),
                            headers: to_map(&parts.headers),
                            signed_headers: checked.clone().unwrap_or_default(),
                            signature: checked.map(|_| ()),
                        });
                        let resp = if ok {
                            handler(Request::from_parts(parts, body)).await
                        } else {
                            reply(403, "<Error><Code>SignatureDoesNotMatch</Code></Error>")
                        };
                        Ok::<_, Infallible>(resp)
                    }
                });
                let _ = http1::Builder::new().serve_connection(TokioIo::new(stream), service).await;
            });
        }
    });
    Fake { addr, seen, keys }
}

/// A fake store that answers every request with `200` and an empty body.
pub async fn start_ok_fake() -> Fake {
    start_fake(|_req| async { reply(200, "") }).await
}

/// A proxy running in this process.
pub struct Running {
    pub addr: SocketAddr,
    pub proxy: Arc<Proxy>,
    pub keys_file: PathBuf,
    pub dir: TempDir,
}

/// Starts a proxy for `endpoint` serving [`BUCKET`], with the test keys (and an optional session token).
pub async fn start_proxy(endpoint: &str, token: Option<&str>) -> Running {
    let dir = TempDir::new();
    let keys_file = dir.path().join("r2.json");
    write_keys(&keys_file, AK, SK, token);
    let args = [
        "--listen",
        "127.0.0.1:0",
        "--endpoint",
        endpoint,
        "--bucket",
        BUCKET,
        "--region",
        "auto",
        "--keys-file",
        keys_file.to_str().unwrap(),
    ];
    let Ok(Command::Run(config)) = parse_args(args.iter().map(|s| s.to_string())) else {
        panic!("test arguments should parse");
    };
    let proxy = Arc::new(Proxy::new(&config, load_keys(&keys_file).unwrap()));
    let listener = TcpListener::bind(config.listen).await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(iara_s3_proxy::server::serve(listener, proxy.clone()));
    Running { addr, proxy, keys_file, dir }
}

/// What a client got back.
pub struct Got {
    pub status: StatusCode,
    pub headers: HeaderMap,
    pub body: Bytes,
}

impl Got {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }
}

/// Sends a request with the given body to `addr` and reads the whole answer.
pub async fn send_body<B>(addr: SocketAddr, method: &str, target: &str, headers: &[(&str, &str)], body: B) -> Got
where
    B: Body + Send + Unpin + 'static,
    B::Data: Send,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let resp = send_body_streaming(addr, method, target, headers, body).await;
    let (head, body) = resp.into_parts();
    Got {
        status: head.status,
        headers: head.headers,
        body: body.collect().await.unwrap().to_bytes(),
    }
}

/// Like [`send_body`], but returns the response with its body unread.
pub async fn send_body_streaming<B>(
    addr: SocketAddr,
    method: &str,
    target: &str,
    headers: &[(&str, &str)],
    body: B,
) -> Response<Incoming>
where
    B: Body + Send + Unpin + 'static,
    B::Data: Send,
    B::Error: Into<Box<dyn std::error::Error + Send + Sync>>,
{
    let client = Client::builder(TokioExecutor::new()).build_http::<B>();
    let mut req = Request::builder()
        .method(method)
        .uri(format!("http://{addr}{target}"));
    for (n, v) in headers {
        req = req.header(*n, *v);
    }
    client.request(req.body(body).unwrap()).await.expect("request to the proxy")
}

/// Sends a request with an in-memory body.
pub async fn send(addr: SocketAddr, method: &str, target: &str, headers: &[(&str, &str)], body: &'static str) -> Got {
    send_body(addr, method, target, headers, Full::new(Bytes::from_static(body.as_bytes()))).await
}

