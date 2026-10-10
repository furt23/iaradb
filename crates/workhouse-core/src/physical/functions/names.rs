//! Names and result types of the P1 scalar functions.

use arrow::datatypes::{DataType, TimeUnit};

use crate::error::{Result, WhError};
use crate::expr::ScalarFunc::{self, *};
use crate::types::{is_float, is_integer};

pub fn from_name(name: &str) -> Option<ScalarFunc> {
    Some(match name {
        "sign" | "signum" => Sign,
        "mod" | "pmod" => Mod,
        "isnan" | "is_nan" => IsNan,
        "clip" | "clamp" => Clip,
        "eq_null_safe" | "equal_null" | "eq_missing" => EqNullSafe,
        "date_add" | "dateadd" | "adddate" => DateAdd,
        "date_sub" | "datesub" | "subdate" => DateSub,
        "datediff" | "date_diff" => DateDiff,
        "add_months" => AddMonths,
        "last_day" => LastDay,
        "month_start" => MonthStart,
        "month_end" => MonthEnd,
        "make_date" => MakeDate,
        "offset_by" => OffsetBy,
        "to_date" => ToDate,
        "to_timestamp" | "try_strptime" => ToTimestamp,
        "strptime_date" => StrictToDate,
        "strptime" => StrictToTimestamp,
        "strftime" | "date_format" => Strftime,
        "lpad" | "pad_start" => LPad,
        "rpad" | "pad_end" => RPad,
        "zfill" => ZFill,
        "split_part" => SplitPart,
        "concat_ws" => ConcatWs,
        "initcap" | "to_titlecase" => InitCap,
        "repeat" => Repeat,
        "regexp_like" | "regexp_matches" | "rlike" | "regexp" => RegexpLike,
        "regexp_replace" => RegexpReplace,
        "regexp_extract" => RegexpExtract,
        "regexp_count" | "count_matches" => RegexpCount,
        "now" | "current_timestamp" | "localtimestamp" | "get_current_timestamp" => Now,
        "current_date" | "today" => CurrentDate,
        "sin" => Sin,
        "cos" => Cos,
        "tan" => Tan,
        "asin" => Asin,
        "acos" => Acos,
        "atan" => Atan,
        "atan2" => Atan2,
        "degrees" => Degrees,
        "radians" => Radians,
        "pi" => Pi,
        "random" | "rand" => Random,
        "grouping" | "grouping_id" => Grouping,
        _ => return super::lists::names::from_name(name),
    })
}

pub fn name(f: ScalarFunc) -> &'static str {
    match f {
        Sign => "sign",
        Mod => "mod",
        IsNan => "isnan",
        Clip => "clip",
        EqNullSafe => "eq_null_safe",
        DateAdd => "date_add",
        DateSub => "date_sub",
        DateDiff => "datediff",
        AddMonths => "add_months",
        LastDay => "last_day",
        MonthStart => "month_start",
        MonthEnd => "month_end",
        MakeDate => "make_date",
        OffsetBy => "offset_by",
        ToDate => "to_date",
        ToTimestamp => "to_timestamp",
        StrictToDate => "strptime_date",
        StrictToTimestamp => "strptime",
        Strftime => "strftime",
        LPad => "lpad",
        RPad => "rpad",
        ZFill => "zfill",
        SplitPart => "split_part",
        ConcatWs => "concat_ws",
        InitCap => "initcap",
        Repeat => "repeat",
        RegexpLike => "regexp_like",
        RegexpReplace => "regexp_replace",
        RegexpExtract => "regexp_extract",
        RegexpCount => "regexp_count",
        Now => "now",
        CurrentDate => "current_date",
        Sin => "sin",
        Cos => "cos",
        Tan => "tan",
        Asin => "asin",
        Acos => "acos",
        Atan => "atan",
        Atan2 => "atan2",
        Degrees => "degrees",
        Radians => "radians",
        Pi => "pi",
        Random => "random",
        Grouping => "grouping",
        _ => super::lists::names::name(f),
    }
}

pub fn return_type(f: ScalarFunc, args: &[DataType]) -> Result<DataType> {
    let first = args.first().cloned().unwrap_or(DataType::Null);
    Ok(match f {
        Sign => {
            if is_integer(&first) || is_float(&first) { first } else { DataType::Float64 }
        }
        IsNan | RegexpLike | EqNullSafe => DataType::Boolean,
        Mod | Clip => crate::types::common_supertype(args.iter())
            .ok_or_else(|| WhError::Plan(format!("{}: incompatible argument types {args:?}", name(f))))?,
        DateAdd | DateSub | AddMonths | LastDay | MakeDate | ToDate | StrictToDate => DataType::Date32,
        MonthStart | MonthEnd | OffsetBy => match first {
            DataType::Timestamp(..) | DataType::Date32 => first,
            _ => DataType::Date32,
        },
        DateDiff | RegexpCount | Grouping => DataType::Int64,
        Now => DataType::Timestamp(TimeUnit::Microsecond, None),
        CurrentDate => DataType::Date32,
        Sin | Cos | Tan | Asin | Acos | Atan | Atan2 | Degrees | Radians | Pi | Random => DataType::Float64,
        ToTimestamp | StrictToTimestamp => DataType::Timestamp(TimeUnit::Microsecond, None),
        Strftime | LPad | RPad | ZFill | SplitPart | ConcatWs | InitCap | Repeat | RegexpReplace
        | RegexpExtract => DataType::Utf8,
        other => return super::lists::names::return_type(other, args),
    })
}

/// Functions that `compile_function` handles in `plan.rs`.
pub fn is_p1(f: ScalarFunc) -> bool {
    name(f) != "?"
}
