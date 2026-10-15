//! `avg` over each input type, widened per element: results must be the same
//! as averaging the batch cast to Float64 (same values, same summation order).

use super::*;

fn mean_of(a: &mut dyn Accumulator, groups: usize) -> Vec<Option<f64>> {
    a.finish(groups).unwrap().as_primitive::<Float64Type>().iter().collect()
}

/// Average `col` grouped and ungrouped with the accumulator the factory picks.
fn via_factory(col: ArrayRef, gids: &[u32], groups: usize) -> (Vec<Option<f64>>, Vec<Option<f64>>) {
    let mut g = create_accumulator(AggFunc::Mean, Some(col.data_type()), false, false).unwrap();
    g.update(&[col.clone()], gids, groups).unwrap();
    let mut s = create_accumulator(AggFunc::Mean, Some(col.data_type()), false, false).unwrap();
    s.update_single(&[col], gids.len()).unwrap();
    (mean_of(g.as_mut(), groups), mean_of(s.as_mut(), 1))
}

/// The reference: cast to Float64 up front, then the Float64 accumulator.
fn reference(col: &ArrayRef, gids: &[u32], groups: usize) -> (Vec<Option<f64>>, Vec<Option<f64>>) {
    let f = cast(col, &DataType::Float64).unwrap();
    via_factory(f, gids, groups)
}

fn bits(v: &[Option<f64>]) -> Vec<Option<u64>> {
    v.iter().map(|x| x.map(f64::to_bits)).collect()
}

fn check(col: ArrayRef, gids: &[u32], groups: usize) {
    let (g, s) = via_factory(col.clone(), gids, groups);
    let (rg, rs) = reference(&col, gids, groups);
    assert_eq!(bits(&g), bits(&rg), "grouped {:?}", col.data_type());
    assert_eq!(bits(&s), bits(&rs), "ungrouped {:?}", col.data_type());
}

fn gids(n: usize, groups: u32) -> Vec<u32> {
    (0..n).map(|i| (i as u32 * 7 + 3) % groups).collect()
}

#[test]
fn integers_and_floats_match_the_cast_reference() {
    let n = 1003;
    let g = gids(n, 5);
    let big = |i: usize| (i as i64 * 1_234_567_891) % 9_007_199_254_740_993;
    check(Arc::new(Int8Array::from((0..n).map(|i| (i % 120) as i8 - 60).collect::<Vec<_>>())), &g, 5);
    check(Arc::new(Int16Array::from((0..n).map(|i| i as i16 * 31 - 9000).collect::<Vec<_>>())), &g, 5);
    check(Arc::new(Int32Array::from((0..n).map(|i| i as i32 * 99_991 - 40_000_000).collect::<Vec<_>>())), &g, 5);
    check(Arc::new(Int64Array::from((0..n).map(big).collect::<Vec<_>>())), &g, 5);
    check(Arc::new(UInt8Array::from((0..n).map(|i| (i % 256) as u8).collect::<Vec<_>>())), &g, 5);
    check(Arc::new(UInt16Array::from((0..n).map(|i| (i * 65) as u16).collect::<Vec<_>>())), &g, 5);
    check(Arc::new(UInt32Array::from((0..n).map(|i| i as u32 * 4_000_001).collect::<Vec<_>>())), &g, 5);
    check(Arc::new(UInt64Array::from((0..n).map(|i| i as u64 * 17_000_000_000_001).collect::<Vec<_>>())), &g, 5);
    check(Arc::new(Float32Array::from((0..n).map(|i| i as f32 * 0.1 - 17.3).collect::<Vec<_>>())), &g, 5);
    check(Arc::new(Float64Array::from((0..n).map(|i| i as f64 * 0.1 - 17.3).collect::<Vec<_>>())), &g, 5);
}

#[test]
fn nulls_and_empty_groups() {
    let n = 500;
    let g = gids(n, 4);
    let with_nulls: Int64Array = (0..n).map(|i| (i % 3 != 0).then_some(i as i64 * 1000)).collect();
    check(Arc::new(with_nulls), &g, 4);
    let all_null: Int32Array = (0..n).map(|_| None).collect();
    let (grouped, single) = via_factory(Arc::new(all_null), &g, 4);
    assert_eq!(grouped, vec![None; 4]);
    assert_eq!(single, vec![None]);
    // a group that no row falls in
    let col: ArrayRef = Arc::new(Int64Array::from(vec![10, 20]));
    let mut a = create_accumulator(AggFunc::Mean, Some(col.data_type()), false, false).unwrap();
    a.update(&[col], &[0, 2], 3).unwrap();
    assert_eq!(mean_of(a.as_mut(), 3), vec![Some(10.0), None, Some(20.0)]);
}

#[test]
fn averages_of_integers_are_exact_means() {
    let (g, s) = via_factory(Arc::new(Int64Array::from(vec![1, 2, 3, 4])), &[0, 0, 1, 1], 2);
    assert_eq!(g, vec![Some(1.5), Some(3.5)]);
    assert_eq!(s, vec![Some(2.5)]);
}

#[test]
fn merge_adds_partial_sums_and_counts() {
    let col: ArrayRef = Arc::new(Int32Array::from(vec![1, 2, 3, 6]));
    let mk = || create_accumulator(AggFunc::Mean, Some(&DataType::Int32), false, false).unwrap();
    let (mut a, mut b) = (mk(), mk());
    a.update(&[col.slice(0, 2)], &[0, 1], 2).unwrap();
    b.update(&[col.slice(2, 2)], &[0, 1], 2).unwrap();
    a.merge(b.as_ref(), &[0, 1], &[0, 1], 2).unwrap();
    assert_eq!(mean_of(a.as_mut(), 2), vec![Some(2.0), Some(4.0)]);
}

#[test]
fn types_without_a_direct_impl_are_cast() {
    // decimals are scaled back: 1.50 and 2.50 average to 2.0
    let ty = DataType::Decimal128(10, 2);
    let d: ArrayRef = Arc::new(Decimal128Array::from(vec![150, 250]).with_data_type(ty.clone()));
    let mut a = create_accumulator(AggFunc::Mean, Some(&ty), false, false).unwrap();
    a.update_single(&[d], 2).unwrap();
    assert_eq!(mean_of(a.as_mut(), 1), vec![Some(2.0)]);
    // a batch that is not the type the plan promised is cast
    let mut a = create_accumulator(AggFunc::Mean, Some(&DataType::Int64), false, false).unwrap();
    a.update_single(&[Arc::new(Int32Array::from(vec![4, 6]))], 2).unwrap();
    assert_eq!(mean_of(a.as_mut(), 1), vec![Some(5.0)]);
}
