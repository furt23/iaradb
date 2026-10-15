//! `DepStore::check` on group ids that do not arrive as dense ids in
//! first-occurrence order: it answers false (the caller re-keys), never panics.

use std::sync::Arc;

use super::*;

fn ints(v: Vec<i64>) -> ArrayRef {
    Arc::new(Int64Array::from(v))
}

fn strs(v: Vec<&str>) -> ArrayRef {
    Arc::new(StringArray::from(v))
}

fn bools(v: Vec<bool>) -> ArrayRef {
    Arc::new(BooleanArray::from(v))
}

#[test]
fn dense_ids_in_order_pass() {
    for (dt, col) in [(DataType::Int64, ints(vec![7, 7, 8, 7])), (DataType::Utf8, strs(vec!["a", "a", "b", "a"])), (DataType::Boolean, bools(vec![true, true, false, true]))] {
        let mut s = DepStore::new(&dt).unwrap();
        assert!(s.check(&col, &[0, 0, 1, 0]), "{dt}");
        // the next batch repeats the same groups and adds one
        let next = match dt {
            DataType::Int64 => ints(vec![8, 9]),
            DataType::Utf8 => strs(vec!["b", "c"]),
            _ => bools(vec![false, true]),
        };
        if dt != DataType::Boolean {
            assert!(s.check(&next, &[1, 2]), "{dt}");
        }
    }
}

#[test]
fn a_changed_value_fails() {
    let mut s = DepStore::new(&DataType::Int64).unwrap();
    assert!(s.check(&ints(vec![1, 2]), &[0, 1]));
    assert!(!s.check(&ints(vec![1, 3]), &[0, 1]));
}

#[test]
fn an_id_past_the_next_one_fails_instead_of_panicking() {
    // group 5 shows up while only group 0 exists
    let mut s = DepStore::new(&DataType::Int64).unwrap();
    assert!(!s.check(&ints(vec![1, 1]), &[0, 5]));
    let mut s = DepStore::new(&DataType::Int64).unwrap();
    assert!(!s.check(&ints(vec![1]), &[3]));

    let mut s = DepStore::new(&DataType::Utf8).unwrap();
    assert!(!s.check(&strs(vec!["a", "b"]), &[0, 2]));
    let mut s = DepStore::new(&DataType::Utf8).unwrap();
    assert!(!s.check(&strs(vec!["a"]), &[4]));

    let mut s = DepStore::new(&DataType::Boolean).unwrap();
    assert!(!s.check(&bools(vec![true, false]), &[0, 9]));
    let mut s = DepStore::new(&DataType::Boolean).unwrap();
    assert!(!s.check(&bools(vec![true]), &[1]));
}

#[test]
fn an_id_past_the_next_one_fails_with_nulls() {
    let mut s = DepStore::new(&DataType::Int64).unwrap();
    let col: ArrayRef = Arc::new(Int64Array::from(vec![Some(1), None]));
    assert!(!s.check(&col, &[0, 2]));
}
