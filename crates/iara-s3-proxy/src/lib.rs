//! `iara-s3-proxy`: a loopback S3 proxy. Notebook code talks plain HTTP with dummy credentials;
//! the proxy re-signs each request with the team's real keys and streams it to the object store.
//! The keys live in a file only the proxy's OS user can read.

pub mod config;
pub mod encoding;
pub mod headers;
pub mod proxy;
pub mod server;
pub mod sigv4;
