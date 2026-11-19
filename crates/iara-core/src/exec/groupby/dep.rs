//! Representative values of the dependent key columns: one record per
//! group, all dependent columns side by side (8 bytes for values up to that
//! wide, 16 for wider ones and strings), so a row is checked against its
//! group with about one cache miss.
//!
//! Strings are kept as views: up to 12 bytes inline, longer ones as length,
//! prefix and an offset into an arena. View arrays whose rows repeat values
//! by pointing at the same bytes (a join gathering a dimension's columns,
//! dictionary-decoded pages) are checked without reading the strings: a
//! field keeps the data buffers of the first such array alive and stores
//! that array's views as they are, so a row with the same buffers and the
//! same view holds the same bytes.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::*;
use arrow::buffer::{Buffer, MutableBuffer, NullBuffer};
use arrow::datatypes::*;

use super::bytes_array;
use super::table::{LARGE_BYTES, PREFETCH_AHEAD, prefetch};
use crate::error::Result;

#[repr(C, align(64))]
#[derive(Clone, Copy, Default)]
struct Line([u64; 8]);

#[derive(Clone, Copy)]
enum Kind {
    Fixed(usize),
    Bool,
    Bytes,
}

struct Field {
    dt: DataType,
    kind: Kind,
    /// first word of the field in a record, and its words (1 or 2)
    at: usize,
    words: usize,
    /// null flags by group; `None` while no group's value is null
    nulls: Option<Vec<bool>>,
    /// view arrays: the data buffers that `SOURCE`-tagged slots point into
    source: Option<Arc<[Buffer]>>,
    /// `source` positions by buffer address
    index: HashMap<(usize, usize), u32, foldhash::fast::FixedState>,
    /// the last buffer list seen and where each of its buffers is in `source`
    last: Option<(Arc<[Buffer]>, Vec<u32>)>,
}

/// The same buffers in the same order (`take` and `slice` of a view array
/// share its buffers under a new list).
fn same_buffers(a: &Arc<[Buffer]>, b: &Arc<[Buffer]>) -> bool {
    Arc::ptr_eq(a, b) || (a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| x.as_ptr() == y.as_ptr() && x.len() == y.len()))
}

/// A buffer of the last list not looked up in the source yet.
const UNKNOWN: u32 = u32::MAX - 1;

impl Field {
    /// For the rows of an array with data buffers `bufs`: where each buffer
    /// is in the pinned source, looked up on first use ([`UNKNOWN`] until
    /// then, `u32::MAX`: not there; a chunk of rows points into few of many
    /// buffers). The first buffers seen become the source; it stays alive,
    /// so a buffer at the same address holds the same bytes.
    fn source_map(&mut self, bufs: &Arc<[Buffer]>) -> Vec<u32> {
        if self.source.is_none() && !bufs.is_empty() {
            self.source = Some(bufs.clone());
            for (j, b) in bufs.iter().enumerate() {
                self.index.entry((b.as_ptr() as usize, b.len())).or_insert(j as u32);
            }
        }
        match self.last.take() {
            Some((l, m)) if same_buffers(&l, bufs) => m,
            _ => vec![UNKNOWN; bufs.len()],
        }
    }

    /// Where buffer `b` is in the source.
    fn locate(&self, b: &Buffer) -> u32 {
        self.index.get(&(b.as_ptr() as usize, b.len())).copied().unwrap_or(u32::MAX)
    }
}

pub(super) struct DepRecords {
    fields: Vec<Field>,
    /// words per record: a power of two up to a cache line, then whole lines
    width: usize,
    lines: Vec<Line>,
    arena: Vec<u8>,
    /// groups with room for a record
    groups: usize,
}

/// A long string's slot that is a view into the field's `source` buffers
/// (set in the buffer index, which never gets that large).
const SOURCE: u128 = 1 << 95;
const LOW: u128 = u64::MAX as u128;
/// The buffer index of a view (above its low 64 bits).
const BUF: u128 = u32::MAX as u128;

fn kind(dt: &DataType) -> Option<Kind> {
    Some(match dt {
        DataType::Boolean => Kind::Bool,
        DataType::Utf8
        | DataType::LargeUtf8
        | DataType::Utf8View
        | DataType::Binary
        | DataType::LargeBinary
        | DataType::BinaryView => Kind::Bytes,
        dt if dt.is_primitive() => match dt.primitive_width()? {
            w @ 1..=16 => Kind::Fixed(w),
            _ => return None,
        },
        _ => return None,
    })
}

