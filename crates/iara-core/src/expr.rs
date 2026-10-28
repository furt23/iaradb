//! Logical expressions.

use std::fmt;
use std::sync::Arc;

use arrow::datatypes::{DataType, Field};

use crate::error::{Result, WhError};
use crate::logical::LogicalPlan;
use crate::scalar::Scalar;
pub use crate::schema::Column;
use crate::schema::{PlanSchema, QualifiedField};
use crate::types::{adapt_literal, binary_signature, common_supertype, is_decimal, is_float, is_integer};
pub use crate::window::{FrameBound, FrameUnits, WindowExpr, WindowFrame, WindowFunc};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Operator {
    Eq,
    NotEq,
    Lt,
    LtEq,
    Gt,
    GtEq,
    Plus,
    Minus,
    Multiply,
    Divide,
    Modulo,
    And,
    Or,
    StringConcat,
}

impl Operator {
    pub fn symbol(&self) -> &'static str {
        use Operator::*;
        match self {
            Eq => "=",
            NotEq => "!=",
            Lt => "<",
            LtEq => "<=",
            Gt => ">",
            GtEq => ">=",
            Plus => "+",
            Minus => "-",
            Multiply => "*",
            Divide => "/",
            Modulo => "%",
            And => "AND",
            Or => "OR",
            StringConcat => "||",
        }
    }
    pub fn is_comparison(&self) -> bool {
        use Operator::*;
        matches!(self, Eq | NotEq | Lt | LtEq | Gt | GtEq)
    }
    pub fn is_arithmetic(&self) -> bool {
        use Operator::*;
        matches!(self, Plus | Minus | Multiply | Divide | Modulo)
    }
    /// `a op b` == `b op' a`
    pub fn swap(&self) -> Operator {
        use Operator::*;
        match self {
            Lt => Gt,
            LtEq => GtEq,
            Gt => Lt,
            GtEq => LtEq,
            o => *o,
        }
    }
    /// NOT (a op b) == a op' b
    pub fn negate(&self) -> Option<Operator> {
        use Operator::*;
        Some(match self {
            Eq => NotEq,
            NotEq => Eq,
            Lt => GtEq,
            LtEq => Gt,
            Gt => LtEq,
            GtEq => Lt,
            _ => return None,
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum AggFunc {
    Count,
    Sum,
    Mean,
    Min,
    Max,
    Median,
    Std,
    StdPop,
    Var,
    VarPop,
    First,
    Last,
    /// `quantile_cont(x, p)`: linear interpolation (DuckDB / Polars "linear")
    QuantileCont,
    /// `quantile_disc(x, p)`: smallest value whose cumulative share reaches p
    QuantileDisc,
    /// exact under the hood: floats interpolate, other types pick a value
    ApproxQuantile,
    CountIf,
    BoolAnd,
    BoolOr,
    MaxBy,
    MinBy,
    Product,
    Corr,
    CovarSamp,
    CovarPop,
    /// `regr_slope(y, x)`
    RegrSlope,
    /// `array_agg(x [ORDER BY ..])` / `list(x)`: every value, NULLs included
    ArrayAgg,
    /// `collect_list(x)`: like `array_agg`, NULLs skipped (Spark)
    CollectList,
    /// `collect_set(x)`: the distinct non-NULL values
    CollectSet,
}

impl AggFunc {
    /// Number of arguments the SQL / Python call takes.
    pub fn arity(&self) -> usize {
        use AggFunc::*;
        match self {
            QuantileCont | QuantileDisc | ApproxQuantile | MaxBy | MinBy | Corr | CovarSamp | CovarPop | RegrSlope => 2,
            _ => 1,
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        use AggFunc::*;
        Some(match name.to_ascii_lowercase().as_str() {
            "count" => Count,
            "sum" => Sum,
            "avg" | "mean" => Mean,
            "min" => Min,
            "max" => Max,
            "median" => Median,
            "stddev" | "stddev_samp" | "std" => Std,
            "stddev_pop" => StdPop,
            "variance" | "var_samp" | "var" => Var,
            "var_pop" => VarPop,
            "first" | "first_value" | "any_value" | "arbitrary" => First,
            "last" | "last_value" => Last,
            "quantile_cont" | "percentile_cont" => QuantileCont,
            "quantile_disc" | "quantile" | "percentile_disc" => QuantileDisc,
            "approx_quantile" | "approx_percentile" => ApproxQuantile,
            "count_if" | "countif" => CountIf,
            "bool_and" | "every" => BoolAnd,
            "bool_or" => BoolOr,
            "max_by" | "arg_max" => MaxBy,
            "min_by" | "arg_min" => MinBy,
            "product" => Product,
            "corr" => Corr,
            "covar_samp" => CovarSamp,
            "covar_pop" => CovarPop,
            "regr_slope" => RegrSlope,
            "array_agg" | "list" | "implode" => ArrayAgg,
            "collect_list" => CollectList,
            "collect_set" => CollectSet,
            _ => return None,
        })
    }
    pub fn name(&self) -> &'static str {
        use AggFunc::*;
        match self {
            Count => "count",
            Sum => "sum",
            Mean => "avg",
            Min => "min",
            Max => "max",
            Median => "median",
            Std => "stddev",
            StdPop => "stddev_pop",
            Var => "variance",
            VarPop => "var_pop",
            First => "first",
            Last => "last",
            QuantileCont => "quantile_cont",
            QuantileDisc => "quantile_disc",
            ApproxQuantile => "approx_quantile",
            CountIf => "count_if",
            BoolAnd => "bool_and",
            BoolOr => "bool_or",
            MaxBy => "max_by",
            MinBy => "min_by",
            Product => "product",
            Corr => "corr",
            CovarSamp => "covar_samp",
            CovarPop => "covar_pop",
            RegrSlope => "regr_slope",
            ArrayAgg => "array_agg",
            CollectList => "collect_list",
            CollectSet => "collect_set",
        }
    }
    pub fn return_type(&self, arg_types: &[DataType]) -> Result<DataType> {
        use AggFunc::*;
        use DataType::*;
        let input = arg_types.first().cloned().unwrap_or(Null);
        Ok(match self {
            Count => Int64,
            Sum => match &input {
                Int8 | Int16 | Int32 | Int64 | Null | Boolean => Int64,
                UInt8 | UInt16 | UInt32 | UInt64 => UInt64,
                Float16 | Float32 | Float64 => Float64,
                Decimal128(_, s) => Decimal128(38, *s),
                t => return Err(WhError::Plan(format!("sum not supported for {t}"))),
            },
            Mean | Median | Std | StdPop | Var | VarPop => {
                if !(input.is_numeric() || matches!(input, Null | Boolean)) {
                    return Err(WhError::Plan(format!("{} not supported for {input}", self.name())));
                }
                Float64
            }
            Min | Max | First | Last | MaxBy | MinBy | QuantileDisc => input,
            QuantileCont | Product | Corr | CovarSamp | CovarPop | RegrSlope => {
                if !(input.is_numeric() || matches!(input, Null | Boolean)) {
                    return Err(WhError::Plan(format!("{} not supported for {input}", self.name())));
                }
                Float64
            }
            ApproxQuantile => match input {
                Float16 | Float32 | Float64 => Float64,
                t => t,
            },
            CountIf => Int64,
            BoolAnd | BoolOr => Boolean,
            ArrayAgg | CollectList | CollectSet => {
                crate::nested::list_of(crate::nested::canonical_element(if input == Null { &Int64 } else { &input }))
            }
        })
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum ScalarFunc {
    Abs,
    Ceil,
    Floor,
    Round,
    Sqrt,
    Exp,
    Ln,
    Log10,
    Log2,
    Power,
    Upper,
    Lower,
    Length,
    OctetLength,
    Trim,
    LTrim,
    RTrim,
    Substring,
    Replace,
    Concat,
    StartsWith,
    EndsWith,
    Contains,
    StrPos,
    Left,
    Right,
    Reverse,
    Coalesce,
    NullIf,
    Greatest,
    Least,
    Year,
    Quarter,
    Month,
    Week,
    Day,
    DayOfWeek,
    DayOfYear,
    Hour,
    Minute,
    Second,
    DateTrunc,
    // P1 scalar families (names, types and kernels live in physical/functions/)
    Sign,
    Mod,
    IsNan,
    Clip,
    EqNullSafe,
    DateAdd,
    DateSub,
    DateDiff,
    AddMonths,
    LastDay,
    MonthStart,
    MonthEnd,
    MakeDate,
    OffsetBy,
    ToDate,
    ToTimestamp,
    StrictToDate,
    StrictToTimestamp,
    Strftime,
    LPad,
    RPad,
    ZFill,
    SplitPart,
    ConcatWs,
    InitCap,
    Repeat,
    RegexpLike,
    RegexpReplace,
    RegexpExtract,
    RegexpCount,
    Now,
    CurrentDate,
    Sin,
    Cos,
    Tan,
    Asin,
    Acos,
    Atan,
    Atan2,
    Degrees,
    Radians,
    Pi,
    Random,
    /// `grouping(k..)`: only valid under ROLLUP / CUBE / GROUPING SETS
    Grouping,
    // list functions (names, types and kernels live in physical/functions/lists/)
    ListValue,
    ListExtract,
    ListLength,
    ListContains,
    ListPosition,
    ListSlice,
    ListConcat,
    /// `concat_list(a, b, ..)` (Polars): lists are joined, other values become elements; NULL if a list is
    ConcatList,
    ListSort,
    ListReverse,
    ListDistinct,
    ListUnique,
    ArrayToString,
    /// `list_aggr(l, 'sum')`, `list_sum(l)`, ...: an aggregate over each list
    ListAgg(AggFunc),
    StringSplit,
    RegexpSplit,
    /// `unnest(l)` in a select list: the binder turns it into a plan node
    Unnest,
    // struct functions (names, types and kernels live in physical/functions/structs/); field names are
    // constant arguments before their values: StructPack('a', 1, 'b', 2), StructExtract(s, 'a')
    StructPack,
    StructExtract,
    StructInsert,
    /// `struct_rename(s, 'new_a', 'new_b', ..)`: the fields under new names, in order
    StructRename,
    // JSON functions on text (physical/functions/json/)
    JsonExtract,
    JsonExtractString,
    JsonArrayLength,
    ToJson,
    /// `from_json(text, 'type')`: the constant second argument names the result type
    FromJson,
}

impl ScalarFunc {
    pub fn from_name(name: &str) -> Option<Self> {
        use ScalarFunc::*;
        Some(match name.to_ascii_lowercase().as_str() {
            "abs" => Abs,
            "ceil" | "ceiling" => Ceil,
            "floor" => Floor,
            "round" => Round,
            "sqrt" => Sqrt,
            "exp" => Exp,
            "ln" => Ln,
            "log10" | "log" => Log10,
            "log2" => Log2,
            "power" | "pow" => Power,
            "upper" | "ucase" | "to_uppercase" => Upper,
            "lower" | "lcase" | "to_lowercase" => Lower,
            "length" | "len" | "char_length" | "character_length" | "len_chars" => Length,
            "strlen" | "octet_length" | "len_bytes" => OctetLength,
            "trim" | "strip" | "strip_chars" => Trim,
            "ltrim" | "lstrip" | "strip_chars_start" => LTrim,
            "rtrim" | "rstrip" | "strip_chars_end" => RTrim,
            "substring" | "substr" | "slice" => Substring,
            "replace" => Replace,
            "concat" | "concat_str" => Concat,
            "starts_with" | "startswith" | "prefix" => StartsWith,
            "ends_with" | "endswith" | "suffix" => EndsWith,
            "contains" => Contains,
            "strpos" | "instr" | "position" => StrPos,
            "left" => Left,
            "right" => Right,
            "reverse" => Reverse,
            "coalesce" | "ifnull" | "fill_null" => Coalesce,
            "nullif" => NullIf,
            "greatest" => Greatest,
            "least" => Least,
            "year" => Year,
            "quarter" => Quarter,
            "month" => Month,
            "week" | "weekofyear" => Week,
            "day" | "dayofmonth" => Day,
            "dayofweek" | "dow" | "weekday" => DayOfWeek,
            "dayofyear" | "doy" => DayOfYear,
            "hour" => Hour,
            "minute" => Minute,
            "second" => Second,
            "date_trunc" | "truncate" => DateTrunc,
            n => return crate::physical::functions::names::from_name(n),
        })
    }

    pub fn name(&self) -> &'static str {
        use ScalarFunc::*;
        match self {
            Abs => "abs",
            Ceil => "ceil",
            Floor => "floor",
            Round => "round",
            Sqrt => "sqrt",
            Exp => "exp",
            Ln => "ln",
            Log10 => "log10",
            Log2 => "log2",
            Power => "power",
            Upper => "upper",
            Lower => "lower",
            Length => "length",
            OctetLength => "octet_length",
            Trim => "trim",
            LTrim => "ltrim",
            RTrim => "rtrim",
            Substring => "substring",
            Replace => "replace",
            Concat => "concat",
            StartsWith => "starts_with",
            EndsWith => "ends_with",
            Contains => "contains",
            StrPos => "strpos",
            Left => "left",
            Right => "right",
            Reverse => "reverse",
            Coalesce => "coalesce",
            NullIf => "nullif",
            Greatest => "greatest",
            Least => "least",
            Year => "year",
            Quarter => "quarter",
            Month => "month",
            Week => "week",
            Day => "day",
            DayOfWeek => "dayofweek",
            DayOfYear => "dayofyear",
            Hour => "hour",
            Minute => "minute",
            Second => "second",
            DateTrunc => "date_trunc",
            f => crate::physical::functions::names::name(*f),
        }
    }

    pub fn return_type(&self, args: &[DataType]) -> Result<DataType> {
        use DataType::*;
        use ScalarFunc::*;
        let first = args.first().cloned().unwrap_or(Null);
        Ok(match self {
            Abs | Ceil | Floor => {
                if is_integer(&first) || is_float(&first) || is_decimal(&first) {
                    first
                } else {
                    Float64
                }
            }
            Round | Sqrt | Exp | Ln | Log10 | Log2 | Power => Float64,
            Reverse if crate::nested::is_list(&first) => first,
            Upper | Lower | Trim | LTrim | RTrim | Substring | Replace | Concat | Left | Right
            | Reverse => Utf8,
            Length | OctetLength | StrPos => Int64,
            StartsWith | EndsWith | Contains => Boolean,
            Coalesce | Greatest | Least => common_supertype(args.iter()).ok_or_else(|| {
                WhError::Plan(format!("{}: incompatible argument types {args:?}", self.name()))
            })?,
            NullIf => first,
            Year | Quarter | Month | Week | Day | DayOfWeek | DayOfYear | Hour | Minute | Second => Int32,
            DateTrunc => args.get(1).cloned().unwrap_or(Null),
            f => crate::physical::functions::names::return_type(*f, args)?,
        })
    }
}

/// The field a `StructExtract` call reads.
fn struct_field_name(args: &[Expr]) -> Option<String> {
    match args {
        [_, Expr::Literal(s)] => s.as_str().map(str::to_string),
        _ => None,
    }
}

/// Wrapper so expressions holding subquery plans can derive PartialEq.
#[derive(Clone, Debug)]
pub struct Subquery(pub Arc<LogicalPlan>);

impl PartialEq for Subquery {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct SortExpr {
    pub expr: Expr,
    pub descending: bool,
    pub nulls_first: bool,
}

impl SortExpr {
    pub fn new(expr: Expr, descending: bool, nulls_first: bool) -> Self {
        Self { expr, descending, nulls_first }
    }
}

impl fmt::Display for SortExpr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} {}{}",
            self.expr,
            if self.descending { "DESC" } else { "ASC" },
            if self.nulls_first { " NULLS FIRST" } else { "" }
        )
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Expr {
    Column(Column),
    Literal(Scalar),
    Alias(Box<Expr>, String),
    Binary { left: Box<Expr>, op: Operator, right: Box<Expr> },
    Not(Box<Expr>),
    Negative(Box<Expr>),
    IsNull(Box<Expr>),
    IsNotNull(Box<Expr>),
    Cast { expr: Box<Expr>, to: DataType, try_cast: bool },
    Case { when_then: Vec<(Expr, Expr)>, otherwise: Option<Box<Expr>> },
    InList { expr: Box<Expr>, list: Vec<Expr>, negated: bool },
    Like { expr: Box<Expr>, pattern: Box<Expr>, negated: bool, case_insensitive: bool },
    Function { func: ScalarFunc, args: Vec<Expr> },
    /// `order_by` is the `ORDER BY` inside the call (`array_agg(x ORDER BY y)`)
    Agg { func: AggFunc, args: Vec<Expr>, distinct: bool, filter: Option<Box<Expr>>, order_by: Vec<SortExpr> },
    Wildcard { qualifier: Option<String> },
    ScalarSubquery(Subquery),
    InSubquery { expr: Box<Expr>, subquery: Subquery, negated: bool },
    Exists { subquery: Subquery, negated: bool },
    /// Reference to a column of an enclosing query (correlated subquery).
    OuterRef(Column, DataType),
    /// `func(args) OVER (PARTITION BY .. ORDER BY .. frame)`
    Window(Box<WindowExpr>),
}

// ---------------------------------------------------------------------------
// constructors
// ---------------------------------------------------------------------------

pub fn col(name: impl Into<String>) -> Expr {
    Expr::Column(Column::from_name(name))
}

pub fn qcol(relation: &str, name: impl Into<String>) -> Expr {
    Expr::Column(Column::new(Some(relation.to_string()), name))
}

pub fn lit(s: Scalar) -> Expr {
    Expr::Literal(s)
}

pub fn binary(l: Expr, op: Operator, r: Expr) -> Expr {
    Expr::Binary { left: Box::new(l), op, right: Box::new(r) }
}

pub fn count_star() -> Expr {
    Expr::Agg { func: AggFunc::Count, args: vec![], distinct: false, filter: None, order_by: vec![] }
}

pub fn split_conjunction(e: &Expr) -> Vec<Expr> {
    let mut out = vec![];
    fn go(e: &Expr, out: &mut Vec<Expr>) {
        match e {
            Expr::Binary { left, op: Operator::And, right } => {
                go(left, out);
                go(right, out);
            }
            Expr::Alias(inner, _) => go(inner, out),
            other => out.push(other.clone()),
        }
    }
    go(e, &mut out);
    out
}

pub fn conjunction(exprs: impl IntoIterator<Item = Expr>) -> Option<Expr> {
    exprs.into_iter().reduce(|a, b| a.and(b))
}

impl Expr {
    pub fn alias(self, name: impl Into<String>) -> Expr {
        match self {
            Expr::Alias(e, _) => Expr::Alias(e, name.into()),
            e => Expr::Alias(Box::new(e), name.into()),
        }
    }
    pub fn unalias(self) -> Expr {
        match self {
            Expr::Alias(e, _) => e.unalias(),
            e => e,
        }
    }
    pub fn unalias_ref(&self) -> &Expr {
        match self {
            Expr::Alias(e, _) => e.unalias_ref(),
            e => e,
        }
    }
    pub fn eq(self, o: Expr) -> Expr {
        binary(self, Operator::Eq, o)
    }
    pub fn not_eq(self, o: Expr) -> Expr {
        binary(self, Operator::NotEq, o)
    }
    pub fn lt(self, o: Expr) -> Expr {
        binary(self, Operator::Lt, o)
    }
    pub fn lt_eq(self, o: Expr) -> Expr {
        binary(self, Operator::LtEq, o)
    }
    pub fn gt(self, o: Expr) -> Expr {
        binary(self, Operator::Gt, o)
    }
    pub fn gt_eq(self, o: Expr) -> Expr {
        binary(self, Operator::GtEq, o)
    }
    pub fn and(self, o: Expr) -> Expr {
        binary(self, Operator::And, o)
    }
    pub fn or(self, o: Expr) -> Expr {
        binary(self, Operator::Or, o)
    }
    pub fn not(self) -> Expr {
        Expr::Not(Box::new(self))
    }
    pub fn is_null(self) -> Expr {
        Expr::IsNull(Box::new(self))
    }
    pub fn is_not_null(self) -> Expr {
        Expr::IsNotNull(Box::new(self))
    }
    pub fn cast(self, to: DataType) -> Expr {
        Expr::Cast { expr: Box::new(self), to, try_cast: false }
    }
    pub fn agg(self, func: AggFunc) -> Expr {
        Expr::Agg { func, args: vec![self], distinct: false, filter: None, order_by: vec![] }
    }
    pub fn between(self, low: Expr, high: Expr) -> Expr {
        self.clone().gt_eq(low).and(self.lt_eq(high))
    }

    pub fn is_literal(&self) -> bool {
        matches!(self, Expr::Literal(_))
    }

    pub fn as_column(&self) -> Option<&Column> {
        match self {
            Expr::Column(c) => Some(c),
            _ => None,
        }
    }

    // -----------------------------------------------------------------------
    // traversal
    // -----------------------------------------------------------------------

    pub fn children(&self) -> Vec<&Expr> {
        use Expr::*;
        match self {
            Column(_) | Literal(_) | Wildcard { .. } | ScalarSubquery(_) | Exists { .. } | OuterRef(..) => vec![],
            Alias(e, _) | Not(e) | Negative(e) | IsNull(e) | IsNotNull(e) => vec![e],
            Cast { expr, .. } => vec![expr],
            Binary { left, right, .. } => vec![left, right],
            Case { when_then, otherwise } => {
                let mut v: Vec<&Expr> = vec![];
                for (w, t) in when_then {
                    v.push(w);
                    v.push(t);
                }
                if let Some(o) = otherwise {
                    v.push(o);
                }
                v
            }
            InList { expr, list, .. } => {
                let mut v: Vec<&Expr> = vec![expr];
                v.extend(list.iter());
                v
            }
            Like { expr, pattern, .. } => vec![expr, pattern],
            Function { args, .. } => args.iter().collect(),
            Agg { args, filter, order_by, .. } => {
                let mut v: Vec<&Expr> = args.iter().collect();
                if let Some(f) = filter {
                    v.push(f);
                }
                v.extend(order_by.iter().map(|o| &o.expr));
                v
            }
            InSubquery { expr, .. } => vec![expr],
            Window(w) => {
                let mut v: Vec<&Expr> = w.args.iter().collect();
                v.extend(w.filter.iter());
                v.extend(w.partition_by.iter());
                v.extend(w.order_by.iter().map(|o| &o.expr));
                v
            }
        }
    }

    /// Rebuild this node with each child mapped through `f`.
    pub fn map_children<F: FnMut(Expr) -> Result<Expr>>(self, mut f: F) -> Result<Expr> {
        use Expr::*;
        let b = |e: Box<Expr>, f: &mut F| -> Result<Box<Expr>> { Ok(Box::new(f(*e)?)) };
        Ok(match self {
            e @ (Column(_) | Literal(_) | Wildcard { .. } | ScalarSubquery(_) | Exists { .. } | OuterRef(..)) => e,
            Alias(e, n) => Alias(b(e, &mut f)?, n),
            Not(e) => Not(b(e, &mut f)?),
            Negative(e) => Negative(b(e, &mut f)?),
            IsNull(e) => IsNull(b(e, &mut f)?),
            IsNotNull(e) => IsNotNull(b(e, &mut f)?),
            Cast { expr, to, try_cast } => Cast { expr: b(expr, &mut f)?, to, try_cast },
            Binary { left, op, right } => Binary { left: b(left, &mut f)?, op, right: b(right, &mut f)? },
            Case { when_then, otherwise } => Case {
                when_then: when_then
                    .into_iter()
                    .map(|(w, t)| Ok((f(w)?, f(t)?)))
                    .collect::<Result<_>>()?,
                otherwise: match otherwise {
                    Some(o) => Some(b(o, &mut f)?),
                    None => None,
                },
            },
            InList { expr, list, negated } => InList {
                expr: b(expr, &mut f)?,
                list: list.into_iter().map(&mut f).collect::<Result<_>>()?,
                negated,
            },
            Like { expr, pattern, negated, case_insensitive } => Like {
                expr: b(expr, &mut f)?,
                pattern: b(pattern, &mut f)?,
                negated,
                case_insensitive,
            },
            Function { func, args } => Function {
                func,
                args: args.into_iter().map(&mut f).collect::<Result<_>>()?,
            },
            Agg { func, args, distinct, filter, order_by } => Agg {
                func,
                args: args.into_iter().map(&mut f).collect::<Result<_>>()?,
                distinct,
                filter: match filter {
                    Some(x) => Some(b(x, &mut f)?),
                    None => None,
                },
                order_by: order_by
                    .into_iter()
                    .map(|o| Ok(SortExpr { expr: f(o.expr)?, ..o }))
                    .collect::<Result<_>>()?,
            },
            InSubquery { expr, subquery, negated } => InSubquery { expr: b(expr, &mut f)?, subquery, negated },
            Window(w) => {
                let w = *w;
                Window(Box::new(WindowExpr {
                    args: w.args.into_iter().map(&mut f).collect::<Result<_>>()?,
                    filter: w.filter.map(&mut f).transpose()?,
                    partition_by: w.partition_by.into_iter().map(&mut f).collect::<Result<_>>()?,
                    order_by: w
                        .order_by
                        .into_iter()
                        .map(|o| Ok(SortExpr { expr: f(o.expr)?, ..o }))
                        .collect::<Result<_>>()?,
                    ..w
                }))
            }
        })
    }

    /// Post-order rewrite.
    pub fn transform_up(self, f: &mut dyn FnMut(Expr) -> Result<Expr>) -> Result<Expr> {
        let e = self.map_children(|c| c.transform_up(f))?;
        f(e)
    }

    /// Pre-order rewrite; `f` returns (new expr, recurse into children?).
    pub fn transform_down(self, f: &mut dyn FnMut(Expr) -> Result<(Expr, bool)>) -> Result<Expr> {
        let (e, recurse) = f(self)?;
        if recurse { e.map_children(|c| c.transform_down(f)) } else { Ok(e) }
    }

    /// Visit every node (pre-order); stop descending when `f` returns false.
    pub fn visit(&self, f: &mut dyn FnMut(&Expr) -> bool) {
        if f(self) {
            for c in self.children() {
                c.visit(f);
            }
        }
    }

    pub fn column_refs(&self) -> Vec<Column> {
        let mut out: Vec<Column> = vec![];
        self.visit(&mut |e| {
            if let Expr::Column(c) = e {
                if !out.contains(c) {
                    out.push(c.clone());
                }
            }
            true
        });
        out
    }

    pub fn contains_agg(&self) -> bool {
        let mut found = false;
        self.visit(&mut |e| {
            if matches!(e, Expr::Agg { .. }) {
                found = true;
            }
            !found
        });
        found
    }

    pub fn contains_window(&self) -> bool {
        let mut found = false;
        self.visit(&mut |e| {
            if matches!(e, Expr::Window(_)) {
                found = true;
            }
            !found
        });
        found
    }

    /// Evaluate the aggregates of this expression per window instead of per
    /// group (`sum(x).over([g])`): every aggregate becomes a window aggregate
    /// over the whole partition (or `frame`), and window functions without a
    /// partition / ordering of their own get these.
    pub fn over(self, partition_by: Vec<Expr>, order_by: Vec<SortExpr>, frame: Option<WindowFrame>) -> Result<Expr> {
        let mut found = false;
        let out = self.transform_down(&mut |e| match e {
            Expr::Agg { order_by, .. } if !order_by.is_empty() => {
                return Err(WhError::NotSupported("ORDER BY inside an aggregate used as a window function".into()));
            }
            Expr::Agg { func, args, distinct, filter, .. } => {
                found = true;
                let w = WindowExpr {
                    func: WindowFunc::Agg(func),
                    args,
                    distinct,
                    filter: filter.map(|f| *f),
                    ignore_nulls: false,
                    partition_by: partition_by.clone(),
                    order_by: order_by.clone(),
                    frame: frame.clone().unwrap_or_else(WindowFrame::whole),
                };
                Ok((Expr::Window(Box::new(w)), false))
            }
            Expr::Window(mut w) => {
                found = true;
                if w.partition_by.is_empty() {
                    w.partition_by = partition_by.clone();
                }
                if w.order_by.is_empty() {
                    w.order_by = order_by.clone();
                }
                if let Some(f) = &frame {
                    w.frame = f.clone();
                }
                Ok((Expr::Window(w), false))
            }
            o => Ok((o, true)),
        })?;
        if !found {
            return Err(WhError::Plan(format!("over() needs an aggregation or a window function, got '{out}'")));
        }
        Ok(out)
    }

    pub fn contains_subquery(&self) -> bool {
        let mut found = false;
        self.visit(&mut |e| {
            if matches!(e, Expr::ScalarSubquery(_) | Expr::InSubquery { .. } | Expr::Exists { .. }) {
                found = true;
            }
            !found
        });
        found
    }

    pub fn contains_outer_ref(&self) -> bool {
        let mut found = false;
        self.visit(&mut |e| {
            if matches!(e, Expr::OuterRef(..)) {
                found = true;
            }
            !found
        });
        found
    }

    /// Default output name: the left-most input of the expression
    /// (`col("a") + col("b")` -> "a", `when(..).then(col("x"))` -> "x").
    pub fn root_name(&self) -> Option<String> {
        use Expr::*;
        match self {
            Column(c) => Some(c.name.clone()),
            Alias(_, n) => Some(n.clone()),
            Binary { left, .. } => left.root_name(),
            Case { when_then, .. } => when_then.first().and_then(|(_, t)| t.root_name()),
            Function { func: ScalarFunc::StructExtract, args } => struct_field_name(args),
            Agg { args, .. } | Function { args, .. } => args.first().and_then(|a| a.root_name()),
            Not(e) | Negative(e) | IsNull(e) | IsNotNull(e) => e.root_name(),
            Cast { expr, .. } | InList { expr, .. } | Like { expr, .. } => expr.root_name(),
            Window(w) => w
                .args
                .first()
                .or(w.order_by.first().map(|o| &o.expr))
                .and_then(|a| a.root_name())
                .or_else(|| Some(w.func.name().to_string())),
            _ => None,
        }
    }

    // -----------------------------------------------------------------------
    // typing
    // -----------------------------------------------------------------------

    pub fn output_name(&self) -> String {
        match self {
            Expr::Alias(_, n) => n.clone(),
            Expr::Column(c) => c.name.clone(),
            Expr::OuterRef(c, _) => c.name.clone(),
            // a struct field is named after itself (`s.a` is column `a`)
            Expr::Function { func: ScalarFunc::StructExtract, args } => struct_field_name(args).unwrap_or_else(|| self.to_string()),
            e => e.to_string(),
        }
    }

    pub fn data_type(&self, schema: &PlanSchema) -> Result<DataType> {
        use Expr::*;
        Ok(match self {
            Column(c) => schema.field(schema.index_of(c)?).data_type().clone(),
            OuterRef(_, dt) => dt.clone(),
            Literal(s) => s.data_type().clone(),
            Alias(e, _) => e.data_type(schema)?,
            Binary { left, op, right } => {
                let mut lt = left.data_type(schema)?;
                let mut rt = right.data_type(schema)?;
                // mirror the physical planner: literals adapt to the other side
                if op.is_comparison() || op.is_arithmetic() {
                    match (left.as_ref(), right.as_ref()) {
                        (Literal(_), Literal(_)) => {}
                        (_, Literal(s)) => {
                            if let Some(a) = adapt_literal(s, &lt, *op) {
                                rt = a.data_type().clone();
                            }
                        }
                        (Literal(s), _) => {
                            if let Some(a) = adapt_literal(s, &rt, *op) {
                                lt = a.data_type().clone();
                            }
                        }
                        _ => {}
                    }
                }
                if op.is_comparison() {
                    DataType::Boolean
                } else {
                    binary_signature(*op, &lt, &rt)?.result
                }
            }
            Not(_) | IsNull(_) | IsNotNull(_) | InList { .. } | Like { .. } | InSubquery { .. }
            | Exists { .. } => DataType::Boolean,
            Negative(e) => e.data_type(schema)?,
            Cast { to, .. } => to.clone(),
            Case { when_then, otherwise } => {
                let mut types = vec![];
                for (_, t) in when_then {
                    types.push(t.data_type(schema)?);
                }
                if let Some(o) = otherwise {
                    types.push(o.data_type(schema)?);
                }
                let t = common_supertype(types.iter())
                    .ok_or_else(|| WhError::Plan(format!("CASE branches have incompatible types {types:?}")))?;
                if t == DataType::Null { DataType::Int64 } else { t }
            }
            Function { func, args } if crate::physical::functions::structs::names::is_struct_func(*func) => {
                crate::physical::functions::structs::names::logical_type(*func, args, schema)?
            }
            Function { func: ScalarFunc::FromJson, args } => {
                crate::physical::functions::json::names::logical_type(ScalarFunc::FromJson, args)?
            }
            Function { func, args } => {
                let types = args.iter().map(|a| a.data_type(schema)).collect::<Result<Vec<_>>>()?;
                func.return_type(&types)?
            }
            Agg { func, args, .. } => {
                let types = args.iter().map(|a| a.data_type(schema)).collect::<Result<Vec<_>>>()?;
                func.return_type(&types)?
            }
            Window(w) => {
                let types = w.args.iter().map(|a| a.data_type(schema)).collect::<Result<Vec<_>>>()?;
                w.func.return_type(&types)?
            }
            ScalarSubquery(q) => {
                let s = q.0.schema();
                if s.len() != 1 {
                    return Err(WhError::Plan("scalar subquery must return exactly one column".into()));
                }
                s.field(0).data_type().clone()
            }
            Wildcard { .. } => return Err(WhError::Plan("wildcard is not valid in this context".into())),
        })
    }

    pub fn nullable(&self, schema: &PlanSchema) -> Result<bool> {
        use Expr::*;
        Ok(match self {
            Column(c) => schema.field(schema.index_of(c)?).is_nullable(),
            Literal(s) => s.is_null(),
            Alias(e, _) | Negative(e) | Not(e) | Cast { expr: e, try_cast: false, .. } => e.nullable(schema)?,
            IsNull(_) | IsNotNull(_) | Exists { .. } => false,
            Binary { left, right, op } => {
                left.nullable(schema)? || right.nullable(schema)? || *op == Operator::Divide
            }
            Agg { func: AggFunc::Count, .. } => false,
            Window(w) => w.func.nullable(),
            _ => true,
        })
    }

    pub fn to_field(&self, schema: &PlanSchema) -> Result<QualifiedField> {
        if let Expr::Column(c) = self {
            let idx = schema.index_of(c)?;
            return Ok(schema.qualified_field(idx).clone());
        }
        Ok(QualifiedField::new(
            None,
            Field::new(self.output_name(), self.data_type(schema)?, self.nullable(schema)?),
        ))
    }
}

macro_rules! impl_op {
    ($trait:ident, $method:ident, $op:expr) => {
        impl std::ops::$trait for Expr {
            type Output = Expr;
            fn $method(self, rhs: Expr) -> Expr {
                binary(self, $op, rhs)
            }
        }
    };
}
impl_op!(Add, add, Operator::Plus);
impl_op!(Sub, sub, Operator::Minus);
impl_op!(Mul, mul, Operator::Multiply);
impl_op!(Div, div, Operator::Divide);
impl_op!(Rem, rem, Operator::Modulo);

impl std::ops::Neg for Expr {
    type Output = Expr;
    fn neg(self) -> Expr {
        Expr::Negative(Box::new(self))
    }
}

fn fmt_child(e: &Expr, f: &mut fmt::Formatter<'_>) -> fmt::Result {
    match e {
        Expr::Binary { .. } => write!(f, "({e})"),
        _ => write!(f, "{e}"),
    }
}

impl fmt::Display for Expr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        use Expr::*;
        match self {
            Column(c) => write!(f, "{c}"),
            OuterRef(c, _) => write!(f, "outer({c})"),
            Literal(s) => write!(f, "{s}"),
            Alias(e, n) => write!(f, "{e} AS {n}"),
            Binary { left, op, right } => {
                fmt_child(left, f)?;
                write!(f, " {} ", op.symbol())?;
                fmt_child(right, f)
            }
            Not(e) => {
                write!(f, "NOT ")?;
                fmt_child(e, f)
            }
            Negative(e) => {
                write!(f, "-")?;
                fmt_child(e, f)
            }
            IsNull(e) => {
                fmt_child(e, f)?;
                write!(f, " IS NULL")
            }
            IsNotNull(e) => {
                fmt_child(e, f)?;
                write!(f, " IS NOT NULL")
            }
            Cast { expr, to, try_cast } => {
                write!(f, "{}({expr} AS {to})", if *try_cast { "TRY_CAST" } else { "CAST" })
            }
            Case { when_then, otherwise } => {
                write!(f, "CASE")?;
                for (w, t) in when_then {
                    write!(f, " WHEN {w} THEN {t}")?;
                }
                if let Some(o) = otherwise {
                    write!(f, " ELSE {o}")?;
                }
                write!(f, " END")
            }
            InList { expr, list, negated } => {
                fmt_child(expr, f)?;
                write!(
                    f,
                    " {}IN ({})",
                    if *negated { "NOT " } else { "" },
                    list.iter().map(|e| e.to_string()).collect::<Vec<_>>().join(", ")
                )
            }
            Like { expr, pattern, negated, case_insensitive } => {
                fmt_child(expr, f)?;
                write!(
                    f,
                    " {}{} {pattern}",
                    if *negated { "NOT " } else { "" },
                    if *case_insensitive { "ILIKE" } else { "LIKE" }
                )
            }
            Function { func, args } => write!(
                f,
                "{}({})",
                func.name(),
                args.iter().map(|e| e.to_string()).collect::<Vec<_>>().join(", ")
            ),
            Agg { func, args, distinct, filter, order_by } => {
                if args.is_empty() {
                    write!(f, "{}(*)", func.name())?;
                } else {
                    let order = if order_by.is_empty() {
                        String::new()
                    } else {
                        format!(" ORDER BY {}", order_by.iter().map(|o| o.to_string()).collect::<Vec<_>>().join(", "))
                    };
                    write!(
                        f,
                        "{}({}{}{order})",
                        func.name(),
                        if *distinct { "DISTINCT " } else { "" },
                        args.iter().map(|e| e.to_string()).collect::<Vec<_>>().join(", ")
                    )?;
                }
                if let Some(fl) = filter {
                    write!(f, " FILTER (WHERE {fl})")?;
                }
                Ok(())
            }
            Wildcard { qualifier } => match qualifier {
                Some(q) => write!(f, "{q}.*"),
                None => write!(f, "*"),
            },
            ScalarSubquery(_) => write!(f, "(<subquery>)"),
            InSubquery { expr, negated, .. } => {
                write!(f, "{expr} {}IN (<subquery>)", if *negated { "NOT " } else { "" })
            }
            Exists { negated, .. } => write!(f, "{}EXISTS (<subquery>)", if *negated { "NOT " } else { "" }),
            Window(w) => write!(f, "{w}"),
        }
    }
}
