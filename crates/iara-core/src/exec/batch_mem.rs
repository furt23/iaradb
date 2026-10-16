//! The memory of batches that sinks keep (join build sides, sorts, windows,
//! aggregation partitions).
//!
//! `get_array_memory_size` counts every buffer an array points into, whole.
//! A string-view array taken from a decoded row group points into all of
//! the row group's string buffers, and each of the many small batches a
//! selective join emits counted them again: build sides of a few thousand
//! rows were accounted as tens of GB and spilled for nothing. Here a batch
//! is measured by the bytes it uses, and [`compact`] first copies the
//! strings of view columns that pin much more than they use, so what is
//! measured is also what is held.

use std::sync::Arc;

use arrow::array::*;
use arrow::datatypes::DataType;
use arrow::record_batch::{RecordBatch, RecordBatchOptions};

use crate::error::Result;

/// A view column is compacted when its buffers hold more than this many
/// times the bytes it uses (plus [`SLACK`]) ...
const WASTE_FACTOR: usize = 4;
const SLACK: usize = 1 << 20;
/// ... or when it references more buffers than this: arrays taken from a
/// table share all of its buffers, and concatenating many of them repeats
/// the whole list for each (billions of references for big build sides).
const MAX_BUFFERS: usize = 16;
/// Concatenated arrays referencing more buffers than this in total are compacted.
const MAX_CONCAT_REFS: usize = 1024;

/// Out-of-line string bytes of a view array (strings over 12 bytes).
fn view_data_used(views: &[u128]) -> usize {
    views.iter().map(|&v| v as u32 as usize).filter(|&len| len > 12).sum()
}

fn nulls_bytes(a: &dyn Array) -> usize {
    a.nulls().map_or(0, |n| n.len().div_ceil(8))
}

/// Bytes `a` uses: its slice of fixed-width buffers, the string bytes it
/// references, not whole shared buffers.
pub fn array_bytes(a: &dyn Array) -> usize {
    let n = a.len();
    let nulls = nulls_bytes(a);
    match a.data_type() {
        DataType::Utf8View => n * 16 + nulls + view_data_used(a.as_string_view().views()),
        DataType::BinaryView => n * 16 + nulls + view_data_used(a.as_binary_view().views()),
        DataType::Utf8 => {
            let o = a.as_string::<i32>().offsets();
            (n + 1) * 4 + nulls + (o[n] - o[0]) as usize
        }
        DataType::LargeUtf8 => {
            let o = a.as_string::<i64>().offsets();
            (n + 1) * 8 + nulls + (o[n] - o[0]) as usize
        }
        DataType::Binary => {
            let o = a.as_binary::<i32>().offsets();
            (n + 1) * 4 + nulls + (o[n] - o[0]) as usize
        }
        DataType::Boolean => n.div_ceil(8) + nulls,
        dt => match dt.primitive_width() {
            Some(w) => n * w + nulls,
            None => a.get_array_memory_size(),
        },
    }
}

/// Data buffers a view array references (0 for other arrays).
pub fn view_buffers(a: &dyn Array) -> usize {
    match a.data_type() {
        DataType::Utf8View => a.as_string_view().data_buffers().len(),
        DataType::BinaryView => a.as_binary_view().data_buffers().len(),
        _ => 0,
    }
}

pub fn batch_bytes(b: &RecordBatch) -> usize {
    b.columns().iter().map(|c| array_bytes(c.as_ref())).sum()
}

pub fn arrays_bytes(cols: &[ArrayRef]) -> usize {
    cols.iter().map(|c| array_bytes(c.as_ref())).sum()
}

fn pinned(buffers: &[arrow::buffer::Buffer]) -> usize {
    buffers.iter().map(|b| b.len()).sum()
}

fn wasteful(views: &[u128], buffers: &[arrow::buffer::Buffer]) -> bool {
    buffers.len() > MAX_BUFFERS || pinned(buffers) > view_data_used(views) * WASTE_FACTOR + SLACK
}

/// `a` with its strings copied into fresh buffers if it pins far more than
/// it uses, or references many buffers.
pub fn compact_array(a: &ArrayRef) -> Option<ArrayRef> {
    match a.data_type() {
        DataType::Utf8View => {
            let v = a.as_string_view();
            wasteful(v.views(), v.data_buffers()).then(|| Arc::new(v.gc()) as ArrayRef)
        }
        DataType::BinaryView => {
            let v = a.as_binary_view();
            wasteful(v.views(), v.data_buffers()).then(|| Arc::new(v.gc()) as ArrayRef)
        }
        _ => None,
    }
}

