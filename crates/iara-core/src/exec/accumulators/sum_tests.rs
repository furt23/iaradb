//! Integer sums that do not fit their type are errors, not wrapped values;
//! the error depends on the total only, never on the order of the rows or of
//! the partial sums. Sums that fit (and float sums) are unchanged.

use super::*;

fn ints(v: Vec<Option<i64>>) -> ArrayRef {
    Arc::new(Int64Array::from(v))
}

fn acc() -> SumAcc<Int64Type, Int64Type> {
    SumAcc::new(DataType::Int64, false)
}

fn overflow_msg(e: WhError) -> bool {
    e.to_string().contains("integer overflow in sum(...): cast to DOUBLE or DECIMAL")
}

fn finish_i64(a: &mut dyn Accumulator, n: usize) -> Result<Vec<Option<i64>>> {
    Ok(a.finish(n)?.as_primitive::<Int64Type>().iter().collect())
}

/// Sum `vals` into one group per call style and return the finished sums.
fn grouped(vals: Vec<Option<i64>>, gids: &[u32], groups: usize) -> Result<Vec<Option<i64>>> {
    let mut a = acc();
    a.update(&[ints(vals)], gids, groups)?;
    finish_i64(&mut a, groups)
}

fn ungrouped(vals: Vec<Option<i64>>) -> Result<Vec<Option<i64>>> {
    let n = vals.len();
    let mut a = acc();
    a.update_single(&[ints(vals)], n)?;
    finish_i64(&mut a, 1)
}

#[test]
fn grouped_sum_overflows() {
    let r = grouped(vec![Some(i64::MAX), Some(1), Some(5)], &[0, 0, 1], 2);
    assert!(overflow_msg(r.unwrap_err()));
    let r = grouped(vec![Some(i64::MIN), Some(-1)], &[0, 0], 1);
    assert!(overflow_msg(r.unwrap_err()));
}

#[test]
fn overflow_across_batches() {
    let mut a = acc();
    a.update(&[ints(vec![Some(i64::MAX)])], &[0], 1).unwrap();
    a.update(&[ints(vec![Some(1)])], &[0], 1).unwrap();
    assert!(overflow_msg(a.finish(1).unwrap_err()));
}

#[test]
fn grouped_sum_with_nulls() {
    let r = grouped(vec![Some(i64::MAX), None, Some(1)], &[0, 0, 0], 1);
    assert!(overflow_msg(r.unwrap_err()));
    // a null adds nothing
    assert_eq!(grouped(vec![Some(i64::MAX), None], &[0, 0], 1).unwrap(), vec![Some(i64::MAX)]);
}

#[test]
fn ungrouped_sum_overflows() {
    assert!(overflow_msg(ungrouped(vec![Some(i64::MAX), Some(1)]).unwrap_err()));
    // enough rows to go through the 4-lane loop and its remainder
    let mut vals = vec![Some(i64::MAX / 4); 9];
    vals.push(Some(7));
    assert!(overflow_msg(ungrouped(vals).unwrap_err()));
    assert!(overflow_msg(ungrouped(vec![Some(i64::MAX), None, Some(1)]).unwrap_err()));
}

#[test]
fn sums_that_fit_are_exact() {
    assert_eq!(grouped(vec![Some(i64::MAX - 10), Some(4), Some(6)], &[0, 0, 0], 1).unwrap(), vec![Some(i64::MAX)]);
    assert_eq!(ungrouped(vec![Some(i64::MIN), Some(0), Some(0), Some(i64::MAX), Some(-1)]).unwrap(), vec![Some(-2)]);
    // an intermediate sum past the range is fine when the total fits, in any order
    let wild = vec![Some(i64::MAX), Some(i64::MIN), Some(i64::MAX), Some(i64::MIN), Some(3)];
    assert_eq!(ungrouped(wild.clone()).unwrap(), vec![Some(1)]);
    assert_eq!(grouped(wild, &[0; 5], 1).unwrap(), vec![Some(1)]);
    assert_eq!(ungrouped(vec![Some(i64::MAX), Some(1), Some(-5)]).unwrap(), vec![Some(i64::MAX - 4)]);
}

#[test]
fn partial_sums_past_the_range_merge_to_a_fitting_total() {
    let (mut a, mut b) = (acc(), acc());
    a.update(&[ints(vec![Some(i64::MAX), Some(i64::MAX)])], &[0, 0], 1).unwrap();
    b.update(&[ints(vec![Some(i64::MIN), Some(i64::MIN)])], &[0, 0], 1).unwrap();
    // each partial overflows i64 on its own, the total is -2
    a.merge(&b, &[0], &[0], 1).unwrap();
    assert_eq!(finish_i64(&mut a, 1).unwrap(), vec![Some(-2)]);
}

