//! Interning keys of many columns, one thread: what each step of `GroupKeys` costs.
//!
//! ```text
//! cargo run --release -p iara-core --example group_keys -- [rows] [distinct values per key, comma separated]
//! ```

use std::sync::Arc;
use std::time::Instant;

use arrow::array::{ArrayRef, Int64Array, StringArray};
use arrow::datatypes::DataType;
use iara_core::exec::groupby::GroupKeys;

struct Rng(u64);

impl Rng {
    fn next(&mut self, below: u64) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 33) % below
    }
}

fn main() {
    let rows: usize = std::env::args().nth(1).and_then(|v| v.parse().ok()).unwrap_or(100_000);
    let cards: Vec<u64> = std::env::args().nth(2).unwrap_or_else(|| "3,4,5,2,7,3,6,2,4,5,3,2".into()).split(',').filter_map(|c| c.parse().ok()).collect();
    let mut rng = Rng(7);
    let columns: Vec<ArrayRef> = cards
        .iter()
        .enumerate()
        .map(|(i, &card)| {
            let values: Vec<u64> = (0..rows).map(|_| rng.next(card)).collect();
            if i % 2 == 0 {
                Arc::new(StringArray::from_iter_values(values.iter().map(|v| format!("key{i}_{v}")))) as ArrayRef
            } else {
                Arc::new(Int64Array::from_iter_values(values.iter().map(|&v| v as i64))) as ArrayRef
            }
        })
        .collect();
    let types: Vec<DataType> = columns.iter().map(|c| c.data_type().clone()).collect();
    let batches: Vec<Vec<ArrayRef>> = (0..rows).step_by(8192).map(|s| columns.iter().map(|c| c.slice(s, 8192.min(rows - s))).collect()).collect();
    let time = |what: &str, f: &mut dyn FnMut() -> usize| {
        let mut best = f64::MAX;
        let mut out = 0;
        for _ in 0..20 {
            let started = Instant::now();
            out = f();
            best = best.min(started.elapsed().as_secs_f64() * 1000.0);
        }
        println!("{what:<28} {best:8.3} ms  ({out})");
    };
    let intern = || {
        let mut keys = GroupKeys::try_new(&types).expect("keys");
        let mut ids = vec![];
        for b in &batches {
            keys.intern(b, &mut ids).expect("interned");
        }
        keys
    };
    time("intern", &mut || intern().len());
    if std::env::var("ONLY_INTERN").is_ok() {
        return;
    }
    let table = intern();
    time("emit", &mut || table.emit().expect("emitted").len());
    time("intern_from (into empty)", &mut || {
        let mut other = GroupKeys::try_new(&types).expect("keys");
        let mut ids = vec![];
        other.intern_from(&table, None, &mut ids).expect("merged");
        other.len()
    });
    time("intern emitted (old merge)", &mut || {
        let keys = table.emit().expect("emitted");
        let mut other = GroupKeys::try_new(&types).expect("keys");
        let mut ids = vec![];
        other.intern(&keys, &mut ids).expect("merged");
        other.len()
    });
    let mut hashes = vec![];
    time("hash_columns", &mut || {
        for b in &batches {
            iara_core::hash::hash_columns(b, &mut hashes).expect("hashed");
        }
        hashes.len()
    });
}
