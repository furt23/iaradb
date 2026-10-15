//! Decimal `+`, `-` and `*` as plain i128 arithmetic.
//!
//! Arrow's decimal kernels check every operation for overflow (an i128
//! `checked_mul` is a library call), which made decimal expressions the
//! slowest part of queries like TPC-H Q1. Here the magnitudes of a batch's
//! operands are measured first (one cheap pass); when they show that no
//! result can overflow, the operation runs unchecked and vectorised.
//! Otherwise `None` is returned and Arrow's kernel decides (and reports any
//! overflow). Result types follow Arrow's rules exactly.

use std::sync::Arc;

use arrow::array::*;
use arrow::compute::{binary, unary};
use arrow::datatypes::{DataType, Decimal128Type};

use crate::error::Result;
use crate::expr::Operator;
use crate::physical::expr::ColumnarValue;

const MAX_PRECISION: u8 = 38;
const MAX_SCALE: i8 = 38;

/// One operand: a column's values, or a single (non-null) value.
enum Operand<'a> {
    Array(&'a Decimal128Array),
    Scalar(i128),
}

impl Operand<'_> {
    /// Bits of the largest magnitude (`|v| < 2^bits`).
    fn bits(&self) -> u32 {
        match self {
            Operand::Array(a) => {
                // v ^ (v >> 127) is v for v >= 0 and -v-1 for v < 0; OR-ing
                // them keeps every bit any magnitude needs. Null slots are
                // included (their values only make the bound looser).
                let acc = a.values().iter().fold(0u128, |acc, &v| acc | (v ^ (v >> 127)) as u128);
                128 - acc.leading_zeros()
            }
            Operand::Scalar(v) => 128 - (*v ^ (*v >> 127)).leading_zeros(),
        }
    }
}

fn operand(v: &ColumnarValue) -> Option<(Operand<'_>, u8, i8)> {
    let (p, s) = match v.data_type() {
        DataType::Decimal128(p, s) => (*p, *s),
        _ => return None,
    };
    let op = match v {
        ColumnarValue::Array(a) => Operand::Array(a.as_primitive::<Decimal128Type>()),
        ColumnarValue::Scalar(sc) => {
            let a = sc.array();
            if a.is_null(0) {
                return None;
            }
            Operand::Scalar(a.as_primitive::<Decimal128Type>().value(0))
        }
    };
    Some((op, p, s))
}

/// Bits of `10^k` (an upper bound of the magnitude a rescale multiplies by).
fn pow10_bits(k: i8) -> Option<u32> {
    let m = 10i128.checked_pow(k as u32)?;
    Some(128 - m.leading_zeros())
}

/// `l op r` for two decimals when it provably cannot overflow (`None`: use
/// Arrow's checked kernel). At least one side must be an array.
pub fn try_eval(op: Operator, l: &ColumnarValue, r: &ColumnarValue) -> Result<Option<ArrayRef>> {
    if l.is_scalar() && r.is_scalar() {
        return Ok(None);
    }
    let (Some((lo, p1, s1)), Some((ro, p2, s2))) = (operand(l), operand(r)) else {
        return Ok(None);
    };
    let (bl, br) = (lo.bits(), ro.bits());
    let out = match op {
        Operator::Plus | Operator::Minus => {
            let scale = s1.max(s2);
            let precision = (scale.saturating_add((p1 as i8 - s1).max(p2 as i8 - s2)) as u8).saturating_add(1).min(MAX_PRECISION);
            let (Some(lm_bits), Some(rm_bits)) = (pow10_bits(scale - s1), pow10_bits(scale - s2)) else {
                return Ok(None);
            };
            // each rescaled term below 2^125: their sum or difference fits an i128
            if bl + lm_bits > 125 || br + rm_bits > 125 {
                return Ok(None);
            }
            let (lm, rm) = (10i128.pow((scale - s1) as u32), 10i128.pow((scale - s2) as u32));
            let res = if op == Operator::Plus {
                apply(&lo, &ro, lm, rm, |a, b| a.wrapping_add(b))
            } else {
                apply(&lo, &ro, lm, rm, |a, b| a.wrapping_sub(b))
            }?;
            res.with_precision_and_scale(precision, scale)?
        }
        Operator::Multiply => {
            let precision = p1.saturating_add(p2 + 1).min(MAX_PRECISION);
            let scale = s1.saturating_add(s2);
            if scale > MAX_SCALE || bl + br > 126 {
                return Ok(None);
            }
            apply(&lo, &ro, 1, 1, |a, b| a.wrapping_mul(b))?.with_precision_and_scale(precision, scale)?
        }
        _ => return Ok(None),
    };
    Ok(Some(Arc::new(out)))
}

