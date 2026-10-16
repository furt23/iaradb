//! `random()` in [0, 1).
//!
//! - `random()`: a different stream on every call, not reproducible.
//! - `random(seed)`: reproducible for a plan whose batches are evaluated in
//!   order (planning restarts the sequence of the seed); parallel workers
//!   take batches in any order, so use the keyed form there.
//! - `random(seed, key)`: a pure function of `(seed, key)`: reproducible
//!   whatever the execution order. This is what `sample()` uses.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use arrow::array::*;
use arrow::datatypes::Int64Type;

use crate::error::Result;
use crate::physical::expr::ColumnarValue;

fn splitmix(mut z: u64) -> u64 {
    z = z.wrapping_add(0x9E37_79B9_7F4A_7C15);
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

fn unit(bits: u64) -> f64 {
    (bits >> 11) as f64 / (1u64 << 53) as f64
}

fn streams() -> &'static Mutex<HashMap<i64, u64>> {
    static S: OnceLock<Mutex<HashMap<i64, u64>>> = OnceLock::new();
    S.get_or_init(Default::default)
}

/// Start the sequence of `seed` over.
pub fn restart(seed: i64) {
    streams().lock().expect("random streams").insert(seed, 0);
}

fn unseeded_start(m: usize) -> u64 {
    static COUNTER: OnceLock<AtomicU64> = OnceLock::new();
    let c = COUNTER.get_or_init(|| {
        let t = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos() as u64);
        AtomicU64::new(splitmix(t))
    });
    c.fetch_add(m as u64, Ordering::Relaxed)
}

fn seed_i64(v: &ColumnarValue) -> Option<i64> {
    match v {
        ColumnarValue::Scalar(s) => s.as_i64(),
        _ => None,
    }
}

pub fn random(args: &[ColumnarValue], m: usize) -> Result<ArrayRef> {
    let out: Float64Array = match args {
        [] => {
            let start = unseeded_start(m);
            (0..m as u64).map(|i| Some(unit(splitmix(start.wrapping_add(i))))).collect()
        }
        [seed] => {
            let seed = seed_i64(seed).unwrap_or(0);
            let start = {
                let mut s = streams().lock().expect("random streams");
                let at = s.entry(seed).or_insert(0);
                let start = *at;
                *at += m as u64;
                start
            };
            let base = splitmix(seed as u64);
            (0..m as u64).map(|i| Some(unit(splitmix(base.wrapping_add(start + i))))).collect()
        }
        [seed, key] => {
            let base = splitmix(seed_i64(seed).unwrap_or(0) as u64);
            let key = key.clone().into_array(m)?;
            let key = key.as_primitive::<Int64Type>();
            key.iter().map(|k| k.map(|k| unit(splitmix(base ^ splitmix(k as u64))))).collect()
        }
        _ => unreachable!("arity is checked at plan time"),
    };
    Ok(Arc::new(out))
}
