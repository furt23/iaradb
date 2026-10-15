//! `string_split` and `regexp_split_to_array`.

use std::sync::Arc;

use arrow::array::*;

use super::const_str;
use super::gather::list_from_parts;
use crate::error::Result;
use crate::physical::expr::ColumnarValue;
use crate::physical::functions::pattern;

/// Split every row with `pieces`, keeping NULL subjects NULL.
fn split_rows(s: &StringArray, mut pieces: impl FnMut(usize, &str, &mut dyn FnMut(&str))) -> Result<ArrayRef> {
    let mut b = StringBuilder::with_capacity(s.len(), s.value_data().len());
    let (mut offsets, mut valid) = (Vec::with_capacity(s.len() + 1), Vec::with_capacity(s.len()));
    offsets.push(0i32);
    let mut count = 0i32;
    for r in 0..s.len() {
        valid.push(s.is_valid(r));
        if s.is_valid(r) {
            pieces(r, s.value(r), &mut |p| {
                b.append_value(p);
                count += 1;
            });
        }
        offsets.push(count);
    }
    list_from_parts(Arc::new(b.finish()), offsets, valid)
}

/// `string_split(s, sep)`: an empty separator splits into characters.
pub fn string_split(s: &ArrayRef, sep: &ArrayRef) -> Result<ArrayRef> {
    let (s, sep) = (s.as_string::<i32>(), sep.as_string::<i32>());
    // a NULL separator makes the row NULL: mask it out of the subject
    let masked = StringArray::from_iter((0..s.len()).map(|r| (sep.is_valid(r) && s.is_valid(r)).then(|| s.value(r))));
    split_rows(&masked, |r, text, out| {
        let sep = sep.value(r);
        if text.is_empty() {
            out("");
        } else if sep.is_empty() {
            let mut buf = [0u8; 4];
            text.chars().for_each(|c| out(c.encode_utf8(&mut buf)));
        } else {
            text.split(sep).for_each(out);
        }
    })
}

/// `regexp_split_to_array(s, pattern[, flags])` with a constant pattern.
pub fn regexp_split(s: &ArrayRef, args: &[ColumnarValue]) -> Result<ArrayRef> {
    let flags = const_str(args, 2)?.unwrap_or_default();
    let Some(pat) = const_str(args, 1)? else {
        return list_from_parts(Arc::new(StringArray::new_null(0)), vec![0; s.len() + 1], vec![false; s.len()]);
    };
    let re = pattern::compile(&pat, &flags)?;
    split_rows(s.as_string::<i32>(), |_, text, out| re.split(text).for_each(out))
}
