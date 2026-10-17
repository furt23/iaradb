//! Request handling: check the path, re-sign, forward, stream the answer back.

use crate::config::{load_keys, Config, ConfigError, Endpoint, Keys};
use crate::encoding::percent_decode;
use crate::headers::{self, Rejected};
use crate::sigv4::{self, SigningRequest};
use bytes::Bytes;
use http_body_util::combinators::BoxBody;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::header::{HeaderName, HeaderValue, AUTHORIZATION, CONTENT_TYPE, HOST};
use hyper::{Method, Request, Response, StatusCode, Uri, Version};
use hyper_rustls::{HttpsConnector, HttpsConnectorBuilder};
use hyper_util::client::legacy::connect::HttpConnector;
use hyper_util::client::legacy::Client;
use hyper_util::rt::{TokioExecutor, TokioTimer};
use std::path::PathBuf;
use std::sync::{Arc, RwLock};
use std::time::Duration;

/// Response body type: the upstream body passes straight through, errors are built in memory.
pub type Body = BoxBody<Bytes, hyper::Error>;

type Upstream = Client<HttpsConnector<HttpConnector>, Incoming>;

/// The proxy: one configured bucket, the current keys and a pooled upstream client.
pub struct Proxy {
    bucket: String,
    region: String,
    endpoint: Endpoint,
    keys_file: PathBuf,
    keys: RwLock<Arc<Keys>>,
    client: Upstream,
}

/// A request the proxy answers itself instead of forwarding.
struct Refusal {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl Refusal {
    fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Refusal {
        Refusal { status, code, message: message.into() }
    }
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn error_response(r: Refusal) -> Response<Body> {
    let xml = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<Error><Code>{}</Code><Message>{}</Message><RequestId>iara-s3-proxy</RequestId></Error>",
        r.code,
        xml_escape(&r.message)
    );
    let mut resp = Response::new(Full::new(Bytes::from(xml)).map_err(|never| match never {}).boxed());
    *resp.status_mut() = r.status;
    resp.headers_mut().insert(CONTENT_TYPE, HeaderValue::from_static("application/xml"));
    resp
}

/// `error: cause: cause` for an error and its sources.
fn error_chain(e: &dyn std::error::Error) -> String {
    let mut text = e.to_string();
    let mut source = e.source();
    while let Some(s) = source {
        text.push_str(": ");
        text.push_str(&s.to_string());
        source = s.source();
    }
    text
}

impl Proxy {
    /// Builds the proxy for `config` with the keys already loaded from `config.keys_file`.
    pub fn new(config: &Config, keys: Keys) -> Proxy {
        let mut http = HttpConnector::new();
        http.enforce_http(false);
        http.set_nodelay(true);
        http.set_connect_timeout(Some(Duration::from_secs(10)));
        let https = HttpsConnectorBuilder::new()
            .with_provider_and_webpki_roots(rustls::crypto::ring::default_provider())
            .expect("the ring provider supports the default TLS versions")
            .https_or_http()
            .enable_http1()
            .wrap_connector(http);
        let client = Client::builder(TokioExecutor::new())
            .pool_timer(TokioTimer::new())
            .pool_idle_timeout(Duration::from_secs(20))
            .build(https);
        Proxy {
            bucket: config.bucket.clone(),
            region: config.region.clone(),
            endpoint: config.endpoint.clone(),
            keys_file: config.keys_file.clone(),
            keys: RwLock::new(Arc::new(keys)),
            client,
        }
    }

    /// Re-reads the keys file. On failure the previous keys stay in use.
    pub fn reload_keys(&self) -> Result<(), ConfigError> {
        let keys = load_keys(&self.keys_file)?;
        *self.keys.write().unwrap_or_else(|p| p.into_inner()) = Arc::new(keys);
        Ok(())
    }

    fn keys(&self) -> Arc<Keys> {
        self.keys.read().unwrap_or_else(|p| p.into_inner()).clone()
    }

    /// Answers one request: forwarded to the object store, or refused.
    pub async fn handle(&self, req: Request<Incoming>) -> Response<Body> {
        match self.forward(req).await {
            Ok(resp) => resp,
            Err(refusal) => error_response(refusal),
        }
    }

    fn denied(&self, what: &str) -> Refusal {
        Refusal::new(
            StatusCode::FORBIDDEN,
            "AccessDenied",
            format!("{what}; this proxy serves only s3://{}", self.bucket),
        )
    }