/// A string's slot: `len | 12 inline bytes`, or for longer ones the first
/// 8 bytes of that (`len | prefix`) and the arena offset or source view above.
#[inline(always)]
fn head(b: &[u8]) -> u128 {
    let mut x = [0u8; 16];
    x[0..4].copy_from_slice(&(b.len() as u32).to_le_bytes());
    let n = b.len().min(12);
    x[4..4 + n].copy_from_slice(&b[..n]);
    u128::from_le_bytes(x)
}

#[inline(always)]
fn load<const W: usize>(src: &[u8], i: usize) -> u128 {
    let mut x = [0u8; 16];
    x[..W].copy_from_slice(&src[i * W..(i + 1) * W]);
    u128::from_le_bytes(x)
}

/// The bytes of a `SOURCE` slot.
#[inline(always)]
fn source_bytes(source: &[Buffer], slot: u128) -> &[u8] {
    let len = slot as u32 as usize;
    let buf = ((slot >> 64) as u32 & !(1 << 31)) as usize;
    let off = (slot >> 96) as u32 as usize;
    &source[buf].as_slice()[off..off + len]
}

impl DepRecords {
    pub fn supports(dt: &DataType) -> bool {
        kind(dt).is_some()
    }

    pub fn new(types: &[DataType]) -> Self {
        let mut at = 0;
        let fields: Vec<Field> = types
            .iter()
            .map(|dt| {
                let kind = kind(dt).expect("supported");
                let words = match kind {
                    Kind::Fixed(w) if w <= 8 => 1,
                    Kind::Bool => 1,
                    _ => 2,
                };
                at += words;
                Field { dt: dt.clone(), kind, at: at - words, words, nulls: None, source: None, index: HashMap::default(), last: None }
            })
            .collect();
        let width = if at <= 8 { at.max(1).next_power_of_two() } else { at.div_ceil(8) * 8 };
        Self { fields, width, lines: vec![], arena: vec![], groups: 0 }
    }

    /// Room for the records of groups `0..n`.
    pub fn grow_to(&mut self, n: usize) {
        if n <= self.groups {
            return;
        }
        self.lines.resize((n * self.width).div_ceil(8), Line::default());
        for f in &mut self.fields {
            if let Some(nulls) = &mut f.nulls {
                nulls.resize(n, false);
            }
        }
        self.groups = n;
    }

    pub fn reserve(&mut self, n: usize) {
        self.lines.reserve((n * self.width).div_ceil(8));
    }

    #[inline(always)]
    fn word(&self, g: usize, f: usize) -> *const u64 {
        (self.lines.as_ptr() as *const u64).wrapping_add(g * self.width + self.fields[f].at)
    }

    /// Field `f` of group `g`'s record.
    #[inline(always)]
    fn get(&self, g: usize, f: usize) -> u128 {
        debug_assert!(g < self.groups);
        // SAFETY: records of groups below `groups` are allocated
        unsafe {
            if self.fields[f].words == 1 {
                *self.word(g, f) as u128
            } else {
                std::ptr::read_unaligned(self.word(g, f) as *const u128)
            }
        }
    }

    #[inline(always)]
    fn set(&mut self, g: usize, f: usize, v: u128) {
        debug_assert!(g < self.groups);
        let p = self.word(g, f) as *mut u64;
        // SAFETY: as above
        unsafe {
            if self.fields[f].words == 1 {
                *p = v as u64;
            } else {
                std::ptr::write_unaligned(p as *mut u128, v);
            }
        }
    }

    #[inline(always)]
    fn prefetch_slot(&self, g: u32, f: usize) {
        prefetch(self.word(g as usize, f));
    }

