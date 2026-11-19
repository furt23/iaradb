//! Python lists into Arrow columns and back, for the plain types: integers,
//! floats, booleans and strings (with `None`).
//!
//! pyarrow converts every type, and is where everything else goes. For these
//! four it makes a scalar object per value on the way out (`to_pylist`), and
//! goes through a converter per value on the way in, which costs several
//! times what the value itself does. Here a column is one pass over the list.
//!
//! A list becomes a column only when it is what pyarrow would make the same
//! column of: values of one of the four types, or integers among floats
//! (floats, when the integers are exact as floats). Anything else (a date, a
//! `Decimal`, a numpy scalar, a subclass, an integer past 64 bits, a boolean
//! among integers) is left to pyarrow, which converts it or raises as before.

use std::ffi::c_char;
use std::sync::Arc;

use arrow::array::{Array, ArrayRef, AsArray, BooleanArray, Float64Array, Int64Array, StringArray};
use arrow::buffer::{BooleanBuffer, NullBuffer, OffsetBuffer, ScalarBuffer};
use arrow::datatypes::*;
use pyo3::prelude::*;
use pyo3::types::{PyList, PyTuple};
use pyo3::ffi;

/// Integers up to this are exact as floats.
const EXACT_FLOAT: i64 = 1 << 53;

enum Values {
    /// only `None` so far
    Unknown,
    Int(Vec<i64>),
    Float(Vec<f64>),
    Bool(Vec<bool>),
    /// offsets (one more than the values) and bytes
    Str(Vec<i32>, Vec<u8>),
}

/// The exact type of a value, among those converted here.
#[derive(Clone, Copy, PartialEq)]
enum Kind {
    None,
    Int,
    Float,
    Bool,
    Str,
    Other,
}

fn kind_of(item: *mut ffi::PyObject) -> Kind {
    // SAFETY: `item` is a live object (borrowed from its list), and the type objects are statics
    unsafe {
        if item == ffi::Py_None() {
            return Kind::None;
        }
        let ty = ffi::Py_TYPE(item);
        if ty == &raw mut ffi::PyLong_Type {
            Kind::Int
        } else if ty == &raw mut ffi::PyFloat_Type {
            Kind::Float
        } else if ty == &raw mut ffi::PyUnicode_Type {
            Kind::Str
        } else if ty == &raw mut ffi::PyBool_Type {
            Kind::Bool
        } else {
            Kind::Other
        }
    }
}

/// The column a list or tuple of plain values is, or `None` when it is for
/// pyarrow to convert (another sequence, other types, mixed types, no value).
pub fn column_from_py(seq: &Bound<'_, PyAny>) -> PyResult<Option<ArrayRef>> {
    if let Ok(list) = seq.cast_exact::<PyList>() {
        let ptr = list.as_ptr();
        // SAFETY: `i` is below the length, and nothing below runs Python code that could change the list
        return Ok(convert(list.len(), |i| unsafe { ffi::PyList_GetItem(ptr, i as ffi::Py_ssize_t) }));
    }
    if let Ok(tuple) = seq.cast_exact::<PyTuple>() {
        let ptr = tuple.as_ptr();
        // SAFETY: as above
        return Ok(convert(tuple.len(), |i| unsafe { ffi::PyTuple_GetItem(ptr, i as ffi::Py_ssize_t) }));
    }
    Ok(None)
}

