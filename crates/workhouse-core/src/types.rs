//! Type coercion rules shared by logical type inference and physical planning.

use arrow::array::new_empty_array;
use arrow::compute::kernels::numeric;
use arrow::datatypes::{DataType, TimeUnit};

use crate::error::{Result, WhError};
use crate::expr::Operator;
use crate::scalar::Scalar;

pub fn is_string(dt: &DataType) -> bool {
    matches!(dt, DataType::Utf8 | DataType::LargeUtf8 | DataType::Utf8View)
}

pub fn is_integer(dt: &DataType) -> bool {
    dt.is_integer()
}

pub fn is_float(dt: &DataType) -> bool {
    matches!(dt, DataType::Float16 | DataType::Float32 | DataType::Float64)
}

pub fn is_decimal(dt: &DataType) -> bool {
    matches!(dt, DataType::Decimal128(_, _) | DataType::Decimal256(_, _))
}

pub fn is_numeric(dt: &DataType) -> bool {
    is_integer(dt) || is_float(dt) || is_decimal(dt)
}

pub fn is_temporal(dt: &DataType) -> bool {
    dt.is_temporal()
}

fn int_rank(dt: &DataType) -> (bool, u8) {
    match dt {
        DataType::Int8 => (true, 1),
        DataType::Int16 => (true, 2),
        DataType::Int32 => (true, 4),
        DataType::Int64 => (true, 8),
        DataType::UInt8 => (false, 1),
        DataType::UInt16 => (false, 2),
        DataType::UInt32 => (false, 4),
        DataType::UInt64 => (false, 8),
        _ => (true, 8),
    }
}

/// Number of decimal digits needed to represent an integer type.
pub fn int_decimal_precision(dt: &DataType) -> u8 {
    match dt {
        DataType::Int8 | DataType::UInt8 => 3,
        DataType::Int16 | DataType::UInt16 => 5,
        DataType::Int32 | DataType::UInt32 => 10,
        DataType::Int64 => 19,
        _ => 20,
    }
}

fn common_decimal(p1: u8, s1: i8, p2: u8, s2: i8) -> DataType {
    let s = s1.max(s2);
    let int_digits = (p1 as i16 - s1 as i16).max(p2 as i16 - s2 as i16);
    let p = (int_digits + s as i16).clamp(1, 38) as u8;
    DataType::Decimal128(p, s)
}

fn as_decimal(dt: &DataType) -> Option<(u8, i8)> {
    match dt {
        DataType::Decimal128(p, s) => Some((*p, *s)),
        dt if is_integer(dt) => Some((int_decimal_precision(dt), 0)),
        _ => None,
    }
}

/// Common numeric type used for comparisons and arithmetic.
pub fn numeric_common(a: &DataType, b: &DataType) -> Option<DataType> {
    use DataType::*;
    if a == b {
        return Some(a.clone());
    }
    if !is_numeric(a) || !is_numeric(b) {
        return None;
    }
    if is_float(a) || is_float(b) {
        return Some(Float64);
    }
    if is_decimal(a) || is_decimal(b) {
        let (p1, s1) = as_decimal(a)?;
        let (p2, s2) = as_decimal(b)?;
        return Some(common_decimal(p1, s1, p2, s2));
    }
    // both integers
    let (sa, wa) = int_rank(a);
    let (sb, wb) = int_rank(b);
    let w = wa.max(wb);
    Some(match (sa && sb, !sa && !sb) {
        (true, _) => match w {
            1 => Int8,
            2 => Int16,
            4 => Int32,
            _ => Int64,
        },
        (_, true) => match w {
            1 => UInt8,
            2 => UInt16,
            4 => UInt32,
            _ => UInt64,
        },
        _ => {
            // mixed sign: smallest signed type that holds both
            let unsigned_w = if sa { wb } else { wa };
            let need = if unsigned_w >= w { (unsigned_w * 2).min(8) } else { w };
            match need {
                1 | 2 => Int16,
                4 => Int32,
                _ => Int64,
            }
        }
    })
}

fn string_common(a: &DataType, b: &DataType) -> DataType {
    use DataType::*;
    if matches!(a, Utf8View) || matches!(b, Utf8View) {
        Utf8View
    } else if matches!(a, LargeUtf8) || matches!(b, LargeUtf8) {
        LargeUtf8
    } else {
        Utf8
    }
}

