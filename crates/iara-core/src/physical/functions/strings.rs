//! String kernels for padding, splitting, joining and repeating.
//! All of them take `Utf8` arrays (the planner casts) and keep NULL rows NULL.

use std::sync::Arc;

use arrow::array::*;

fn take_chars(s: &str, n: usize) -> &str {
    match s.char_indices().nth(n) {
        Some((b, _)) => &s[..b],
        None => s,
    }
}

/// lpad / rpad: result has exactly `n` chars (truncated on the right if longer).
pub fn pad(s: &ArrayRef, n: &ArrayRef, fill: &ArrayRef, left: bool) -> ArrayRef {
    let (s, n, p) = (s.as_string::<i32>(), n.as_primitive::<arrow::datatypes::Int64Type>(), fill.as_string::<i32>());
    let mut b = StringBuilder::with_capacity(s.len(), s.value_data().len());
    let mut buf = String::new();
    for i in 0..s.len() {
        if s.is_null(i) || n.is_null(i) || p.is_null(i) {
            b.append_null();
            continue;
        }
        let (text, target, fill) = (s.value(i), n.value(i).max(0) as usize, p.value(i));
        let len = text.chars().count();
        if len >= target {
            b.append_value(take_chars(text, target));
        } else if fill.is_empty() {
            b.append_value(text);
        } else {
            buf.clear();
            let padding = fill.chars().cycle().take(target - len);
            if left {
                buf.extend(padding);
                buf.push_str(text);
            } else {
                buf.push_str(text);
                buf.extend(padding);
            }
            b.append_value(&buf);
        }
    }
    Arc::new(b.finish())
}

/// zfill (Polars): left-pad with zeros, keeping a leading sign in front.
pub fn zfill(s: &ArrayRef, n: &ArrayRef) -> ArrayRef {
    let (s, n) = (s.as_string::<i32>(), n.as_primitive::<arrow::datatypes::Int64Type>());
    let mut b = StringBuilder::with_capacity(s.len(), s.value_data().len());
    for i in 0..s.len() {
        if s.is_null(i) || n.is_null(i) {
            b.append_null();
            continue;
        }
        let (text, target) = (s.value(i), n.value(i).max(0) as usize);
        let len = text.chars().count();
        if len >= target {
            b.append_value(text);
            continue;
        }
        let (sign, rest) = match text.chars().next() {
            Some(c @ ('-' | '+')) => text.split_at(c.len_utf8()),
            _ => ("", text),
        };
        b.append_value(format!("{sign}{}{rest}", "0".repeat(target - len)));
    }
    Arc::new(b.finish())
}

/// split_part(s, delim, idx): 1-based, negative counts from the end, '' if absent.
pub fn split_part(s: &ArrayRef, d: &ArrayRef, idx: &ArrayRef) -> ArrayRef {
    let (s, d, k) = (s.as_string::<i32>(), d.as_string::<i32>(), idx.as_primitive::<arrow::datatypes::Int64Type>());
    let mut b = StringBuilder::with_capacity(s.len(), s.value_data().len());
    for i in 0..s.len() {
        if s.is_null(i) || d.is_null(i) || k.is_null(i) {
            b.append_null();
            continue;
        }
        let (text, delim, k) = (s.value(i), d.value(i), k.value(i));
        let part = if delim.is_empty() {
            if k == 1 || k == -1 { Some(text) } else { None }
        } else if k > 0 {
            text.split(delim).nth(k as usize - 1)
        } else if k < 0 {
            text.rsplit(delim).nth((-k) as usize - 1)
        } else {
            None
        };
        b.append_value(part.unwrap_or(""));
    }
    Arc::new(b.finish())
}

/// concat_ws(sep, a, b, ..): NULL parts are skipped; a NULL separator gives NULL.
pub fn concat_ws(arrays: &[ArrayRef], m: usize) -> ArrayRef {
    let strs: Vec<&StringArray> = arrays.iter().map(|a| a.as_string::<i32>()).collect();
    let mut b = StringBuilder::with_capacity(m, m * 8);
    let mut buf = String::new();
    for i in 0..m {
        if strs[0].is_null(i) {
            b.append_null();
            continue;
        }
        buf.clear();
        let mut first = true;
        for s in &strs[1..] {
            if s.is_valid(i) {
                if !first {
                    buf.push_str(strs[0].value(i));
                }
                buf.push_str(s.value(i));
                first = false;
            }
        }
        b.append_value(&buf);
    }
    Arc::new(b.finish())
}

/// initcap: first letter of each alphanumeric run upper-cased, the rest lower-cased.
pub fn initcap(s: &ArrayRef) -> ArrayRef {
    let s = s.as_string::<i32>();
    let mut b = StringBuilder::with_capacity(s.len(), s.value_data().len());
    let mut buf = String::new();
    for v in s.iter() {
        match v {
            None => b.append_null(),
            Some(text) => {
                buf.clear();
                let mut word_start = true;
                for c in text.chars() {
                    if c.is_alphanumeric() {
                        if word_start {
                            buf.extend(c.to_uppercase());
                        } else {
                            buf.extend(c.to_lowercase());
                        }
                        word_start = false;
                    } else {
                        buf.push(c);
                        word_start = true;
                    }
                }
                b.append_value(&buf);
            }
        }
    }
    Arc::new(b.finish())
}

pub fn repeat(s: &ArrayRef, n: &ArrayRef) -> ArrayRef {
    let (s, n) = (s.as_string::<i32>(), n.as_primitive::<arrow::datatypes::Int64Type>());
    let mut b = StringBuilder::with_capacity(s.len(), s.value_data().len());
    for i in 0..s.len() {
        if s.is_null(i) || n.is_null(i) {
            b.append_null();
        } else {
            b.append_value(s.value(i).repeat(n.value(i).max(0) as usize));
        }
    }
    Arc::new(b.finish())
}