fn convert(n: usize, get: impl Fn(usize) -> *mut ffi::PyObject) -> Option<ArrayRef> {
    let mut values = Values::Unknown;
    // one flag per value once a `None` was seen
    let mut valid: Option<Vec<bool>> = None;
    for i in 0..n {
        let item = get(i);
        if item.is_null() {
            // SAFETY: the failed call set an error, which pyarrow's conversion will raise again
            unsafe { ffi::PyErr_Clear() };
            return None;
        }
        let kind = kind_of(item);
        if kind == Kind::None {
            valid.get_or_insert_with(|| vec![true; i]).push(false);
            match &mut values {
                Values::Unknown => {}
                Values::Int(v) => v.push(0),
                Values::Float(v) => v.push(0.0),
                Values::Bool(v) => v.push(false),
                Values::Str(offsets, bytes) => offsets.push(bytes.len() as i32),
            }
            continue;
        }
        if let Some(valid) = &mut valid {
            valid.push(true);
        }
        if let Values::Unknown = values {
            // the values before this one are all `None`
            values = match kind {
                Kind::Int => Values::Int(vec![0; i]),
                Kind::Float => Values::Float(vec![0.0; i]),
                Kind::Bool => Values::Bool(vec![false; i]),
                Kind::Str => Values::Str(vec![0; i + 1], Vec::with_capacity(n * 8)),
                _ => return None,
            };
        }
        match (&mut values, kind) {
            (Values::Int(v), Kind::Int) => v.push(int(item)?),
            (Values::Int(v), Kind::Float) => {
                // integers among floats are floats
                let mut floats: Vec<f64> = v.iter().map(|&x| exact(x)).collect::<Option<_>>()?;
                floats.push(float(item));
                values = Values::Float(floats);
            }
            (Values::Float(v), Kind::Float) => v.push(float(item)),
            (Values::Float(v), Kind::Int) => v.push(exact(int(item)?)?),
            (Values::Bool(v), Kind::Bool) => v.push(item == unsafe { ffi::Py_True() }),
            (Values::Str(offsets, bytes), Kind::Str) => {
                bytes.extend_from_slice(utf8(item)?);
                // a column past 2 GB of text is several chunks in pyarrow
                offsets.push(i32::try_from(bytes.len()).ok()?);
            }
            _ => return None,
        }
    }
    let nulls = valid.map(|v| NullBuffer::new(BooleanBuffer::from(v)));
    Some(match values {
        // a column of `None` only has pyarrow's null type
        Values::Unknown => return None,
        Values::Int(v) => Arc::new(Int64Array::new(ScalarBuffer::from(v), nulls)),
        Values::Float(v) => Arc::new(Float64Array::new(ScalarBuffer::from(v), nulls)),
        Values::Bool(v) => Arc::new(BooleanArray::new(BooleanBuffer::from(v), nulls)),
        Values::Str(offsets, bytes) => {
            // SAFETY: the bytes are the UTF-8 of Python strings, cut at their ends; offsets only grow
            let offsets = unsafe { OffsetBuffer::new_unchecked(ScalarBuffer::from(offsets)) };
            Arc::new(unsafe { StringArray::new_unchecked(offsets, bytes.into(), nulls) })
        }
    })
}

/// An `int` object as 64 bits (`None`: it does not fit).
fn int(item: *mut ffi::PyObject) -> Option<i64> {
    let mut overflow = 0;
    // SAFETY: `item` is an `int`
    let v = unsafe { ffi::PyLong_AsLongLongAndOverflow(item, &mut overflow) };
    (overflow == 0).then_some(v)
}

fn float(item: *mut ffi::PyObject) -> f64 {
    // SAFETY: `item` is a `float`
    unsafe { ffi::PyFloat_AsDouble(item) }
}

/// An integer as a float, when the float is the same number.
fn exact(v: i64) -> Option<f64> {
    (-EXACT_FLOAT..=EXACT_FLOAT).contains(&v).then_some(v as f64)
}

/// The UTF-8 of a `str` object (`None`: it has none, as a lone surrogate).
fn utf8<'a>(item: *mut ffi::PyObject) -> Option<&'a [u8]> {
    let mut len: ffi::Py_ssize_t = 0;
    // SAFETY: `item` is a `str`; its UTF-8 lives as long as it does (the list holds it)
    unsafe {
        let ptr = ffi::PyUnicode_AsUTF8AndSize(item, &mut len);
        if ptr.is_null() {
            ffi::PyErr_Clear();
            return None;
        }
        Some(std::slice::from_raw_parts(ptr as *const u8, len as usize))
    }
}

/// A new `str` of `s`.
///
/// # Safety
/// The interpreter is held (a `Python` token is in scope at the caller).
unsafe fn text(s: &str) -> *mut ffi::PyObject {
    unsafe { ffi::PyUnicode_FromStringAndSize(s.as_ptr() as *const c_char, s.len() as ffi::Py_ssize_t) }
}

