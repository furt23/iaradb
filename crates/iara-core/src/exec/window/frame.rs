//! Frame bounds: the sorted positions `[start, end)` each row aggregates
//! over, for ROWS, GROUPS and RANGE frames.

use std::ops::Range;

use arrow::array::{Array, ArrayRef, AsArray};
use arrow::compute::cast;
use arrow::datatypes::*;

use crate::error::{Result, WhError};
use crate::exec::window::layout::Layout;
use crate::expr::{FrameBound, FrameUnits, WindowFrame};
use crate::scalar::Scalar;

/// Order key values on a numeric scale where RANGE offsets can be added.
enum Keys {
    Int(Vec<i128>),
    Float(Vec<f64>),
}

#[derive(Clone, Copy)]
enum Offset {
    Int(i128),
    Float(f64),
}

/// The order key of a RANGE frame with offsets, prepared for searching.
pub struct RangeKeys {
    keys: Keys,
    nulls: Option<arrow::buffer::NullBuffer>,
    descending: bool,
    nulls_first: bool,
    start: Option<Offset>,
    end: Option<Offset>,
}

fn interval_parts(s: &Scalar) -> Option<(i32, i32, i64)> {
    match s.data_type() {
        DataType::Interval(IntervalUnit::MonthDayNano) => {
            let v = s.array().as_primitive::<IntervalMonthDayNanoType>().value(0);
            Some((v.months, v.days, v.nanoseconds))
        }
        _ => None,
    }
}

/// An offset in the units of the key: integers (days for dates), intervals
/// for dates / timestamps, scaled integers for decimals.
fn offset_for(s: &Scalar, key_type: &DataType) -> Result<Offset> {
    let unsupported = || WhError::NotSupported(format!("RANGE offset {s} for an ORDER BY key of type {key_type}"));
    let fixed = |per_day: i128, per_ns: f64| -> Result<i128> {
        let (months, days, nanos) = interval_parts(s).ok_or_else(unsupported)?;
        if months != 0 {
            return Err(WhError::NotSupported("RANGE offsets in months (use days)".into()));
        }
        Ok(days as i128 * per_day + (nanos as f64 * per_ns) as i128)
    };
    Ok(match key_type {
        DataType::Float16 | DataType::Float32 | DataType::Float64 => {
            Offset::Float(s.cast_to(&DataType::Float64)?.as_f64().ok_or_else(unsupported)?)
        }
        DataType::Decimal128(_, scale) => {
            let d = s.cast_to(&DataType::Decimal128(38, *scale))?;
            Offset::Int(d.array().as_primitive::<Decimal128Type>().value(0))
        }
        DataType::Date32 if interval_parts(s).is_some() => Offset::Int(fixed(1, 1.0 / 86_400e9)?),
        DataType::Date64 if interval_parts(s).is_some() => Offset::Int(fixed(86_400_000, 1e-6)?),
        DataType::Timestamp(unit, _) => {
            let per_sec: i128 = match unit {
                TimeUnit::Second => 1,
                TimeUnit::Millisecond => 1_000,
                TimeUnit::Microsecond => 1_000_000,
                TimeUnit::Nanosecond => 1_000_000_000,
            };
            Offset::Int(fixed(86_400 * per_sec, per_sec as f64 / 1e9)?)
        }
        t if t.is_integer() || matches!(t, DataType::Date32 | DataType::Date64) => {
            if !s.data_type().is_integer() {
                return Err(unsupported());
            }
            Offset::Int(s.as_i64().ok_or_else(unsupported)? as i128)
        }
        _ => return Err(unsupported()),
    })
}

