//! Plan-time handling of the P1 scalar functions: argument coercion, constant
//! checks (formats, patterns) and rewrites into existing expressions.

use arrow::datatypes::{DataType, TimeUnit};

use super::{dates, names, parse, pattern, random, time};
use crate::error::{Result, WhError};
use crate::expr::{Expr, Operator, ScalarFunc, binary};
use crate::physical::expr::{PhysExpr, cast_expr, create_physical_expr, to_utf8};
use crate::scalar::Scalar;
use crate::schema::PlanSchema;
use crate::types::{is_float, is_integer, is_string};

const TS_US: DataType = DataType::Timestamp(TimeUnit::Microsecond, None);

pub fn compile(func: ScalarFunc, args: &[Expr], schema: &PlanSchema) -> Result<PhysExpr> {
    use ScalarFunc::*;
    let n = args.len();
    let nargs = |lo: usize, hi: usize| -> Result<()> {
        if n < lo || n > hi {
            Err(WhError::Plan(format!("{} expects {lo}..{hi} arguments, got {n}", func.name())))
        } else {
            Ok(())
        }
    };
    if super::lists::names::is_list_func(func) {
        return super::lists::plan::compile(func, args, schema);
    }
    if super::structs::names::is_struct_func(func) {
        return super::structs::plan::compile(func, args, schema);
    }
    if super::json::names::is_json_func(func) {
        return super::json::plan::compile(func, args, schema);
    }
    match func {
        Mod => {
            nargs(2, 2)?;
            return create_physical_expr(&binary(args[0].clone(), Operator::Modulo, args[1].clone()), schema);
        }
        Clip => {
            nargs(3, 3)?;
            return create_physical_expr(&clip(&args[0], &args[1], &args[2]), schema);
        }
        EqNullSafe => {
            nargs(2, 2)?;
            return create_physical_expr(&null_safe_eq(&args[0], &args[1]), schema);
        }
        Now | CurrentDate => {
            nargs(0, 0)?;
            return Ok(PhysExpr::Literal(time::query_time(func == Now)));
        }
        ToDate | ToTimestamp if n == 1 => {
            let to = if func == ToDate { DataType::Date32 } else { TS_US };
            return create_physical_expr(&args[0].clone().cast(to), schema);
        }
        _ => {}
    }
    let mut a = args.iter().map(|e| create_physical_expr(e, schema)).collect::<Result<Vec<_>>>()?;
    let to = |a: &mut Vec<PhysExpr>, i: usize, t: &DataType| -> Result<()> {
        a[i] = cast_expr(a[i].clone(), t)?;
        Ok(())
    };
    let utf8 = |a: &mut Vec<PhysExpr>, i: usize| -> Result<()> {
        a[i] = to_utf8(a[i].clone())?;
        Ok(())
    };
    match func {
        Sign => {
            nargs(1, 1)?;
            let t = a[0].data_type();
            if !is_integer(&t) && !is_float(&t) {
                to(&mut a, 0, &DataType::Float64)?;
            }
        }
        IsNan | Sin | Cos | Tan | Asin | Acos | Atan | Degrees | Radians => {
            nargs(1, 1)?;
            to(&mut a, 0, &DataType::Float64)?;
        }
        Atan2 => {
            nargs(2, 2)?;
            to(&mut a, 0, &DataType::Float64)?;
            to(&mut a, 1, &DataType::Float64)?;
        }
        Pi => nargs(0, 0)?,
        Grouping => {
            return Err(WhError::Plan("grouping() is only valid with GROUP BY ROLLUP / CUBE / GROUPING SETS".into()));
        }
        Random => {
            nargs(0, 2)?;
            for i in 0..n {
                to(&mut a, i, &DataType::Int64)?;
            }
            if n >= 1 {
                // a new plan restarts the sequence of a seed
                random::restart(const_int(&a[0], "random seed")?.unwrap_or(0));
            }
        }
        DateAdd | DateSub => {
            nargs(2, 2)?;
            to(&mut a, 0, &DataType::Date32)?;
            to(&mut a, 1, &DataType::Int32)?;
        }
        AddMonths => {
            nargs(2, 2)?;
            to(&mut a, 0, &DataType::Date32)?;
            to(&mut a, 1, &DataType::Int64)?;
        }
        DateDiff => {
            nargs(2, 3)?;
            if n == 2 {
                // Spark order (end, start) -> (unit, start, end)
                let end = a.remove(0);
                let start = a.remove(0);
                a = vec![PhysExpr::Literal(Scalar::utf8("day")), start, end];
            }
            dates::check_unit(&const_str(&a[0], "datediff unit")?)?;
            to(&mut a, 1, &TS_US)?;
            to(&mut a, 2, &TS_US)?;
        }
        LastDay => {
            nargs(1, 1)?;
            to(&mut a, 0, &DataType::Date32)?;
        }
        MonthStart | MonthEnd => {
            nargs(1, 1)?;
            if is_string(&a[0].data_type()) {
                to(&mut a, 0, &DataType::Date32)?;
            }
        }
        MakeDate => {
            nargs(3, 3)?;
            for i in 0..3 {
                to(&mut a, i, &DataType::Int64)?;
            }
        }
        OffsetBy => {
            nargs(2, 2)?;
            if is_string(&a[0].data_type()) {
                to(&mut a, 0, &TS_US)?;
            }
            let off = dates::Offset::parse(&const_str(&a[1], "offset_by interval")?)?;
            if a[0].data_type() == DataType::Date32 && off.micros != 0 {
                return Err(WhError::Plan("offset_by: sub-day units need a timestamp, cast the date first".into()));
            }
        }
        ToDate | StrictToDate | ToTimestamp | StrictToTimestamp => {
            nargs(2, 2)?;
            utf8(&mut a, 0)?;
            parse::check_format(&const_str(&a[1], "format")?, false)?;
        }
        Strftime => {
            nargs(2, 2)?;
            let t = a[0].data_type();
            if is_string(&t) {
                to(&mut a, 0, &TS_US)?;
            } else if !t.is_temporal() {
                return Err(WhError::Plan(format!("strftime requires a temporal argument, got {t}")));
            }
            parse::check_format(&const_str(&a[1], "format")?, true)?;
        }
        LPad | RPad => {
            nargs(2, 3)?;
            utf8(&mut a, 0)?;
            to(&mut a, 1, &DataType::Int64)?;
            if n == 2 {
                a.push(PhysExpr::Literal(Scalar::utf8(" ")));
            }
            utf8(&mut a, 2)?;
        }
        ZFill | Repeat => {
            nargs(2, 2)?;
            utf8(&mut a, 0)?;
            to(&mut a, 1, &DataType::Int64)?;
        }
        SplitPart => {
            nargs(3, 3)?;
            utf8(&mut a, 0)?;
            utf8(&mut a, 1)?;
            to(&mut a, 2, &DataType::Int64)?;
        }
        ConcatWs => {
            nargs(1, usize::MAX)?;
            for i in 0..n {
                utf8(&mut a, i)?;
            }
        }
        InitCap => {
            nargs(1, 1)?;
            utf8(&mut a, 0)?;
        }
        RegexpLike | RegexpCount => {
            nargs(2, 3)?;
            prepare_regex(&mut a, func, 1, 2)?;
        }
        RegexpReplace => {
            nargs(3, 4)?;
            prepare_regex(&mut a, func, 1, 3)?;
            utf8(&mut a, 2)?;
            const_str_opt(&a[2], "regexp_replace replacement")?;
        }
        RegexpExtract => {
            nargs(2, 4)?;
            let flags_at = if n == 4 { 3 } else { usize::MAX };
            prepare_regex(&mut a, func, 1, flags_at)?;
            let mut group = 0;
            if n >= 3 {
                to(&mut a, 2, &DataType::Int64)?;
                group = const_int(&a[2], "regexp_extract group")?.unwrap_or(0);
            }
            // flag 'n' (Polars mode): a missing group is NULL, not an error
            let lenient = flags(&a, flags_at).contains('n');
            if let Some(p) = const_str_opt(&a[1], "regexp_extract pattern")?.filter(|_| !lenient) {
                pattern::check_group(&p, flags(&a, flags_at), group)?;
            }
        }
        other => return Err(WhError::Plan(format!("{}: not a P1 function", names::name(other)))),
    }
    let types: Vec<DataType> = a.iter().map(|x| x.data_type()).collect();
    let dt = func.return_type(&types)?;
    Ok(PhysExpr::Function { func, args: a, dt })
}

