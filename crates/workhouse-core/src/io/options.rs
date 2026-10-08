//! Storage options: configuration of a remote store (region, endpoint,
//! credentials, ...), as `key -> value` pairs in object_store's vocabulary
//! (`region`, `endpoint`, `access_key_id`, `allow_http`, ...).

use std::collections::BTreeMap;
use std::fmt;

#[derive(Clone, Default, PartialEq, Eq, Hash)]
pub struct StorageOptions(BTreeMap<String, String>);

impl StorageOptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from_pairs<K: Into<String>, V: Into<String>>(pairs: impl IntoIterator<Item = (K, V)>) -> Self {
        Self(pairs.into_iter().map(|(k, v)| (normalize_key(&k.into()), v.into())).collect())
    }

    pub fn with(mut self, key: &str, value: impl Into<String>) -> Self {
        self.0.insert(normalize_key(key), value.into());
        self
    }

    pub fn get(&self, key: &str) -> Option<&str> {
        self.0.get(&normalize_key(key)).map(|s| s.as_str())
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0.iter().map(|(k, v)| (k.as_str(), v.as_str()))
    }

    /// These options on top of `base` (ours win).
    pub fn over(&self, base: &StorageOptions) -> StorageOptions {
        let mut m = base.0.clone();
        m.extend(self.0.iter().map(|(k, v)| (k.clone(), v.clone())));
        Self(m)
    }
}

fn normalize_key(k: &str) -> String {
    k.trim().to_ascii_lowercase()
}

/// Keys whose values must never be shown (logs, errors, plans).
pub fn is_secret(key: &str) -> bool {
    let k = key.to_ascii_lowercase();
    ["secret", "token", "password", "key_id", "access_key", "sse_customer_key"].iter().any(|s| k.contains(s))
}

impl fmt::Debug for StorageOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let mut m = f.debug_map();
        for (k, v) in &self.0 {
            if is_secret(k) {
                m.entry(k, &"****");
            } else {
                m.entry(k, v);
            }
        }
        m.finish()
    }
}

impl fmt::Display for StorageOptions {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Debug::fmt(self, f)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_are_redacted() {
        let o = StorageOptions::new().with("Region", "us-east-1").with("secret_access_key", "abc123").with("access_key_id", "AKIA");
        let shown = format!("{o:?} {o}");
        assert!(shown.contains("us-east-1"));
        assert!(!shown.contains("abc123") && !shown.contains("AKIA"));
        assert_eq!(o.get("REGION"), Some("us-east-1"));
    }

    #[test]
    fn explicit_options_win() {
        let base = StorageOptions::new().with("region", "a").with("endpoint", "e");
        let o = StorageOptions::new().with("region", "b").over(&base);
        assert_eq!((o.get("region"), o.get("endpoint")), (Some("b"), Some("e")));
    }
}
