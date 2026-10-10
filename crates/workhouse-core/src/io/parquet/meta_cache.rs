//! A process-wide cache of decoded Parquet footers of remote files. A new
//! table object over files already seen (SQL `FROM 's3://...'`, a second
//! `read_parquet()`, a workspace session starting over) then needs no
//! request for their footers.
//!
//! Entries are keyed by the object's version (store, path, size and the
//! listing's entity tag or modification time), so a replaced file is read
//! again. The cache is an LRU bounded by `WORKHOUSE_METADATA_CACHE_MB` (256;
//! 0 disables it), sized with each footer's `memory_size()`.

use std::collections::{BTreeMap, HashMap};
use std::sync::{Arc, LazyLock};

use parking_lot::Mutex;
use parquet::file::metadata::ParquetMetaData;

use crate::io::object::config;
use crate::io::object::file::VersionKey;

struct Slot {
    meta: Arc<ParquetMetaData>,
    size: usize,
    tick: u64,
}

#[derive(Default)]
struct Lru {
    map: HashMap<VersionKey, Slot>,
    /// use time -> key, oldest first
    order: BTreeMap<u64, VersionKey>,
    used: usize,
    tick: u64,
}

impl Lru {
    fn get(&mut self, key: &VersionKey) -> Option<Arc<ParquetMetaData>> {
        let slot = self.map.get_mut(key)?;
        self.order.remove(&slot.tick);
        self.tick += 1;
        slot.tick = self.tick;
        self.order.insert(self.tick, key.clone());
        Some(slot.meta.clone())
    }

    fn remove(&mut self, key: &VersionKey) {
        if let Some(old) = self.map.remove(key) {
            self.order.remove(&old.tick);
            self.used -= old.size;
        }
    }

    fn put(&mut self, key: VersionKey, meta: Arc<ParquetMetaData>, budget: usize) {
        let size = meta.memory_size() + key.path.len() + key.stamp.len() + 64;
        self.remove(&key);
        if size > budget {
            return;
        }
        self.tick += 1;
        self.order.insert(self.tick, key.clone());
        self.map.insert(key, Slot { meta, size, tick: self.tick });
        self.used += size;
        while self.used > budget {
            let Some(oldest) = self.order.values().next().cloned() else { break };
            self.remove(&oldest);
        }
    }
}

static CACHE: LazyLock<Mutex<Lru>> = LazyLock::new(Default::default);

fn budget() -> usize {
    usize::try_from(config::metadata_cache_bytes()).unwrap_or(usize::MAX)
}

pub fn get(key: &VersionKey) -> Option<Arc<ParquetMetaData>> {
    if budget() == 0 {
        return None;
    }
    CACHE.lock().get(key)
}

pub fn put(key: VersionKey, meta: Arc<ParquetMetaData>) {
    let budget = budget();
    if budget > 0 {
        CACHE.lock().put(key, meta, budget);
    }
}

pub fn clear() {
    *CACHE.lock() = Lru::default();
    super::sample_cache::clear();
}

/// Bytes the cache accounts for.
pub fn cached_bytes() -> usize {
    CACHE.lock().used
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    use arrow::array::Int64Array;
    use arrow::datatypes::{DataType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use parquet::arrow::ArrowWriter;
    use parquet::file::metadata::ParquetMetaDataReader;

    fn footer() -> Arc<ParquetMetaData> {
        let schema = Arc::new(Schema::new(vec![Field::new("a", DataType::Int64, false)]));
        let batch = RecordBatch::try_new(schema.clone(), vec![Arc::new(Int64Array::from(vec![1, 2, 3]))]).unwrap();
        let mut buf = vec![];
        let mut w = ArrowWriter::try_new(&mut buf, schema, None).unwrap();
        w.write(&batch).unwrap();
        w.close().unwrap();
        Arc::new(ParquetMetaDataReader::new().parse_and_finish(&bytes::Bytes::from(buf)).unwrap())
    }

    fn key(path: &str) -> VersionKey {
        VersionKey { store: 1, path: path.into(), size: 10, stamp: "v1".into() }
    }

    #[test]
    fn evicts_the_least_recently_used_within_the_budget() {
        let meta = footer();
        let one = meta.memory_size() + 64 + 1 + 2;
        let mut lru = Lru::default();
        let budget = one * 2 + one / 2;
        lru.put(key("a"), meta.clone(), budget);
        lru.put(key("b"), meta.clone(), budget);
        assert!(lru.get(&key("a")).is_some()); // a is now newer than b
        lru.put(key("c"), meta.clone(), budget);
        assert!(lru.get(&key("b")).is_none());
        assert!(lru.get(&key("a")).is_some() && lru.get(&key("c")).is_some());
        assert!(lru.used <= budget);
        // replacing keeps the accounting straight; a too-big entry is not kept
        lru.put(key("a"), meta.clone(), budget);
        assert_eq!(lru.map.len(), 2);
        lru.put(key("big"), meta, one - 1);
        assert!(lru.get(&key("big")).is_none());
        assert_eq!(lru.used, lru.map.values().map(|s| s.size).sum::<usize>());
    }

    #[test]
    fn versions_are_distinct_keys() {
        let meta = footer();
        let mut lru = Lru::default();
        lru.put(key("a"), meta.clone(), 1 << 20);
        let newer = VersionKey { stamp: "v2".into(), ..key("a") };
        assert!(lru.get(&newer).is_none());
        assert!(lru.get(&key("a")).is_some());
    }
}
