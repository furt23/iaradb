//! Fast LIKE matching for patterns whose only wildcard is `%`:
//! `abc` (equality), `abc%`, `%abc`, `%abc%` and multi-part patterns like
//! `%special%requests%`, using SIMD substring search (memchr::memmem).
//! Anything else (`_`, escapes, ILIKE) falls back to Arrow's kernels.
//!
//! `%abc%` over string views searches each data buffer once (a decoded
//! page's strings lie back to back in it) instead of every string on its
//! own: a view matches when an occurrence starts inside its bytes.

use std::sync::Arc;

use arrow::array::*;
use arrow::buffer::{BooleanBuffer, Buffer};
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
                match self.contains_in_buffers(s.views(), s.data_buffers()) {
                    Some(found) if negated => !&found,
                    Some(found) => found,
                    None => BooleanBuffer::collect_bool(n, |i| self.matches(s.value(i).as_bytes()) != negated),
                }
            }
            _ => return None,
        };
        Some(BooleanArray::new(values, a.logical_nulls()))
    }

    /// `%lit%` over views by searching their data buffers (None: another
    /// pattern, or buffers holding much more than these views use).
    fn contains_in_buffers(&self, views: &[u128], buffers: &[Buffer]) -> Option<BooleanBuffer> {
        if self.exact || self.prefix.is_some() || self.suffix.is_some() || self.middle.len() != 1 || buffers.is_empty() {
            return None;
        }
        let finder = &self.middle[0];
        let nlen = finder.needle().len();
        let used: usize = views.iter().map(|&v| v as u32 as usize).filter(|&l| l > 12).sum();
        let held: usize = buffers.iter().map(|b| b.len()).sum();
        if nlen == 0 || held > used * 2 + 4096 {
            return None;
        }
        // every occurrence (overlapping ones too: one crossing from a
        // string into the next must not hide a match inside the next)
        let hits: Vec<Vec<u32>> = buffers
            .iter()
            .map(|b| {
                let (mut out, mut at) = (vec![], 0usize);
                while let Some(k) = finder.find(&b.as_slice()[at..]) {
                    out.push((at + k) as u32);
                    at += k + 1;
                }
                out
            })
            .collect();
        Some(BooleanBuffer::collect_bool(views.len(), |i| {
            let v = views[i];
            let len = v as u32 as usize;
            if len < nlen {
                return false;
            }
            if len <= 12 {
                return finder.find(&v.to_le_bytes()[4..4 + len]).is_some();
            }
            let (buf, off) = ((v >> 64) as u32 as usize, (v >> 96) as u32);
            let h = &hits[buf];
            let k = h.partition_point(|&p| p < off);
            k < h.len() && h[k] as usize + nlen <= off as usize + len
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contains_over_buffers_matches_per_string() {
        let vals: Vec<String> = (0..5000)
            .map(|i| match i % 7 {
                0 => format!("https://www.google.com/search?q={i}"),
                1 => "goo".to_string(),
                2 => format!("{i}gle-and-more-text-that-is-long"),
                3 => "googl".to_string(),
                4 => "agoogle".to_string(),
                _ => format!("http://example.org/page/{i}/nothing-here"),
            })
            .collect();
        let a: ArrayRef = Arc::new(StringViewArray::from_iter_values(vals.iter()));
        for (pat, neg) in [("%google%", false), ("%google%", true), ("%goo%", false), ("%e%", false)] {
            let m = LikeMatcher::compile(pat, false).unwrap();
            let got = m.evaluate(a.as_ref(), neg).unwrap();
            let lit = pat.trim_matches('%');
            for (i, v) in vals.iter().enumerate() {
                assert_eq!(got.value(i), v.contains(lit) != neg, "{pat} {v}");
            }
        }
        // a slice pins the whole buffer: per string
        let m = LikeMatcher::compile("%google%", false).unwrap();
        let s = a.slice(7, 3);
        assert!(m.contains_in_buffers(s.as_string_view().views(), s.as_string_view().data_buffers()).is_none());
        assert_eq!(m.evaluate(s.as_ref(), false).unwrap().value(0), true);
    }
}
