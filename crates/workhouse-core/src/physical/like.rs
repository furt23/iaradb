//! Fast LIKE matching for patterns whose only wildcard is `%`:
//! `abc` (equality), `abc%`, `%abc`, `%abc%` and multi-part patterns like
//! `%special%requests%`, using SIMD substring search (memchr::memmem).
//! Anything else (`_`, escapes, ILIKE) falls back to Arrow's kernels.

use std::sync::Arc;

use arrow::array::*;
use arrow::buffer::BooleanBuffer;
use arrow::datatypes::DataType;
use memchr::memmem::Finder;

#[derive(Debug)]
pub struct LikeMatcher {
    /// literal required at the start
    prefix: Option<Vec<u8>>,
    /// literals that must appear in order in the middle
    middle: Vec<Finder<'static>>,
    /// literal required at the end
    suffix: Option<Vec<u8>>,
    /// pattern without any `%`
    exact: bool,
}

impl LikeMatcher {
    pub fn compile(pattern: &str, case_insensitive: bool) -> Option<Arc<LikeMatcher>> {
        if case_insensitive || pattern.contains(['_', '\\']) {
            return None;
        }
        let anchored_start = !pattern.starts_with('%');
        let anchored_end = !pattern.ends_with('%');
        let mut lits: Vec<Vec<u8>> =
            pattern.split('%').filter(|p| !p.is_empty()).map(|p| p.as_bytes().to_vec()).collect();
        if !pattern.contains('%') {
            return Some(Arc::new(LikeMatcher { prefix: Some(pattern.as_bytes().to_vec()), middle: vec![], suffix: None, exact: true }));
        }
        let prefix = if anchored_start && !lits.is_empty() { Some(lits.remove(0)) } else { None };
        let suffix = if anchored_end && !lits.is_empty() { lits.pop() } else { None };
        let middle = lits.iter().map(|l| Finder::new(l).into_owned()).collect();
        Some(Arc::new(LikeMatcher { prefix, middle, suffix, exact: false }))
    }

    #[inline]
    pub fn matches(&self, s: &[u8]) -> bool {
        if self.exact {
            return self.prefix.as_deref() == Some(s);
        }
        let mut pos = 0;
        if let Some(p) = &self.prefix {
            if !s.starts_with(p) {
                return false;
            }
            pos = p.len();
        }
        let end = match &self.suffix {
            Some(x) => {
                if s.len() < pos + x.len() || !s.ends_with(x) {
                    return false;
                }
                s.len() - x.len()
            }
            None => s.len(),
        };
        for f in &self.middle {
            match f.find(&s[pos..end]) {
                Some(k) => pos += k + f.needle().len(),
                None => return false,
            }
        }
        true
    }

    /// Evaluate on a string array; `None` if the array type is unsupported.
    pub fn evaluate(&self, a: &dyn Array, negated: bool) -> Option<BooleanArray> {
        let n = a.len();
        let values = match a.data_type() {
            DataType::Utf8 => {
                let s = a.as_string::<i32>();
                BooleanBuffer::collect_bool(n, |i| self.matches(s.value(i).as_bytes()) != negated)
            }
            DataType::LargeUtf8 => {
                let s = a.as_string::<i64>();
                BooleanBuffer::collect_bool(n, |i| self.matches(s.value(i).as_bytes()) != negated)
            }
            DataType::Utf8View => {
                let s = a.as_string_view();
                BooleanBuffer::collect_bool(n, |i| self.matches(s.value(i).as_bytes()) != negated)
            }
            _ => return None,
        };
        Some(BooleanArray::new(values, a.logical_nulls()))
    }
}
