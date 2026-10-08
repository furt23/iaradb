//! Where a table's files live: a local path or an object store URL
//! (`s3://bucket/key`, `memory://name/key`).

use std::path::PathBuf;

use crate::error::{Result, WhError};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Location {
    Local(PathBuf),
    Object(ObjectUrl),
}

/// `scheme://bucket/key`; the key has no leading slash and may hold globs.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ObjectUrl {
    pub scheme: String,
    pub bucket: String,
    pub key: String,
}

pub const SCHEMES: &[&str] = &["s3", "s3a", "memory"];

/// The scheme of `s` when it looks like a URL (`xx://...`; a Windows drive
/// letter such as `C:\` is not one).
pub fn url_scheme(s: &str) -> Option<&str> {
    let (scheme, _) = s.split_once("://")?;
    (scheme.len() >= 2 && scheme.chars().all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '-')).then_some(scheme)
}

pub fn is_remote(s: &str) -> bool {
    url_scheme(s).is_some()
}

impl Location {
    pub fn parse(s: &str) -> Result<Location> {
        let Some(scheme) = url_scheme(s) else {
            return Ok(Location::Local(PathBuf::from(s)));
        };
        let scheme = scheme.to_ascii_lowercase();
        if !SCHEMES.contains(&scheme.as_str()) {
            return Err(WhError::Storage(format!("unsupported storage scheme '{scheme}://' (supported: s3://, memory://)")));
        }
        let rest = &s[scheme.len() + 3..];
        let (bucket, key) = rest.split_once('/').unwrap_or((rest, ""));
        if bucket.is_empty() {
            return Err(WhError::Storage(format!("missing bucket in '{s}'")));
        }
        let scheme = if scheme == "s3a" { "s3".to_string() } else { scheme };
        Ok(Location::Object(ObjectUrl { scheme, bucket: bucket.to_string(), key: key.trim_start_matches('/').to_string() }))
    }
}

impl ObjectUrl {
    /// `scheme://bucket`
    pub fn root(&self) -> String {
        format!("{}://{}", self.scheme, self.bucket)
    }

    pub fn with_key(&self, key: &str) -> ObjectUrl {
        ObjectUrl { key: key.to_string(), ..self.clone() }
    }

    pub fn has_glob(&self) -> bool {
        has_glob(&self.key)
    }
}

impl std::fmt::Display for ObjectUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}://{}/{}", self.scheme, self.bucket, self.key)
    }
}

pub fn has_glob(s: &str) -> bool {
    s.contains(['*', '?', '['])
}

/// A short table name for a path or URL: its last segment that is not a
/// glob, without extension (`s3://b/lineitem/*.parquet` -> `lineitem`).
pub fn stem(s: &str) -> String {
    let body = s.split_once("://").map_or(s, |(_, r)| r);
    let seg = body
        .split(['/', '\\'])
        .filter(|p| !p.is_empty() && !has_glob(p))
        .next_back()
        .unwrap_or(body);
    match seg.rsplit_once('.') {
        Some((stem, _)) if !stem.is_empty() => stem.to_string(),
        _ => seg.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_urls_and_paths() {
        assert_eq!(Location::parse(r"C:\data\x.parquet").unwrap(), Location::Local(PathBuf::from(r"C:\data\x.parquet")));
        assert_eq!(Location::parse("data/x").unwrap(), Location::Local(PathBuf::from("data/x")));
        let Location::Object(u) = Location::parse("s3a://bkt/a/b/*.parquet").unwrap() else { panic!() };
        assert_eq!((u.scheme.as_str(), u.bucket.as_str(), u.key.as_str()), ("s3", "bkt", "a/b/*.parquet"));
        assert!(u.has_glob());
        let Location::Object(u) = Location::parse("s3://bkt").unwrap() else { panic!() };
        assert_eq!(u.key, "");
        assert!(Location::parse("gs://x/y").is_err());
        assert!(Location::parse("s3:///y").is_err());
    }

    #[test]
    fn stems() {
        assert_eq!(stem("s3://b/tpch/lineitem/*.parquet"), "lineitem");
        assert_eq!(stem("data/orders.parquet"), "orders");
        assert_eq!(stem("s3://b/x.csv"), "x");
        assert_eq!(stem(r"C:\d\t\**\*.parquet"), "t");
    }
}
