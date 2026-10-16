//! `DepRecords::check`: dense ids in first-occurrence order pass, a changed
//! value or an id that skips ahead fails (the caller re-keys), never panics;
//! view arrays sharing buffers are compared by view.

use std::sync::Arc;

use super::dep::DepRecords;
use super::*;

fn ints(v: Vec<i64>) -> ArrayRef {
    Arc::new(Int64Array::from(v))
}

fn strs(v: Vec<&str>) -> ArrayRef {
    Arc::new(StringArray::from(v))
}

fn views(v: Vec<Option<&str>>) -> ArrayRef {
    Arc::new(StringViewArray::from(v))
}

fn bools(v: Vec<bool>) -> ArrayRef {
    Arc::new(BooleanArray::from(v))
}

/// Check `col` as the only dependent field; groups from `before` on are new.
fn check(recs: &mut DepRecords, col: &ArrayRef, gids: &[u32], before: usize) -> bool {
    recs.grow_to(gids.iter().map(|&g| g as usize + 1).max().unwrap_or(0).max(before));
    recs.check(0, col, gids, before)
}

#[test]
fn dense_ids_in_order_pass() {
    for (dt, col) in [
        (DataType::Int64, ints(vec![7, 7, 8, 7])),
        (DataType::Utf8, strs(vec!["a", "a", "b", "a"])),
        (DataType::Boolean, bools(vec![true, true, false, true])),
    ] {
        let mut s = DepRecords::new(std::slice::from_ref(&dt));
        assert!(check(&mut s, &col, &[0, 0, 1, 0], 0), "{dt}");
        // the next batch repeats a group and adds one
        let next = match dt {
            DataType::Int64 => ints(vec![8, 9]),
            DataType::Utf8 => strs(vec!["b", "c"]),
            _ => bools(vec![false, true]),
        };
        assert!(check(&mut s, &next, &[1, 2], 2), "{dt}");
        assert_eq!(s.values(0, 3).unwrap().len(), 3);
    }
}

#[test]
fn a_changed_value_fails() {
    let mut s = DepRecords::new(&[DataType::Int64]);
    assert!(check(&mut s, &ints(vec![1, 2]), &[0, 1], 0));
    assert!(!check(&mut s, &ints(vec![1, 3]), &[0, 1], 2));
}

#[test]
fn an_id_past_the_next_one_fails_instead_of_panicking() {
    for (dt, col) in [
        (DataType::Int64, ints(vec![1, 1])),
        (DataType::Utf8, strs(vec!["a", "b"])),
        (DataType::Boolean, bools(vec![true, false])),
    ] {
        // group 5 shows up while only group 0 exists
        let mut s = DepRecords::new(std::slice::from_ref(&dt));
        assert!(!check(&mut s, &col, &[0, 5], 0), "{dt}");
        let mut s = DepRecords::new(std::slice::from_ref(&dt));
        assert!(!check(&mut s, &col.slice(0, 1), &[3], 0), "{dt}");
    }
    // ids beyond the records' room fail as well
    let mut s = DepRecords::new(&[DataType::Int64]);
    s.grow_to(1);
    assert!(!s.check(0, &ints(vec![1, 1]), &[0, 1], 0));
}

#[test]
fn an_id_past_the_next_one_fails_with_nulls() {
    let mut s = DepRecords::new(&[DataType::Int64]);
    let col: ArrayRef = Arc::new(Int64Array::from(vec![Some(1), None]));
    assert!(!check(&mut s, &col, &[0, 2], 0));
}

#[test]
fn nulls_are_values_of_their_own() {
    let mut s = DepRecords::new(&[DataType::Int64]);
    let col: ArrayRef = Arc::new(Int64Array::from(vec![Some(1), None, Some(1), None]));
    assert!(check(&mut s, &col, &[0, 1, 0, 1], 0));
    // a group whose value was null gets a value, and the other way around
    assert!(!check(&mut s, &ints(vec![5]), &[1], 2));
    let nul: ArrayRef = Arc::new(Int64Array::from(vec![None::<i64>]));
    assert!(!check(&mut s, &nul, &[0], 2));
    let out = s.values(0, 2).unwrap();
    assert_eq!(out.as_primitive::<Int64Type>().iter().collect::<Vec<_>>(), vec![Some(1), None]);
}

#[test]
fn long_and_short_strings_round_trip() {
    for col in [
        strs(vec!["a customer name", "x", "another long string", "a customer name"]),
        views(vec![Some("a customer name"), Some("x"), Some("another long string"), Some("a customer name")]),
    ] {
        let dt = col.data_type().clone();
        let mut s = DepRecords::new(std::slice::from_ref(&dt));
        assert!(check(&mut s, &col, &[0, 1, 2, 0], 0), "{dt}");
        assert!(!check(&mut s, &col.slice(1, 1), &[0], 3), "{dt}");
        let out = s.values(0, 3).unwrap();
        let out = arrow::compute::cast(&out, &DataType::Utf8).unwrap();
        let got: Vec<_> = out.as_string::<i32>().iter().collect();
        assert_eq!(got, vec![Some("a customer name"), Some("x"), Some("another long string")], "{dt}");
    }
}

#[test]
fn views_into_the_same_buffers_compare_by_view() {
    // a dimension's column gathered by a join: rows share the build side's buffers
    let dim = views(vec![Some("customer number one"), Some("customer number two"), Some("customer number one")]);
    let gathered = |idx: Vec<u32>| arrow::compute::take(&dim, &UInt32Array::from(idx), None).unwrap();
    let mut s = DepRecords::new(&[DataType::Utf8View]);
    assert!(check(&mut s, &gathered(vec![0, 1, 0, 1]), &[0, 1, 0, 1], 0));
    // a concatenation repeats the buffers: still found by address
    let cat = arrow::compute::concat(&[gathered(vec![1]).as_ref(), gathered(vec![0]).as_ref()]).unwrap();
    assert!(check(&mut s, &cat, &[1, 0], 2));
    // an equal string at another position of the same buffers, and in other buffers
    assert!(check(&mut s, &gathered(vec![2]), &[0], 2));
    assert!(check(&mut s, &views(vec![Some("customer number two")]), &[1], 2));
    // a different string fails
    assert!(!check(&mut s, &gathered(vec![1]), &[0], 2));
    let out = s.values(0, 2).unwrap();
    let got: Vec<_> = out.as_string_view().iter().collect();
    assert_eq!(got, vec![Some("customer number one"), Some("customer number two")]);
}

#[test]
fn group_keys_rekey_when_a_dependency_breaks() {
    let types = [DataType::Int64, DataType::Utf8View];
    let mut keys = GroupKeys::try_new(&types).unwrap();
    let mut ids = vec![];
    keys.intern(&[ints(vec![1, 2, 1]), views(vec![Some("same name for one"), Some("b"), Some("same name for one")])], &mut ids)
        .unwrap();
    assert_eq!(ids, vec![0, 1, 0]);
    assert_eq!(keys.lead(), Some(0));
    // id 1 with another name: the key is no longer dependent on the id
    keys.intern(&[ints(vec![1, 3]), views(vec![Some("other name for one"), Some("c")])], &mut ids).unwrap();
    assert_eq!(ids, vec![2, 3]);
    assert_eq!(keys.lead(), None);
    let out = keys.emit().unwrap();
    assert_eq!(out[0].as_primitive::<Int64Type>().values().to_vec(), vec![1, 2, 1, 3]);
    let names: Vec<_> = out[1].as_string_view().iter().map(|v| v.unwrap().to_string()).collect();
    assert_eq!(names, vec!["same name for one", "b", "other name for one", "c"]);
}