/// The values of a column (its chunks, in order) as a Python list, or `None`
/// when the type is for pyarrow to convert.
pub fn column_to_py<'py>(py: Python<'py>, chunks: &[ArrayRef]) -> PyResult<Option<Bound<'py, PyList>>> {
    let Some(first) = chunks.first() else { return Ok(None) };
    let plain = |dt: &DataType| dt.is_integer() || matches!(dt, DataType::Float32 | DataType::Float64 | DataType::Boolean | DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View | DataType::Null);
    if !plain(first.data_type()) || chunks.iter().any(|c| c.data_type() != first.data_type()) {
        return Ok(None);
    }
    let rows: usize = chunks.iter().map(|c| c.len()).sum();
    // SAFETY: a new list of `rows` slots, each set below before the list is used
    let list = unsafe { Bound::from_owned_ptr_or_err(py, ffi::PyList_New(rows as ffi::Py_ssize_t))? };
    let mut at = 0;
    let mut failed = false;
    for chunk in chunks {
        // `None` for a null; a value that could not be made (null pointer) fails the column,
        // with `None` in its slot so that the list is never left with an empty one
        let mut put = |object: Option<*mut ffi::PyObject>| {
            failed |= object.is_some_and(|o| o.is_null());
            // SAFETY: `at` is below `rows`; the slot takes the reference
            unsafe {
                let object = object.filter(|o| !o.is_null()).unwrap_or_else(|| ffi::Py_NewRef(ffi::Py_None()));
                ffi::PyList_SetItem(list.as_ptr(), at as ffi::Py_ssize_t, object);
            }
            at += 1;
        };
        macro_rules! each {
            ($array:expr, $make:expr) => {{
                let array = $array;
                for i in 0..array.len() {
                    // SAFETY: the calls below make a new object (or fail with null)
                    put((!array.is_null(i)).then(|| unsafe { $make(array.value(i)) }));
                }
            }};
        }
        match chunk.data_type() {
            DataType::Int8 => each!(chunk.as_primitive::<Int8Type>(), |v: i8| ffi::PyLong_FromLongLong(v.into())),
            DataType::Int16 => each!(chunk.as_primitive::<Int16Type>(), |v: i16| ffi::PyLong_FromLongLong(v.into())),
            DataType::Int32 => each!(chunk.as_primitive::<Int32Type>(), |v: i32| ffi::PyLong_FromLongLong(v.into())),
            DataType::Int64 => each!(chunk.as_primitive::<Int64Type>(), |v: i64| ffi::PyLong_FromLongLong(v)),
            DataType::UInt8 => each!(chunk.as_primitive::<UInt8Type>(), |v: u8| ffi::PyLong_FromLongLong(v.into())),
            DataType::UInt16 => each!(chunk.as_primitive::<UInt16Type>(), |v: u16| ffi::PyLong_FromLongLong(v.into())),
            DataType::UInt32 => each!(chunk.as_primitive::<UInt32Type>(), |v: u32| ffi::PyLong_FromLongLong(v.into())),
            DataType::UInt64 => each!(chunk.as_primitive::<UInt64Type>(), |v: u64| ffi::PyLong_FromUnsignedLongLong(v)),
            DataType::Float32 => each!(chunk.as_primitive::<Float32Type>(), |v: f32| ffi::PyFloat_FromDouble(v.into())),
            DataType::Float64 => each!(chunk.as_primitive::<Float64Type>(), |v: f64| ffi::PyFloat_FromDouble(v)),
            DataType::Boolean => each!(chunk.as_boolean(), |v: bool| ffi::Py_NewRef(if v { ffi::Py_True() } else { ffi::Py_False() })),
            DataType::Utf8 => each!(chunk.as_string::<i32>(), text),
            DataType::LargeUtf8 => each!(chunk.as_string::<i64>(), text),
            DataType::Utf8View => each!(chunk.as_string_view(), text),
            _ => (0..chunk.len()).for_each(|_| put(None)),
        }
    }
    if failed {
        return Err(PyErr::take(py).unwrap_or_else(|| pyo3::exceptions::PyMemoryError::new_err("could not make a Python object")));
    }
    Ok(Some(list.cast_into::<PyList>()?))
}

/// One dict per row, `names[c]` to `columns[c][row]`: what a comprehension over
/// `zip(*columns)` builds, without a tuple and an iterator per row.
pub fn rows_as_dicts<'py>(names: &Bound<'py, PyList>, columns: &Bound<'py, PyList>) -> PyResult<Bound<'py, PyList>> {
    let py = names.py();
    let lists: Vec<Bound<'py, PyList>> = columns.iter().map(|c| c.cast_into_exact::<PyList>().map_err(PyErr::from)).collect::<PyResult<_>>()?;
    let keys: Vec<Bound<'py, PyAny>> = names.iter().collect();
    if keys.len() != lists.len() {
        return Err(pyo3::exceptions::PyValueError::new_err("a name per column is needed"));
    }
    let rows = lists.first().map_or(0, |l| l.len());
    if lists.iter().any(|l| l.len() != rows) {
        return Err(pyo3::exceptions::PyValueError::new_err("the columns differ in length"));
    }
    // SAFETY: a new list of `rows` slots, each set below before the list is used
    let out = unsafe { Bound::from_owned_ptr_or_err(py, ffi::PyList_New(rows as ffi::Py_ssize_t))? };
    let mut failed = false;
    for row in 0..rows {
        // SAFETY: `row` is below every list's length (nothing here runs Python code that could
        // change them: the keys are the `str` names of a frame's columns); `PyDict_SetItem`
        // takes its own references, and the slot takes the dict's
        unsafe {
            let dict = ffi::PyDict_New();
            if dict.is_null() {
                failed = true;
                ffi::PyList_SetItem(out.as_ptr(), row as ffi::Py_ssize_t, ffi::Py_NewRef(ffi::Py_None()));
                continue;
            }
            for (key, list) in keys.iter().zip(&lists) {
                let value = ffi::PyList_GetItem(list.as_ptr(), row as ffi::Py_ssize_t);
                failed |= value.is_null() || ffi::PyDict_SetItem(dict, key.as_ptr(), value) != 0;
            }
            ffi::PyList_SetItem(out.as_ptr(), row as ffi::Py_ssize_t, dict);
        }
    }
    if failed {
        return Err(PyErr::take(py).unwrap_or_else(|| pyo3::exceptions::PyMemoryError::new_err("could not make a row")));
    }
    out.cast_into::<PyList>().map_err(PyErr::from)
}