#[test]
fn merge_overflows() {
    let (mut a, mut b) = (acc(), acc());
    a.update(&[ints(vec![Some(i64::MAX - 1), Some(1)])], &[0, 1], 2).unwrap();
    b.update(&[ints(vec![Some(5), Some(2)])], &[0, 1], 2).unwrap();
    a.merge(&b, &[0, 1], &[0, 1], 2).unwrap();
    assert!(overflow_msg(a.finish(2).unwrap_err()));
    // merging into the group that has room is fine
    let mut c = acc();
    c.update(&[ints(vec![Some(i64::MAX - 1), Some(1)])], &[0, 1], 2).unwrap();
    c.merge(&b, &[1], &[1], 2).unwrap();
    assert_eq!(finish_i64(&mut c, 2).unwrap(), vec![Some(i64::MAX - 1), Some(3)]);
}

#[test]
fn small_integer_inputs_widen() {
    let mut a = SumAcc::<Int32Type, Int64Type>::new(DataType::Int64, false);
    let v: ArrayRef = Arc::new(Int32Array::from(vec![i32::MAX; 4]));
    a.update(&[v], &[0; 4], 1).unwrap();
    assert_eq!(finish_i64(&mut a, 1).unwrap(), vec![Some(i32::MAX as i64 * 4)]);
}

#[test]
fn unsigned_overflows() {
    let mk = || SumAcc::<UInt64Type, UInt64Type>::new(DataType::UInt64, false);
    let mut a = mk();
    a.update_single(&[Arc::new(UInt64Array::from(vec![u64::MAX, 1]))], 2).unwrap();
    assert!(overflow_msg(a.finish(1).unwrap_err()));
    let mut b = mk();
    b.update_single(&[Arc::new(UInt64Array::from(vec![u64::MAX - 1, 1]))], 2).unwrap();
    assert_eq!(b.finish(1).unwrap().as_primitive::<UInt64Type>().value(0), u64::MAX);
}

#[test]
fn decimal_overflow_is_reported_as_decimal() {
    let ty = DataType::Decimal128(38, 2);
    let mut a = SumAcc::<Decimal128Type, Decimal128Type>::new(ty.clone(), false);
    let v: ArrayRef = Arc::new(Decimal128Array::from(vec![i128::MAX, 1]).with_data_type(ty));
    let err = a.update_single(&[v], 2).unwrap_err().to_string();
    assert!(err.contains("decimal overflow in sum(...): cast to DOUBLE or DECIMAL"), "{err}");
}

#[test]
fn float_sums_never_fail() {
    let mut a = SumAcc::<Float64Type, Float64Type>::new(DataType::Float64, false);
    let v: ArrayRef = Arc::new(Float64Array::from(vec![f64::MAX, f64::MAX, 1.5]));
    a.update(&[v.clone()], &[0, 0, 1], 2).unwrap();
    let out = a.finish(2).unwrap();
    let out = out.as_primitive::<Float64Type>();
    assert_eq!(out.value(0), f64::INFINITY);
    assert_eq!(out.value(1), 1.5);
    let mut b = SumAcc::<Float64Type, Float64Type>::new(DataType::Float64, false);
    b.update_single(&[v], 3).unwrap();
    assert_eq!(b.finish(1).unwrap().as_primitive::<Float64Type>().value(0), f64::INFINITY);
}

#[test]
fn sum_distinct_overflows() {
    let mut a = SumDistinctAcc::try_new(&DataType::Int64).unwrap();
    a.update(&[ints(vec![Some(i64::MAX), Some(1), Some(1)])], &[0, 0, 0], 1).unwrap();
    assert!(overflow_msg(a.finish(1).unwrap_err()));
    // a repeated value counts once, so this fits
    let mut b = SumDistinctAcc::try_new(&DataType::Int64).unwrap();
    b.update(&[ints(vec![Some(i64::MAX - 1), Some(1), Some(1), Some(1)])], &[0; 4], 1).unwrap();
    assert_eq!(finish_i64(&mut b, 1).unwrap(), vec![Some(i64::MAX)]);
    // a u64 that does not fit an i64 is an error, not a skipped value
    let mut c = SumDistinctAcc::try_new(&DataType::UInt64).unwrap();
    let big: ArrayRef = Arc::new(UInt64Array::from(vec![u64::MAX]));
    assert!(overflow_msg(c.update(&[big], &[0], 1).unwrap_err()));
}