fn key_values(a: &ArrayRef) -> Result<Keys> {
    let dt = a.data_type();
    Ok(match dt {
        DataType::Float16 | DataType::Float32 | DataType::Float64 => {
            let f = cast(a, &DataType::Float64)?;
            Keys::Float(f.as_primitive::<Float64Type>().values().to_vec())
        }
        DataType::Decimal128(_, _) => Keys::Int(a.as_primitive::<Decimal128Type>().values().to_vec()),
        DataType::UInt64 => Keys::Int(a.as_primitive::<UInt64Type>().values().iter().map(|&v| v as i128).collect()),
        t if t.is_integer() || t.is_temporal() => {
            let i = cast(a, &DataType::Int64)?;
            Keys::Int(i.as_primitive::<Int64Type>().values().iter().map(|&v| v as i128).collect())
        }
        t => return Err(WhError::NotSupported(format!("RANGE frames with offsets over an ORDER BY key of type {t}"))),
    })
}

impl RangeKeys {
    pub fn new(layout: &Layout, frame: &WindowFrame) -> Result<Option<Self>> {
        let offset = |b: &FrameBound| match b {
            FrameBound::Preceding(s) | FrameBound::Following(s) => Some(s.clone()),
            _ => None,
        };
        let (so, eo) = (offset(&frame.start), offset(&frame.end));
        if frame.units != FrameUnits::Range || (so.is_none() && eo.is_none()) {
            return Ok(None);
        }
        let (key, opts) = layout.order_key.as_ref().ok_or_else(|| {
            WhError::Plan("RANGE with an offset requires exactly one ORDER BY expression".into())
        })?;
        let dt = key.data_type();
        Ok(Some(Self {
            keys: key_values(key)?,
            nulls: key.logical_nulls(),
            descending: opts.descending,
            nulls_first: opts.nulls_first,
            start: so.map(|s| offset_for(&s, dt)).transpose()?,
            end: eo.map(|s| offset_for(&s, dt)).transpose()?,
        }))
    }

    fn is_null(&self, i: usize) -> bool {
        self.nulls.as_ref().is_some_and(|n| n.is_null(i))
    }

    /// The positions of the partition whose key is not null.
    fn non_null(&self, part: &Range<usize>) -> Range<usize> {
        let Some(n) = &self.nulls else { return part.clone() };
        // the nulls sit together at one end of the partition
        if self.nulls_first {
            first_where(part.clone(), |i| n.is_valid(i))..part.end
        } else {
            part.start..first_where(part.clone(), |i| n.is_null(i))
        }
    }

    /// First position in `seg` whose key lies beyond `v + delta` in the
    /// sort direction (`inclusive`: at or beyond).
    fn search(&self, seg: &Range<usize>, i: usize, delta: Offset, sign: i8, inclusive: bool) -> usize {
        // in ascending order "beyond" is larger; descending flips the direction
        let dir = if self.descending { -1 } else { 1 };
        let s = sign * dir;
        macro_rules! find {
            ($v:expr, $d:expr) => {{
                let v = $v[i];
                let target = if s > 0 { v + $d } else { v - $d };
                let slice = &$v[seg.clone()];
                let before = |k: &_| {
                    let k = *k;
                    match (self.descending, inclusive) {
                        (false, true) => k < target,
                        (false, false) => k <= target,
                        (true, true) => k > target,
                        (true, false) => k >= target,
                    }
                };
                seg.start + slice.partition_point(before)
            }};
        }
        match (&self.keys, delta) {
            (Keys::Int(v), Offset::Int(d)) => find!(v, d),
            (Keys::Float(v), Offset::Float(d)) => find!(v, d),
            (Keys::Int(v), Offset::Float(d)) => find!(v, d as i128),
            (Keys::Float(v), Offset::Int(d)) => find!(v, d as f64),
        }
    }
}

/// Frame bounds of the rows of one partition.
pub struct Frames<'a> {
    layout: &'a Layout,
    frame: &'a WindowFrame,
    part: Range<usize>,
    /// GROUPS: start positions of the partition's peer groups
    groups: Vec<usize>,
    /// RANGE with offsets: the partition's non-null key positions
    range: Option<(&'a RangeKeys, Range<usize>)>,
    /// ROWS / GROUPS offsets of the start and end bounds (0 when unused)
    offsets: (usize, usize),
}