    /// Check every row of field `f` against its group's record. `gids` are
    /// dense ids in first-occurrence order and groups from `before` on are
    /// new in this batch: the first row of each writes its record. False on
    /// the first disagreement, and on an id past the next new one (the
    /// caller then keys on the column instead).
    pub fn check(&mut self, f: usize, array: &ArrayRef, gids: &[u32], before: usize) -> bool {
        if gids.iter().any(|&g| g as usize >= self.groups) {
            return false;
        }
        let kind = self.fields[f].kind;
        // records a few rows ahead are prefetched once they outgrow the cache
        let far = if self.lines.len() * 64 > LARGE_BYTES { PREFETCH_AHEAD } else { usize::MAX / 2 };
        let nulls = array.nulls().filter(|n| n.null_count() > 0).cloned();
        let mut next = before;
        // null rows, and rows of groups whose value is null, are settled here
        macro_rules! nulls_step {
            ($i:expr, $g:expr) => {{
                let row_null = nulls.as_ref().is_some_and(|n| n.is_null($i));
                if $g == next {
                    if row_null {
                        let groups = self.groups;
                        self.fields[f].nulls.get_or_insert_with(|| vec![false; groups])[$g] = true;
                        next += 1;
                        continue;
                    }
                } else if $g > next {
                    return false;
                } else {
                    let rec_null = self.fields[f].nulls.as_ref().is_some_and(|n| n[$g]);
                    if row_null || rec_null {
                        if row_null != rec_null {
                            return false;
                        }
                        continue;
                    }
                }
            }};
        }
        // write the value of a new group, or compare an existing group's
        macro_rules! settle {
            ($g:expr, $v:expr) => {{
                if $g == next {
                    self.set($g, f, $v);
                    next += 1;
                } else if self.get($g, f) != $v {
                    return false;
                }
            }};
        }
        match kind {
            Kind::Fixed(w) => {
                let data = array.to_data();
                let src = &data.buffers()[0].as_slice()[data.offset() * w..];
                macro_rules! fixed {
                    ($w:literal) => {{
                        for (i, &g) in gids.iter().enumerate() {
                            if let Some(&a) = gids.get(i + far) {
                                self.prefetch_slot(a, f);
                            }
                            let g = g as usize;
                            nulls_step!(i, g);
                            settle!(g, load::<$w>(src, i));
                        }
                    }};
                }
                match w {
                    1 => fixed!(1),
                    2 => fixed!(2),
                    4 => fixed!(4),
                    8 => fixed!(8),
                    16 => fixed!(16),
                    w => {
                        for (i, &g) in gids.iter().enumerate() {
                            let g = g as usize;
                            nulls_step!(i, g);
                            let mut x = [0u8; 16];
                            x[..w].copy_from_slice(&src[i * w..(i + 1) * w]);
                            settle!(g, u128::from_le_bytes(x));
                        }
                    }
                }
                true
            }
            Kind::Bool => {
                let a = array.as_boolean();
                for (i, &g) in gids.iter().enumerate() {
                    let g = g as usize;
                    nulls_step!(i, g);
                    settle!(g, a.value(i) as u128);
                }
                true
            }
            Kind::Bytes => {
                macro_rules! views {
                    ($a:expr) => {{
                        let a = $a;
                        let views = a.views();
                        let bufs = a.data_buffers();
                        let mut map = self.fields[f].source_map(bufs);
                        for (i, &g) in gids.iter().enumerate() {
                            if let Some(&a) = gids.get(i + far) {
                                self.prefetch_slot(a, f);
                            }
                            let g = g as usize;
                            nulls_step!(i, g);
                            let view = views[i];
                            if view as u32 <= 12 {
                                settle!(g, view);
                                continue;
                            }
                            // the view into the source, when its buffer is there
                            let bi = (view >> 64) as u32 as usize;
                            let j = match map.get(bi).copied() {
                                Some(UNKNOWN) => {
                                    let j = self.fields[f].locate(&bufs[bi]);
                                    map[bi] = j;
                                    j
                                }
                                j => j.unwrap_or(u32::MAX),
                            };
                            let canon = (j != u32::MAX).then(|| (view & !(BUF << 64)) | ((j as u128) << 64) | SOURCE);
                            if g == next {
                                let slot = match canon {
                                    Some(c) => c,
                                    None => {
                                        let off = self.arena.len() as u128;
                                        self.arena.extend_from_slice(a.value(i).as_ref());
                                        (view & LOW) | (off << 64)
                                    }
                                };
                                self.set(g, f, slot);
                                next += 1;
                                continue;
                            }
                            let slot = self.get(g, f);
                            if Some(slot) == canon {
                                continue;
                            }
                            if slot & LOW != view & LOW {
                                return false;
                            }
                            let b: &[u8] = a.value(i).as_ref();
                            let held = if slot & SOURCE != 0 {
                                source_bytes(self.fields[f].source.as_ref().expect("source"), slot)
                            } else {
                                let off = (slot >> 64) as usize;
                                &self.arena[off..off + b.len()]
                            };
                            if held != b {
                                return false;
                            }
                        }
                        self.fields[f].last = Some((bufs.clone(), map));
                        true
                    }};
                }
                macro_rules! offsets {
                    ($a:expr, $f:expr) => {{
                        let a = $a;
                        for (i, &g) in gids.iter().enumerate() {
                            // the record and the row's bytes a few rows ahead,
                            // then (once the record is in) the group's long string
                            if let Some(&n) = gids.get(i + far) {
                                self.prefetch_slot(n, f);
                                prefetch($f(a.value(i + far)).as_ptr());
                            }
                            if let Some(&n) = gids.get(i + far / 2) {
                                if (n as usize) < next {
                                    let s = self.get(n as usize, f);
                                    if s as u32 > 12 {
                                        prefetch(self.arena.as_ptr().wrapping_add((s >> 64) as usize));
                                    }
                                }
                            }
                            let g = g as usize;
                            nulls_step!(i, g);
                            let b: &[u8] = $f(a.value(i));
                            let h = head(b);
                            if b.len() <= 12 {
                                settle!(g, h);
                                continue;
                            }
                            if g == next {
                                let off = self.arena.len() as u128;
                                self.arena.extend_from_slice(b);
                                self.set(g, f, (h & LOW) | (off << 64));
                                next += 1;
                                continue;
                            }
                            let slot = self.get(g, f);
                            let off = (slot >> 64) as usize;
                            if slot & LOW != h & LOW || self.arena[off..off + b.len()] != *b {
                                return false;
                            }
                        }
                        true
                    }};
                }
                match array.data_type() {
                    DataType::Utf8 => offsets!(array.as_string::<i32>(), str::as_bytes),
                    DataType::LargeUtf8 => offsets!(array.as_string::<i64>(), str::as_bytes),
                    DataType::Utf8View => views!(array.as_string_view()),
                    DataType::Binary => offsets!(array.as_binary::<i32>(), std::convert::identity),
                    DataType::LargeBinary => offsets!(array.as_binary::<i64>(), std::convert::identity),
                    DataType::BinaryView => views!(array.as_binary_view()),
                    _ => false,
                }
            }
        }
    }

