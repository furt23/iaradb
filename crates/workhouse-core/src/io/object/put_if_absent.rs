//! Creating an object only if it does not exist yet: the commit primitive of
//! a transaction log. Stores that support conditional writes (S3, memory,
//! local files) do it atomically with `PutMode::Create`; for the others the
//! storage option `single_writer=true` falls back to a check followed by a
//! plain write, which is safe only while this is the one process writing.

use bytes::Bytes;
use object_store::{ObjectStoreExt, PutMode};

use super::error::storage_err;
use super::list_cache;
use super::registry;
use super::runtime::block_on;
use crate::error::{Result, WhError};
use crate::io::location::ObjectUrl;
use crate::io::options::StorageOptions;

/// The storage option that allows the non-atomic fallback.
pub const SINGLE_WRITER: &str = "single_writer";

/// Options the engine itself reads; they are not passed on to the store.
pub fn is_engine_option(key: &str) -> bool {
    key.eq_ignore_ascii_case(SINGLE_WRITER)
}

fn single_writer(url: &ObjectUrl, options: &StorageOptions) -> bool {
    let all = options.over(&registry::storage_options_for(&url.to_string()));
    all.get(SINGLE_WRITER).is_some_and(|v| matches!(v.trim().to_ascii_lowercase().as_str(), "true" | "1" | "yes"))
}

/// Write `bytes` to `url` unless an object exists there: `Ok(false)` when one does.
pub fn put_if_absent(url: &ObjectUrl, bytes: Bytes, options: &StorageOptions) -> Result<bool> {
    let store = registry::store(url, options)?;
    let path = super::object_path(&url.key);
    let what = url.to_string();
    let created = block_on(async {
        if single_writer(url, options) {
            return match store.head(&path).await {
                Ok(_) => Ok(false),
                Err(object_store::Error::NotFound { .. }) => store.put(&path, bytes.into()).await.map(|_| true).map_err(|e| storage_err(e, &what)),
                Err(e) => Err(storage_err(e, &what)),
            };
        }
        match store.put_opts(&path, bytes.into(), PutMode::Create.into()).await {
            Ok(_) => Ok(true),
            Err(object_store::Error::AlreadyExists { .. } | object_store::Error::Precondition { .. }) => Ok(false),
            Err(object_store::Error::NotImplemented { .. }) => Err(WhError::Storage(format!(
                "{what}: this store does not support conditional writes, which commits need; if this process is the only writer, set the storage option single_writer=true"
            ))),
            Err(e) => Err(storage_err(e, &what)),
        }
    })?;
    if created {
        list_cache::invalidate(&url.root(), &url.key);
    }
    Ok(created)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;
    use crate::io::location::Location;

    fn url(s: &str) -> ObjectUrl {
        let Location::Object(u) = Location::parse(s).unwrap() else { panic!() };
        u
    }

    #[test]
    fn the_second_create_loses() {
        let u = url("memory://put-if-absent-basic/t/_delta_log/0.json");
        let o = StorageOptions::new();
        assert!(put_if_absent(&u, Bytes::from_static(b"first"), &o).unwrap());
        assert!(!put_if_absent(&u, Bytes::from_static(b"second"), &o).unwrap());
        let got = block_on(async { registry::store(&u, &o).unwrap().get(&super::super::object_path(&u.key)).await.unwrap().bytes().await.unwrap() });
        assert_eq!(&got[..], b"first");
    }

    #[test]
    fn racing_writers_have_one_winner() {
        let u = url("memory://put-if-absent-race/t/_delta_log/1.json");
        let wins = AtomicUsize::new(0);
        std::thread::scope(|s| {
            for i in 0..8 {
                let (u, wins) = (&u, &wins);
                s.spawn(move || {
                    if put_if_absent(u, Bytes::from(format!("writer {i}")), &StorageOptions::new()).unwrap() {
                        wins.fetch_add(1, Ordering::SeqCst);
                    }
                });
            }
        });
        assert_eq!(wins.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn single_writer_mode_checks_then_writes() {
        let u = url("memory://put-if-absent-single/t/_delta_log/2.json");
        let o = StorageOptions::new().with("single_writer", "true");
        assert!(put_if_absent(&u, Bytes::from_static(b"a"), &o).unwrap());
        assert!(!put_if_absent(&u, Bytes::from_static(b"b"), &o).unwrap());
        assert!(is_engine_option("Single_Writer"));
    }
}