    /// Only `/<bucket>` and `/<bucket>/<key...>` are served, without dot segments, and the bucket
    /// itself can be listed or have objects deleted in bulk but not created, deleted or reconfigured.
    fn check_scope(&self, method: &Method, path: &str, query: &str) -> Result<(), Refusal> {
        let rest = path
            .strip_prefix('/')
            .and_then(|p| p.strip_prefix(self.bucket.as_str()))
            .filter(|r| r.is_empty() || r.starts_with('/'));
        let Some(rest) = rest else {
            return Err(Refusal::new(
                StatusCode::FORBIDDEN,
                "AccessDenied",
                format!("this proxy serves only s3://{}", self.bucket),
            ));
        };
        if rest.split('/').any(|seg| matches!(percent_decode(seg, false).as_slice(), b"." | b"..")) {
            return Err(self.denied("dot segments are not allowed in the path"));
        }
        if rest.is_empty() || rest == "/" {
            let bulk_delete = query
                .split('&')
                .any(|p| percent_decode(p.split('=').next().unwrap_or(""), true) == b"delete");
            let ok = matches!(*method, Method::GET | Method::HEAD) || (*method == Method::POST && bulk_delete);
            if !ok {
                return Err(self.denied("bucket-level changes are not allowed"));
            }
        }
        Ok(())
    }

    async fn forward(&self, req: Request<Incoming>) -> Result<Response<Body>, Refusal> {
        let (parts, body) = req.into_parts();
        let path = parts.uri.path();
        let query = parts.uri.query().unwrap_or("");
        self.check_scope(&parts.method, path, query)?;
        let prepared = headers::prepare(&parts.headers).map_err(|r| match r {
            Rejected::BadHeader(name) => {
                Refusal::new(StatusCode::BAD_REQUEST, "InvalidArgument", format!("header {name} is not ASCII"))
            }
            Rejected::SignedStreaming => Refusal::new(
                StatusCode::NOT_IMPLEMENTED,
                "NotImplemented",
                "signed streaming payloads are not supported; use unsigned payloads",
            ),
        })?;

        let keys = self.keys();
        let amz_date = sigv4::amz_date_now();
        let mut to_sign = prepared.sign;
        to_sign.push(("host".into(), self.endpoint.host_header.clone()));
        to_sign.push(("x-amz-date".into(), amz_date.clone()));
        to_sign.push(("x-amz-content-sha256".into(), prepared.payload_hash.into()));
        if let Some(token) = &keys.session_token {
            to_sign.push(("x-amz-security-token".into(), token.clone()));
        }
        let signature = sigv4::sign(
            &keys.access_key_id,
            &keys.secret_access_key,
            &self.region,
            "s3",
            &amz_date,
            &SigningRequest {
                method: parts.method.as_str(),
                path,
                query,
                headers: &to_sign,
                payload_hash: prepared.payload_hash,
            },
        );

        let internal = |what: &str| Refusal::new(StatusCode::INTERNAL_SERVER_ERROR, "InternalError", what.to_string());
        let path_and_query = parts.uri.path_and_query().map(|p| p.as_str()).unwrap_or(path);
        let uri = Uri::builder()
            .scheme(self.endpoint.scheme.as_str())
            .authority(self.endpoint.authority.as_str())
            .path_and_query(path_and_query)
            .build()
            .map_err(|_| internal("cannot build the upstream URI"))?;
        let mut upstream = Request::new(body);
        *upstream.method_mut() = parts.method;
        *upstream.uri_mut() = uri;
        *upstream.version_mut() = Version::HTTP_11;
        let out = upstream.headers_mut();
        for (name, value) in prepared.forward {
            out.append(name, value);
        }
        // everything that was signed besides the forwarded client headers is added here
        out.insert(HOST, HeaderValue::from_str(&self.endpoint.host_header).map_err(|_| internal("bad host"))?);
        for (name, value) in to_sign.iter().filter(|(n, _)| matches!(n.as_str(), "x-amz-date" | "x-amz-content-sha256" | "x-amz-security-token")) {
            let name = HeaderName::from_bytes(name.as_bytes()).map_err(|_| internal("bad header name"))?;
            let mut value = HeaderValue::from_str(value).map_err(|_| internal("bad header value"))?;
            value.set_sensitive(name == "x-amz-security-token");
            out.insert(name, value);
        }
        let mut auth = HeaderValue::from_str(&signature.authorization).map_err(|_| internal("bad signature"))?;
        auth.set_sensitive(true);
        out.insert(AUTHORIZATION, auth);

        match self.client.request(upstream).await {
            Ok(resp) => {
                let (mut head, body) = resp.into_parts();
                headers::strip_hop_by_hop(&mut head.headers);
                head.version = Version::HTTP_11;
                head.extensions.clear();
                Ok(Response::from_parts(head, body.boxed()))
            }
            Err(e) => {
                eprintln!("upstream request failed: {}", error_chain(&e));
                Err(Refusal::new(
                    StatusCode::BAD_GATEWAY,
                    "ServiceUnavailable",
                    "the object store could not be reached",
                ))
            }
        }
    }
}
