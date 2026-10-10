//! `now()` / `current_date`: read when the expression is planned. Planning a
//! query takes far less than `SHARE_MS`, and calls within that window reuse
//! one instant, so every `now()` of a query agrees. The timestamp is UTC wall
//! clock without a time zone.

use std::sync::Mutex;
use std::time::{Duration, Instant};

use chrono::Utc;

use crate::scalar::Scalar;

const SHARE_MS: u64 = 25;

/// (when it was read, microseconds since the epoch)
static LAST: Mutex<Option<(Instant, i64)>> = Mutex::new(None);

fn now_micros() -> i64 {
    let mut last = LAST.lock().expect("clock");
    match *last {
        Some((at, v)) if at.elapsed() < Duration::from_millis(SHARE_MS) => v,
        _ => {
            let v = Utc::now().timestamp_micros();
            *last = Some((Instant::now(), v));
            v
        }
    }
}

pub fn query_time(timestamp: bool) -> Scalar {
    let micros = now_micros();
    if timestamp {
        Scalar::timestamp_us(micros, None)
    } else {
        Scalar::date32(micros.div_euclid(86_400_000_000) as i32)
    }
}