    /// Field `f` of groups `0..n`.
    pub fn values(&self, f: usize, n: usize) -> Result<ArrayRef> {
        let field = &self.fields[f];
        let nulls = field.nulls.as_ref().map(|v| v[..n].iter().map(|&b| !b).collect::<Vec<bool>>()).map(NullBuffer::from);
        let slot = |g: usize| self.get(g, f);
        match field.kind {
            Kind::Fixed(w) => {
                let mut bytes = MutableBuffer::with_capacity(n * w);
                for g in 0..n {
                    bytes.extend_from_slice(&slot(g).to_le_bytes()[..w]);
                }
                let data = ArrayData::builder(field.dt.clone()).len(n).add_buffer(Buffer::from(bytes)).nulls(nulls).build()?;
                Ok(make_array(data))
            }
            Kind::Bool => {
                let valid = |g: usize| field.nulls.as_ref().is_none_or(|v| !v[g]);
                Ok(Arc::new((0..n).map(|g| valid(g).then(|| slot(g) != 0)).collect::<BooleanArray>()))
            }
            Kind::Bytes => {
                let mut data = vec![];
                let mut offsets = Vec::with_capacity(n + 1);
                offsets.push(0);
                for g in 0..n {
                    let s = slot(g);
                    let len = s as u32 as usize;
                    if len <= 12 {
                        data.extend_from_slice(&s.to_le_bytes()[4..4 + len]);
                    } else if s & SOURCE != 0 {
                        data.extend_from_slice(source_bytes(field.source.as_ref().expect("source"), s));
                    } else {
                        let off = (s >> 64) as usize;
                        data.extend_from_slice(&self.arena[off..off + len]);
                    }
                    offsets.push(data.len());
                }
                bytes_array(&field.dt, std::borrow::Cow::Owned(data), &offsets, nulls)
            }
        }
    }
}