/// Common type for comparison / CASE / COALESCE / UNION.
pub fn comparison_common(a: &DataType, b: &DataType) -> Option<DataType> {
    use DataType::*;
    if a == b {
        return Some(a.clone());
    }
    match (a, b) {
        (Null, x) | (x, Null) => Some(x.clone()),
        (x, y) if is_numeric(x) && is_numeric(y) => numeric_common(x, y),
        (x, y) if is_string(x) && is_string(y) => Some(string_common(x, y)),
        (x, y) if is_string(x) && is_temporal(y) => Some(y.clone()),
        (x, y) if is_temporal(x) && is_string(y) => Some(x.clone()),
        (Date32, Timestamp(u, tz)) | (Timestamp(u, tz), Date32) => Some(Timestamp(*u, tz.clone())),
        (Date32, Date64) | (Date64, Date32) => Some(Date64),
        (Timestamp(u1, tz), Timestamp(u2, _)) => {
            let unit = if matches!(u1, TimeUnit::Nanosecond) || matches!(u2, TimeUnit::Nanosecond) {
                TimeUnit::Nanosecond
            } else {
                TimeUnit::Microsecond
            };
            Some(Timestamp(unit, tz.clone()))
        }
        (Boolean, Boolean) => Some(Boolean),
        (Dictionary(_, v), other) | (other, Dictionary(_, v)) => comparison_common(v, other),
        _ => None,
    }
}

pub fn common_supertype<'a>(types: impl IntoIterator<Item = &'a DataType>) -> Option<DataType> {
    let mut acc: Option<DataType> = None;
    for t in types {
        acc = Some(match acc {
            None => t.clone(),
            Some(a) => comparison_common(&a, t)?,
        });
    }
    acc
}

#[derive(Debug, Clone)]
pub struct BinarySig {
    pub left: DataType,
    pub right: DataType,
    pub result: DataType,
}

fn arith_result(op: Operator, l: &DataType, r: &DataType) -> Result<DataType> {
    let a = new_empty_array(l);
    let b = new_empty_array(r);
    let res = match op {
        Operator::Plus => numeric::add_wrapping(&a, &b),
        Operator::Minus => numeric::sub_wrapping(&a, &b),
        Operator::Multiply => numeric::mul_wrapping(&a, &b),
        Operator::Divide => numeric::div(&a, &b),
        Operator::Modulo => numeric::rem(&a, &b),
        _ => unreachable!(),
    };
    res.map(|a| a.data_type().clone()).map_err(|e| {
        WhError::Plan(format!("cannot apply '{}' to {l} and {r}: {e}", op.symbol()))
    })
}

/// Determine the operand casts and the result type of a binary operation.
pub fn binary_signature(op: Operator, lt: &DataType, rt: &DataType) -> Result<BinarySig> {
    use DataType::*;
    let sig = |l: DataType, r: DataType, res: DataType| Ok(BinarySig { left: l, right: r, result: res });
    match op {
        Operator::And | Operator::Or => {
            for t in [lt, rt] {
                if !matches!(t, Boolean | Null) {
                    return Err(WhError::Plan(format!(
                        "logical operator '{}' requires boolean operands, got {t}",
                        op.symbol()
                    )));
                }
            }
            sig(Boolean, Boolean, Boolean)
        }
        Operator::Eq
        | Operator::NotEq
        | Operator::Lt
        | Operator::LtEq
        | Operator::Gt
        | Operator::GtEq => {
            let c = comparison_common(lt, rt).ok_or_else(|| {
                WhError::Plan(format!("cannot compare {lt} with {rt}"))
            })?;
            sig(c.clone(), c, Boolean)
        }
        Operator::StringConcat => sig(Utf8, Utf8, Utf8),
        Operator::Plus | Operator::Minus | Operator::Multiply | Operator::Divide | Operator::Modulo => {
            if matches!(lt, Null) || matches!(rt, Null) {
                let other = if matches!(lt, Null) { rt } else { lt };
                let t = if matches!(other, Null) { Int64 } else { other.clone() };
                return sig(t.clone(), t.clone(), t);
            }
            if is_numeric(lt) && is_numeric(rt) {
                // decimals keep their own precision/scale, arrow handles the rescaling
                if (is_decimal(lt) || is_decimal(rt)) && !is_float(lt) && !is_float(rt) {
                    let l = as_decimal(lt).map(|(p, s)| Decimal128(p, s)).unwrap();
                    let r = as_decimal(rt).map(|(p, s)| Decimal128(p, s)).unwrap();
                    let res = arith_result(op, &l, &r)?;
                    return sig(l, r, res);
                }
                let c = numeric_common(lt, rt).unwrap();
                if op == Operator::Divide && is_integer(&c) {
                    return sig(Float64, Float64, Float64);
                }
                return sig(c.clone(), c.clone(), c);
            }
            // temporal arithmetic (date +/- interval, timestamp - timestamp, ...)
            let (l, r) = match (lt, rt) {
                (l, r) if is_temporal(l) && is_string(r) => (l.clone(), Interval(arrow::datatypes::IntervalUnit::MonthDayNano)),
                _ => (lt.clone(), rt.clone()),
            };
            let res = arith_result(op, &l, &r)?;
            sig(l, r, res)
        }
    }
}