fn flags(a: &[PhysExpr], at: usize) -> &str {
    match a.get(at) {
        Some(PhysExpr::Literal(s)) => s.as_str().unwrap_or(""),
        _ => "",
    }
}

/// Subject to utf8; pattern and optional flags must be constants. The pattern
/// is compiled here, so errors surface at plan time and the cache is warm.
fn prepare_regex(a: &mut [PhysExpr], func: ScalarFunc, pat: usize, flags_at: usize) -> Result<()> {
    a[0] = to_utf8(a[0].clone())?;
    a[pat] = to_utf8(a[pat].clone())?;
    if flags_at < a.len() {
        a[flags_at] = to_utf8(a[flags_at].clone())?;
    }
    if let Some(p) = const_str_opt(&a[pat], &format!("{} pattern", func.name()))? {
        pattern::compile(&p, flags(a, flags_at))?;
    }
    Ok(())
}

fn const_str_opt(e: &PhysExpr, what: &str) -> Result<Option<String>> {
    match e {
        PhysExpr::Literal(s) => Ok(s.as_str().map(str::to_string)),
        _ => Err(WhError::NotSupported(format!("{what} must be a constant"))),
    }
}

fn const_str(e: &PhysExpr, what: &str) -> Result<String> {
    const_str_opt(e, what)?.ok_or_else(|| WhError::Plan(format!("{what} must not be NULL")))
}

fn const_int(e: &PhysExpr, what: &str) -> Result<Option<i64>> {
    match e {
        PhysExpr::Literal(s) => Ok(s.as_i64()),
        _ => Err(WhError::NotSupported(format!("{what} must be a constant"))),
    }
}

fn is_null_literal(e: &Expr) -> bool {
    matches!(e, Expr::Literal(s) if s.is_null())
}

/// clip(x, lo, hi): a NULL bound means no bound; a NULL x stays NULL.
fn clip(x: &Expr, lo: &Expr, hi: &Expr) -> Expr {
    let mut when_then = vec![];
    if !is_null_literal(lo) {
        when_then.push((x.clone().lt(lo.clone()), lo.clone()));
    }
    if !is_null_literal(hi) {
        when_then.push((x.clone().gt(hi.clone()), hi.clone()));
    }
    if when_then.is_empty() {
        return x.clone();
    }
    Expr::Case { when_then, otherwise: Some(Box::new(x.clone())) }
}

/// a IS NOT DISTINCT FROM b
fn null_safe_eq(a: &Expr, b: &Expr) -> Expr {
    let yes = Expr::Literal(Scalar::boolean(true));
    let no = Expr::Literal(Scalar::boolean(false));
    Expr::Case {
        when_then: vec![
            (a.clone().is_null().and(b.clone().is_null()), yes),
            (a.clone().is_null().or(b.clone().is_null()), no),
        ],
        otherwise: Some(Box::new(a.clone().eq(b.clone()))),
    }
}
