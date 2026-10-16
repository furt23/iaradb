//! Row accumulators alone and side by side in an `AccSet` give the same
//! results; decimal averages stay exact until the final division.

use super::*;
use crate::exec::accumulators::{create_accumulator, create_row_accumulator};
use crate::expr::AggFunc;

fn dec(v: Vec<Option<i128>>) -> ArrayRef {
    Arc::new(Decimal128Array::from(v).with_precision_and_scale(15, 2).unwrap())
}

fn ints(v: Vec<Option<i64>>) -> ArrayRef {
    Arc::new(Int64Array::from(v))
}

#[test]
fn decimal_means_grouped_single_and_merged() {
    let mut a = create_accumulator(AggFunc::Mean, Some(&DataType::Decimal128(15, 2)), false).unwrap();
    a.update(&[dec(vec![Some(100), Some(300), None, Some(-50)])], &[0, 0, 1, 1], 3).unwrap();
    let mut b = create_accumulator(AggFunc::Mean, Some(&DataType::Decimal128(15, 2)), false).unwrap();
    b.update_single(&[dec(vec![Some(1), Some(2), Some(3), Some(4), Some(5)])], 5).unwrap();
    a.merge(b.as_ref(), &[0], &[1], 3).unwrap();
    let r = a.finish(3).unwrap();
    let r = r.as_primitive::<Float64Type>();
    assert_eq!(r.value(0), 2.0);
    assert!((r.value(1) - (-50.0 + 15.0) / 100.0 / 6.0).abs() < 1e-12);
    assert!(r.is_null(2));
}

#[test]
fn min_max_skip_nulls_and_leave_empty_groups_null() {
    for (func, want) in [(AggFunc::Min, [Some(-3), Some(7), None]), (AggFunc::Max, [Some(5), Some(7), None])] {
        let mut a = create_accumulator(func, Some(&DataType::Int64), false).unwrap();
        a.update(&[ints(vec![Some(5), None, Some(-3), Some(7)])], &[0, 1, 0, 1], 3).unwrap();
        let got: Vec<_> = a.finish(3).unwrap().as_primitive::<Int64Type>().iter().collect();
        assert_eq!(got, want);
    }
    let mut a = create_accumulator(AggFunc::Max, Some(&DataType::Decimal128(15, 2)), false).unwrap();
    a.update(&[dec(vec![Some(i128::MAX / 2), Some(-1), None])], &[0, 0, 1], 2).unwrap();
    let out = a.finish(2).unwrap();
    let got: Vec<_> = out.as_primitive::<Decimal128Type>().iter().collect();
    assert_eq!(got, vec![Some(i128::MAX / 2), None]);
}

/// count(*), sum(x) FILTER (x > 0), min(x), avg(x) over shared rows, and
/// array_agg-like state of its own in between.
fn set() -> AccSet {
    let row = |f| AccPart::Row(create_row_accumulator(f, Some(&DataType::Int64), false).unwrap());
    AccSet::new(vec![
        AccPart::Row(create_row_accumulator(AggFunc::Count, None, false).unwrap()),
        row(AggFunc::Sum),
        AccPart::Own(create_accumulator(AggFunc::Median, Some(&DataType::Int64), false).unwrap()),
        row(AggFunc::Min),
        row(AggFunc::Mean),
    ])
}

fn inputs(x: &ArrayRef) -> Vec<AccInput> {
    let positive: ArrayRef = Arc::new(arrow::compute::kernels::cmp::gt(x, &Int64Array::new_scalar(0)).unwrap());
    vec![(vec![], None), (vec![x.clone()], Some(positive)), (vec![x.clone()], None), (vec![x.clone()], None), (vec![x.clone()], None)]
}

#[test]
fn shared_rows_match_separate_accumulators() {
    let x = ints(vec![Some(4), Some(-2), None, Some(10), Some(6), Some(-8)]);
    let gids = [0, 0, 1, 1, 2, 2];
    let (left, right) = ((x.slice(0, 3), &gids[..3]), (x.slice(3, 3), &gids[3..]));
    // two tables merged, one group (3) that no row reaches
    let mut a = set();
    a.update(&inputs(&left.0), left.1, 4).unwrap();
    let mut b = set();
    b.update(&inputs(&right.0), right.1, 3).unwrap();
    a.merge(&b, &[0, 1, 2], &[0, 1, 2], 4).unwrap();
    let out = a.finish(4).unwrap();

    assert_eq!(out[0].as_primitive::<Int64Type>().values().to_vec(), vec![2, 2, 2, 0]);
    let sums: Vec<_> = out[1].as_primitive::<Int64Type>().iter().collect();
    assert_eq!(sums, vec![Some(4), Some(10), Some(6), None]);
    let medians: Vec<_> = out[2].as_primitive::<Float64Type>().iter().collect();
    assert_eq!(medians, vec![Some(1.0), Some(10.0), Some(-1.0), None]);
    let mins: Vec<_> = out[3].as_primitive::<Int64Type>().iter().collect();
    assert_eq!(mins, vec![Some(-2), Some(10), Some(-8), None]);
    let means: Vec<_> = out[4].as_primitive::<Float64Type>().iter().collect();
    assert_eq!(means, vec![Some(1.0), Some(10.0), Some(-1.0), None]);

    // the same through accumulators with rows of their own
    for (i, f) in [(1, AggFunc::Sum), (3, AggFunc::Min), (4, AggFunc::Mean)] {
        let mut own = create_accumulator(f, Some(&DataType::Int64), false).unwrap();
        let (vals, g): (Vec<ArrayRef>, Vec<u32>) = if f == AggFunc::Sum {
            (vec![ints(vec![Some(4), Some(10), Some(6)])], vec![0, 1, 2])
        } else {
            (vec![x.clone()], gids.to_vec())
        };
        own.update(&vals, &g, 4).unwrap();
        assert_eq!(&own.finish(4).unwrap(), &out[i], "{f:?}");
    }
}

#[test]
fn global_aggregation_folds_everything_into_one_row() {
    let x = ints(vec![Some(1), Some(2), None, Some(3), Some(4), Some(5), Some(-6)]);
    let mut a = set();
    a.update_single(&inputs(&x), 7).unwrap();
    let out = a.finish(1).unwrap();
    assert_eq!(out[0].as_primitive::<Int64Type>().value(0), 7);
    assert_eq!(out[1].as_primitive::<Int64Type>().value(0), 15);
    assert_eq!(out[3].as_primitive::<Int64Type>().value(0), -6);
    assert_eq!(out[4].as_primitive::<Float64Type>().value(0), 9.0 / 6.0);
}