/// Parse a type name (SQL or Polars style) into an Arrow type.
pub fn parse_data_type(s: &str) -> Result<DataType> {
    use DataType::*;
    let t = s.trim().to_ascii_lowercase();
    let t = t.as_str();
    if let Some(rest) = t.strip_prefix("decimal").or_else(|| t.strip_prefix("numeric")) {
        let rest = rest.trim();
        if rest.is_empty() {
            return Ok(Decimal128(38, 9));
        }
        let inner = rest.trim_start_matches('(').trim_end_matches(')');
        let mut parts = inner.split(',').map(|p| p.trim().parse::<i64>());
        let p = parts.next().and_then(|r| r.ok()).unwrap_or(38) as u8;
        let s = parts.next().and_then(|r| r.ok()).unwrap_or(0) as i8;
        return Ok(Decimal128(p, s));
    }
    let base = t.split('(').next().unwrap().trim();
    Ok(match base {
        "bool" | "boolean" => Boolean,
        "int8" | "tinyint" | "i8" => Int8,
        "int16" | "smallint" | "i16" | "int2" => Int16,
        "int32" | "int" | "integer" | "i32" | "int4" => Int32,
        "int64" | "bigint" | "long" | "i64" | "int8_" => Int64,
        "uint8" | "u8" | "utinyint" => UInt8,
        "uint16" | "u16" | "usmallint" => UInt16,
        "uint32" | "u32" | "uinteger" => UInt32,
        "uint64" | "u64" | "ubigint" => UInt64,
        "float32" | "float" | "real" | "f32" | "float4" => Float32,
        "float64" | "double" | "double precision" | "f64" | "float8" => Float64,
        "utf8" | "str" | "string" | "varchar" | "text" | "char" | "character varying" | "character" | "bpchar" => Utf8,
        "large_utf8" | "large_string" => LargeUtf8,
        "utf8view" | "string_view" => Utf8View,
        "date" | "date32" => Date32,
        "datetime" | "timestamp" | "timestamp_us" => Timestamp(TimeUnit::Microsecond, None),
        "timestamp_ns" => Timestamp(TimeUnit::Nanosecond, None),
        "timestamp_ms" => Timestamp(TimeUnit::Millisecond, None),
        "timestamp_s" => Timestamp(TimeUnit::Second, None),
        "binary" | "bytes" | "blob" | "bytea" => Binary,
        "null" => Null,
        _ => return Err(WhError::Plan(format!("unknown data type '{s}'"))),
    })
}

/// Adapt a literal to the type of the other operand when it is exactly
/// representable, so the (large) column side never needs a cast.
pub fn adapt_literal(s: &Scalar, target: &DataType, op: Operator) -> Option<Scalar> {
    let st = s.data_type();
    if st == target {
        return None;
    }
    if s.is_null() {
        return Some(Scalar::null_of(target));
    }
    if is_numeric(st) && is_numeric(target) {
        if is_float(st) && is_integer(target) {
            return None;
        }
        if is_float(st) && is_decimal(target) && !op.is_comparison() {
            return None;
        }
        if is_decimal(st) && is_integer(target) {
            return None;
        }
        if is_integer(st) && is_decimal(target) && op.is_arithmetic() {
            // keep the decimal scale of the column; precision of the literal itself
            if let DataType::Decimal128(_, sc) = target {
                let digits = s.as_i64().map(|v| v.unsigned_abs().to_string().len()).unwrap_or(19) as u8;
                return s.cast_exact(&DataType::Decimal128((digits + *sc as u8).clamp(1, 38), *sc));
            }
        }
        return s.cast_exact(target);
    }
    if is_string(st) && (is_string(target) || is_temporal(target)) && op.is_comparison() {
        return s.cast_to(target).ok();
    }
    None
}

