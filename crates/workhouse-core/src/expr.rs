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
}

impl AggFunc {
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
            Min | Max | First | Last => input,
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
            _ => return None,
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
            Upper | Lower | Trim | LTrim | RTrim | Substring | Replace | Concat | Left | Right
            | Reverse => Utf8,
            Length | StrPos => Int64,
            StartsWith | EndsWith | Contains => Boolean,
            Coalesce | Greatest | Least => common_supertype(args.iter()).ok_or_else(|| {
                WhError::Plan(format!("{}: incompatible argument types {args:?}", self.name()))
            })?,
            NullIf => first,
            Year | Quarter | Month | Week | Day | DayOfWeek | DayOfYear | Hour | Minute | Second => Int32,
            DateTrunc => args.get(1).cloned().unwrap_or(Null),
        })
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
    Agg { func: AggFunc, args: Vec<Expr>, distinct: bool, filter: Option<Box<Expr>> },
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
    Expr::Agg { func: AggFunc::Count, args: vec![], distinct: false, filter: None }
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
        Expr::Agg { func, args: vec![self], distinct: false, filter: None }
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
            Agg { args, filter, .. } => {
                let mut v: Vec<&Expr> = args.iter().collect();
                if let Some(f) = filter {
                    v.push(f);
                }
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
            Agg { func, args, distinct, filter } => Agg {
                func,
                args: args.into_iter().map(&mut f).collect::<Result<_>>()?,
                distinct,
                filter: match filter {
                    Some(x) => Some(b(x, &mut f)?),
                    None => None,
                },
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
            Expr::Agg { func, args, distinct, filter } => {
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
            Agg { func, args, distinct, filter } => {
                if args.is_empty() {
                    write!(f, "{}(*)", func.name())?;
                } else {
                    write!(
                        f,
                        "{}({}{})",
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
