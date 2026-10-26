//! `string_split` and `regexp_split_to_array`.

use std::sync::Arc;

use arrow::array::*;

use super::const_str;
use super::gather::list_from_parts;
use crate::error::Result;
use crate::physical::expr::ColumnarValue;
use crate::physical::functions::pattern;

/// Split every row with `pieces`, keeping NULL subjects NULL.
fn split_rows<'a, S>(s: S, len: usize, bytes: usize, mut pieces: impl FnMut(usize, &str, &mut dyn FnMut(&str))) -> Result<ArrayRef>
where
    S: ArrayAccessor<Item = &'a str>,
{
    let mut b = StringBuilder::with_capacity(len, bytes);
    let (mut offsets, mut valid) = (Vec::with_capacity(len + 1), Vec::with_capacity(len));
    offsets.push(0i32);
    let mut count = 0i32;
    for r in 0..len {
        let ok = s.is_valid(r);
        valid.push(ok);
        if ok {
            pieces(r, s.value(r), &mut |p| {
                b.append_value(p);
                count += 1;
            });
        }
        offsets.push(count);
    }
    list_from_parts(Arc::new(b.finish()), offsets, valid)
}

fn split_text(text: &str, sep: &str, out: &mut dyn FnMut(&str)) {
    if text.is_empty() {
        out("");
    } else if sep.is_empty() {
        let mut buf = [0u8; 4];
        text.chars().for_each(|c| out(c.encode_utf8(&mut buf)));
    } else {
        text.split(sep).for_each(out);
    }
}

/// `string_split(s, sep)`: an empty separator splits into characters, a NULL
/// one makes the row NULL. `s` is Utf8 or Utf8View.
pub fn string_split(s: &ArrayRef, sep: &ColumnarValue, m: usize) -> Result<ArrayRef> {
    let bytes = s.get_buffer_memory_size();
    if let ColumnarValue::Scalar(c) = sep {
        let Some(sep) = c.as_str() else {
            return list_from_parts(Arc::new(StringArray::new_null(0)), vec![0; s.len() + 1], vec![false; s.len()]);
        };
        return match s.as_string_view_opt() {
            Some(v) => split_rows(v, v.len(), bytes, |_, t, out| split_text(t, sep, out)),
            None => split_rows(s.as_string::<i32>(), s.len(), bytes, |_, t, out| split_text(t, sep, out)),
        };
    }
    let sep = sep.clone().into_array(m)?;
    let sep = sep.as_string::<i32>();
    // a NULL separator makes the row NULL: mask it out of the subject
    let text = |r: usize| match s.as_string_view_opt() {
        Some(v) => v.value(r),
        None => s.as_string::<i32>().value(r),
    };
    let masked = StringArray::from_iter((0..s.len()).map(|r| (sep.is_valid(r) && s.is_valid(r)).then(|| text(r))));
    split_rows(&masked, masked.len(), bytes, |r, t, out| split_text(t, sep.value(r), out))
}

/// `regexp_split_to_array(s, pattern[, flags])` with a constant pattern.
pub fn regexp_split(s: &ArrayRef, args: &[ColumnarValue]) -> Result<ArrayRef> {
    let flags = const_str(args, 2)?.unwrap_or_default();
    let Some(pat) = const_str(args, 1)? else {
        return list_from_parts(Arc::new(StringArray::new_null(0)), vec![0; s.len() + 1], vec![false; s.len()]);
    };
    let re = pattern::compile_local(&pat, &flags)?;
    let s = s.as_string::<i32>();
    split_rows(s, s.len(), s.value_data().len(), |_, text, out| re.split(text).for_each(out))
}
