//! `null_as_false` on masks sliced to a non-zero bit offset: the values and
//! the validity are combined with their offsets honoured, and the result
//! starts at row 0 of the slice.

use arrow::array::{Array, BooleanArray};

use super::null_as_false;

fn mask(n: usize) -> BooleanArray {
    (0..n)
        .map(|i| match i % 5 {
            0 => None,
            1 | 2 => Some(true),
            _ => Some(i % 2 == 0),
        })
        .collect()
}

fn expected(m: &BooleanArray) -> Vec<bool> {
    (0..m.len()).map(|i| m.is_valid(i) && m.value(i)).collect()
}

fn got(m: &BooleanArray) -> Vec<bool> {
    let out = null_as_false(m);
    assert_eq!(out.null_count(), 0);
    (0..out.len()).map(|i| out.value(i)).collect()
}

#[test]
fn unsliced_mask() {
    let m = mask(70);
    assert_eq!(got(&m), expected(&m));
}

#[test]
fn sliced_masks_with_nulls() {
    let m = mask(130);
    for (offset, len) in [(1, 20), (3, 60), (7, 9), (8, 64), (13, 100), (65, 65)] {
        let s = m.slice(offset, len);
        let s = s.as_any().downcast_ref::<BooleanArray>().unwrap();
        assert!(s.null_count() > 0);
        assert_eq!(got(s), expected(s), "slice({offset}, {len})");
        // and the same rows taken from the unsliced mask
        let from_whole: Vec<bool> = (offset..offset + len).map(|i| m.is_valid(i) && m.value(i)).collect();
        assert_eq!(got(s), from_whole, "slice({offset}, {len})");
    }
}

#[test]
fn sliced_masks_without_nulls() {
    let m: BooleanArray = (0..100).map(|i| Some(i % 3 == 0)).collect();
    let s = m.slice(5, 50);
    let s = s.as_any().downcast_ref::<BooleanArray>().unwrap();
    assert_eq!(got(s), (5..55).map(|i| i % 3 == 0).collect::<Vec<_>>());
}