/// `b` with its wasteful view columns compacted (see [`compact_array`]).
pub fn compact(b: RecordBatch) -> Result<RecordBatch> {
    if !b.columns().iter().any(|c| matches!(c.data_type(), DataType::Utf8View | DataType::BinaryView)) {
        return Ok(b);
    }
    let mut changed = false;
    let cols: Vec<ArrayRef> = b
        .columns()
        .iter()
        .map(|c| match compact_array(c) {
            Some(x) => {
                changed = true;
                x
            }
            None => c.clone(),
        })
        .collect();
    if !changed {
        return Ok(b);
    }
    Ok(RecordBatch::try_new_with_options(b.schema(), cols, &RecordBatchOptions::new().with_row_count(Some(b.num_rows())))?)
}

/// Whether the view arrays reference many buffers, or much more buffer
/// space than they use (worth a `gc` after concatenating them).
pub fn views_wasteful(arrays: &[&dyn Array]) -> bool {
    let (mut used, mut held, mut refs) = (0usize, 0usize, 0usize);
    let mut seen = std::collections::HashSet::new();
    for a in arrays {
        let (views, buffers) = match a.data_type() {
            DataType::Utf8View => (a.as_string_view().views(), a.as_string_view().data_buffers()),
            DataType::BinaryView => (a.as_binary_view().views(), a.as_binary_view().data_buffers()),
            _ => return true,
        };
        used += view_data_used(views);
        refs += buffers.len();
        if refs > MAX_CONCAT_REFS {
            return true;
        }
        for b in buffers.iter() {
            if seen.insert(b.as_ptr() as usize) {
                held += b.len();
            }
        }
    }
    held > used + used / 4 + SLACK
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn views_count_used_bytes_and_compact_when_pinning_much_more() {
        let long: Vec<String> = (0..60_000).map(|i| format!("a string longer than twelve bytes #{i:06}")).collect();
        let a: ArrayRef = Arc::new(StringViewArray::from_iter_values(long.iter()));
        let small = a.slice(0, 10);
        // the slice pins every buffer of the whole array, but uses 10 strings
        assert!(small.get_array_memory_size() > 500_000);
        let used = array_bytes(small.as_ref());
        assert!(used < 10 * (16 + 64), "{used}");
        let taken = arrow::compute::take(&a, &UInt32Array::from(vec![1u32, 5, 9]), None).unwrap();
        let c = compact_array(&taken).expect("compacted");
        assert!(c.get_array_memory_size() < 4096);
        assert_eq!(c.as_string_view().value(1), long[5]);
        // an array using its buffers is left alone
        assert!(compact_array(&a).is_none());
        assert!(!views_wasteful(&[a.as_ref()]));
        assert!(views_wasteful(&[taken.as_ref()]));
    }

    #[test]
    fn arrays_referencing_many_buffers_are_compacted() {
        let parts: Vec<ArrayRef> =
            (0..100).map(|i| Arc::new(StringViewArray::from_iter_values([format!("long enough string number {i}")])) as ArrayRef).collect();
        let refs: Vec<&dyn Array> = parts.iter().map(|p| p.as_ref()).collect();
        assert!(!views_wasteful(&refs), "100 buffers, all used");
        let many = arrow::compute::concat(&refs).unwrap();
        assert_eq!(many.as_string_view().data_buffers().len(), 100);
        let c = compact_array(&many).expect("too many buffers");
        assert_eq!(c.as_string_view().data_buffers().len(), 1);
        let shared: Vec<&dyn Array> = (0..20).map(|_| many.as_ref()).collect();
        assert!(views_wasteful(&shared), "2000 buffer references");
    }

    #[test]
    fn primitive_and_string_slices() {
        let p: ArrayRef = Arc::new(Int64Array::from_iter_values(0..1000));
        assert_eq!(array_bytes(p.slice(10, 100).as_ref()), 800);
        let s: ArrayRef = Arc::new(StringArray::from(vec!["ab", "cde", "f"]));
        assert_eq!(array_bytes(s.slice(1, 2).as_ref()), 3 * 4 + 4);
    }
}