fn rows_offset(b: &FrameBound) -> usize {
    match b {
        FrameBound::Preceding(s) | FrameBound::Following(s) => s.as_i64().unwrap_or(0).max(0) as usize,
        _ => 0,
    }
}

impl<'a> Frames<'a> {
    pub fn new(layout: &'a Layout, frame: &'a WindowFrame, keys: Option<&'a RangeKeys>, part: Range<usize>) -> Self {
        let groups = if frame.units == FrameUnits::Groups {
            part.clone().filter(|&i| layout.peer_start[i] as usize == i).collect()
        } else {
            vec![]
        };
        let range = keys.map(|k| (k, k.non_null(&part)));
        let offsets = (rows_offset(&frame.start), rows_offset(&frame.end));
        Self { layout, frame, part, groups, range, offsets }
    }

    /// `[start, end)` for the row at sorted position `i` (may be empty).
    pub fn bounds(&self, i: usize) -> (usize, usize) {
        (self.bound(&self.frame.start, i, false), self.bound(&self.frame.end, i, true))
    }

    fn bound(&self, b: &FrameBound, i: usize, is_end: bool) -> usize {
        let (ps, pe) = (self.part.start, self.part.end);
        match b {
            FrameBound::UnboundedPreceding => return ps,
            FrameBound::UnboundedFollowing => return pe,
            _ => {}
        }
        let k = if is_end { self.offsets.1 } else { self.offsets.0 };
        match self.frame.units {
            FrameUnits::Rows => match (b, is_end) {
                (FrameBound::CurrentRow, false) => i,
                (FrameBound::CurrentRow, true) => i + 1,
                (FrameBound::Preceding(_), false) => i.saturating_sub(k).max(ps),
                (FrameBound::Preceding(_), true) => (i + 1).saturating_sub(k).max(ps),
                (FrameBound::Following(_), false) => i.saturating_add(k).min(pe),
                (FrameBound::Following(_), true) => (i + 1).saturating_add(k).min(pe),
                _ => unreachable!(),
            },
            FrameUnits::Groups => {
                let g = self.groups.partition_point(|&s| s <= i) - 1;
                let m = self.groups.len();
                let gend = |k: usize| if k + 1 < m { self.groups[k + 1] } else { pe };
                match (b, is_end) {
                    (FrameBound::CurrentRow, false) => self.groups[g],
                    (FrameBound::CurrentRow, true) => gend(g),
                    (FrameBound::Preceding(_), false) => self.groups[g.saturating_sub(k)],
                    (FrameBound::Preceding(_), true) => match g.checked_sub(k) {
                        Some(j) => gend(j),
                        None => ps,
                    },
                    (FrameBound::Following(_), false) => self.groups.get(g.saturating_add(k)).copied().unwrap_or(pe),
                    (FrameBound::Following(_), true) => gend(g.saturating_add(k).min(m - 1)),
                    _ => unreachable!(),
                }
            }
            FrameUnits::Range => {
                let peers = (self.layout.peer_start[i] as usize, self.layout.peer_end[i] as usize);
                let (keys, seg) = match (&self.range, b) {
                    (Some((k, seg)), FrameBound::Preceding(_) | FrameBound::Following(_)) if !k.is_null(i) => (*k, seg),
                    // CURRENT ROW, or a NULL key: the row's peers
                    _ => return if is_end { peers.1 } else { peers.0 },
                };
                let (delta, sign) = match b {
                    FrameBound::Preceding(_) => (if is_end { keys.end } else { keys.start }, -1),
                    _ => (if is_end { keys.end } else { keys.start }, 1),
                };
                let delta = delta.expect("offset of an offset bound");
                // start: first key at or beyond the bound; end: first key past it
                keys.search(seg, i, delta, sign, !is_end)
            }
        }
    }
}

/// First position of `r` where `pred` holds, `pred` being false then true.
fn first_where(r: Range<usize>, pred: impl Fn(usize) -> bool) -> usize {
    let (mut lo, mut hi) = (r.start, r.end);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        if pred(mid) {
            hi = mid;
        } else {
            lo = mid + 1;
        }
    }
    lo
}