/// `f(l * lm, r * rm)` over the operands (`lm`, `rm` are rescale factors).
fn apply(l: &Operand<'_>, r: &Operand<'_>, lm: i128, rm: i128, f: impl Fn(i128, i128) -> i128) -> Result<Decimal128Array> {
    // separate loops for the unscaled case keep the hot ones free of multiplies
    let scaled = lm != 1 || rm != 1;
    Ok(match (l, r) {
        (Operand::Array(a), Operand::Array(b)) if scaled => binary(*a, *b, |x, y| f(x.wrapping_mul(lm), y.wrapping_mul(rm)))?,
        (Operand::Array(a), Operand::Array(b)) => binary(*a, *b, &f)?,
        (Operand::Array(a), Operand::Scalar(y)) => {
            let y = y.wrapping_mul(rm);
            if lm != 1 { unary(*a, |x| f(x.wrapping_mul(lm), y)) } else { unary(*a, |x| f(x, y)) }
        }
        (Operand::Scalar(x), Operand::Array(b)) => {
            let x = x.wrapping_mul(lm);
            if rm != 1 { unary(*b, |y| f(x, y.wrapping_mul(rm))) } else { unary(*b, |y| f(x, y)) }
        }
        (Operand::Scalar(_), Operand::Scalar(_)) => unreachable!("scalar pairs are folded by Arrow"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scalar::Scalar;
    use arrow::compute::kernels::numeric;

    fn dec(vals: &[Option<i128>], p: u8, s: i8) -> ColumnarValue {
        ColumnarValue::Array(Arc::new(Decimal128Array::from(vals.to_vec()).with_precision_and_scale(p, s).unwrap()))
    }

    fn dec_scalar(v: i128, p: u8, s: i8) -> ColumnarValue {
        ColumnarValue::Scalar(Scalar::decimal128(v, p, s).unwrap())
    }

    fn arrow_result(op: Operator, l: &ColumnarValue, r: &ColumnarValue) -> ArrayRef {
        match op {
            Operator::Plus => numeric::add_wrapping(l, r).unwrap(),
            Operator::Minus => numeric::sub_wrapping(l, r).unwrap(),
            Operator::Multiply => numeric::mul_wrapping(l, r).unwrap(),
            _ => unreachable!(),
        }
    }

    #[test]
    fn matches_arrow_values_and_types() {
        let a = dec(&[Some(12345), Some(-5), None, Some(0), Some(99_999_999_999)], 15, 2);
        let b = dec(&[Some(7), Some(-300), Some(1), None, Some(4)], 10, 4);
        let one = dec_scalar(100, 3, 2);
        for op in [Operator::Plus, Operator::Minus, Operator::Multiply] {
            for (l, r) in [(&a, &b), (&b, &a), (&a, &one), (&one, &b), (&a, &a)] {
                let fast = try_eval(op, l, r).unwrap().expect("fast path");
                let want = arrow_result(op, l, r);
                assert_eq!(fast.data_type(), want.data_type(), "{op:?}");
                assert_eq!(fast.as_ref(), want.as_ref(), "{op:?}");
            }
        }
    }

    #[test]
    fn possible_overflow_falls_back() {
        let big = dec(&[Some(i128::MAX / 3), Some(1)], 38, 0);
        let two = dec(&[Some(4), Some(4)], 38, 0);
        assert!(try_eval(Operator::Multiply, &big, &two).unwrap().is_none());
        assert!(try_eval(Operator::Plus, &big, &big).unwrap().is_none());
        // rescaling by 10^20 could overflow too
        let wide = dec(&[Some(10i128.pow(30))], 38, 0);
        let scaled = dec(&[Some(1)], 38, 20);
        assert!(try_eval(Operator::Plus, &wide, &scaled).unwrap().is_none());
        assert!(try_eval(Operator::Plus, &dec(&[Some(1)], 5, 0), &scaled).unwrap().is_some());
    }

    #[test]
    fn negative_magnitudes_are_bounded() {
        let a = dec(&[Some(-(1i128 << 62))], 38, 0);
        let b = dec(&[Some(-(1i128 << 62))], 38, 0);
        let r = try_eval(Operator::Multiply, &a, &b).unwrap().unwrap();
        assert_eq!(r.as_primitive::<Decimal128Type>().value(0), 1i128 << 124);
        let c = dec(&[Some(i128::MIN + 1)], 38, 0);
        assert!(try_eval(Operator::Multiply, &c, &dec(&[Some(2)], 38, 0)).unwrap().is_none());
    }
}
