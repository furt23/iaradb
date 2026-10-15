//! Window function definitions: `func(args) OVER (PARTITION BY .. ORDER BY ..
//! frame)`. Evaluation lives in [`crate::exec::window`].

use std::fmt;
use std::sync::Arc;

use arrow::datatypes::DataType;

use crate::error::{Result, WhError};
use crate::expr::{AggFunc, Expr, SortExpr};
use crate::logical::LogicalPlan;
use crate::scalar::Scalar;
use crate::schema::Column;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum WindowFunc {
    /// An aggregate evaluated over the frame of each row.
    Agg(AggFunc),
    RowNumber,
    Rank,
    DenseRank,
    PercentRank,
    CumeDist,
    Ntile,
    Lag,
    Lead,
    FirstValue,
    LastValue,
    NthValue,
}

impl WindowFunc {
    /// Ranking and value functions (aggregates are looked up as [`AggFunc`]).
    pub fn from_name(name: &str) -> Option<Self> {
        use WindowFunc::*;
        Some(match name.to_ascii_lowercase().as_str() {
            "row_number" => RowNumber,
            "rank" => Rank,
            "dense_rank" => DenseRank,
            "percent_rank" => PercentRank,
            "cume_dist" => CumeDist,
            "ntile" => Ntile,
            "lag" => Lag,
            "lead" => Lead,
            "first_value" => FirstValue,
            "last_value" => LastValue,
            "nth_value" => NthValue,
            _ => return None,
        })
    }

    pub fn name(&self) -> &'static str {
        use WindowFunc::*;
        match self {
            Agg(a) => a.name(),
            RowNumber => "row_number",
            Rank => "rank",
            DenseRank => "dense_rank",
            PercentRank => "percent_rank",
            CumeDist => "cume_dist",
            Ntile => "ntile",
            Lag => "lag",
            Lead => "lead",
            FirstValue => "first_value",
            LastValue => "last_value",
            NthValue => "nth_value",
        }
    }

    /// (minimum, maximum) number of arguments.
    pub fn arity(&self) -> (usize, usize) {
        use WindowFunc::*;
        match self {
            Agg(AggFunc::Count) => (0, 1),
            Agg(f) => (f.arity(), f.arity()),
            RowNumber | Rank | DenseRank | PercentRank | CumeDist => (0, 0),
            Ntile => (1, 1),
            Lag | Lead => (1, 3),
            FirstValue | LastValue => (1, 1),
            NthValue => (2, 2),
        }
    }

    /// The result depends on the frame (ranking and offset functions only
    /// look at the partition and its order).
    pub fn uses_frame(&self) -> bool {
        matches!(self, WindowFunc::Agg(_) | WindowFunc::FirstValue | WindowFunc::LastValue | WindowFunc::NthValue)
    }

    pub fn return_type(&self, args: &[DataType]) -> Result<DataType> {
        use WindowFunc::*;
        let first = args.first().cloned().unwrap_or(DataType::Null);
        Ok(match self {
            Agg(a) => a.return_type(args)?,
            RowNumber | Rank | DenseRank | Ntile => DataType::Int64,
            PercentRank | CumeDist => DataType::Float64,
            Lag | Lead => match args.get(2) {
                Some(default) => crate::types::common_supertype([&first, default].into_iter()).ok_or_else(|| {
                    WhError::Plan(format!("{}: default of type {default} does not match {first}", self.name()))
                })?,
                None => first,
            },
            FirstValue | LastValue | NthValue => first,
        })
    }

    pub fn nullable(&self) -> bool {
        use WindowFunc::*;
        !matches!(self, RowNumber | Rank | DenseRank | PercentRank | CumeDist | Ntile | Agg(AggFunc::Count))
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FrameUnits {
    Rows,
    Range,
    Groups,
}

#[derive(Clone, Debug, PartialEq)]
pub enum FrameBound {
    UnboundedPreceding,
    /// `n PRECEDING` (a row/group count, or a distance on the order key for RANGE)
    Preceding(Scalar),
    CurrentRow,
    Following(Scalar),
    UnboundedFollowing,
}

#[derive(Clone, Debug, PartialEq)]
pub struct WindowFrame {
    pub units: FrameUnits,
    pub start: FrameBound,
    pub end: FrameBound,
}

impl WindowFrame {
    pub fn new(units: FrameUnits, start: FrameBound, end: FrameBound) -> Self {
        Self { units, start, end }
    }

    /// Every row of the partition.
    pub fn whole() -> Self {
        Self::new(FrameUnits::Rows, FrameBound::UnboundedPreceding, FrameBound::UnboundedFollowing)
    }

    /// From the start of the partition to the current row (`cum_sum`).
    pub fn running() -> Self {
        Self::new(FrameUnits::Rows, FrameBound::UnboundedPreceding, FrameBound::CurrentRow)
    }

    /// The SQL default: up to the current row and its peers when the window
    /// is ordered, the whole partition otherwise.
    pub fn default_for(ordered: bool) -> Self {
        if ordered {
            Self::new(FrameUnits::Range, FrameBound::UnboundedPreceding, FrameBound::CurrentRow)
        } else {
            Self::whole()
        }
    }

    pub fn is_whole(&self) -> bool {
        self.start == FrameBound::UnboundedPreceding && self.end == FrameBound::UnboundedFollowing
    }

    fn validate(&self, order_by: &[SortExpr]) -> Result<()> {
        if self.start == FrameBound::UnboundedFollowing || self.end == FrameBound::UnboundedPreceding {
            return Err(WhError::Plan(format!("invalid window frame: {self}")));
        }
        let offset = |b: &FrameBound| matches!(b, FrameBound::Preceding(_) | FrameBound::Following(_));
        if self.units == FrameUnits::Range && (offset(&self.start) || offset(&self.end)) && order_by.len() != 1 {
            return Err(WhError::Plan("RANGE with an offset requires exactly one ORDER BY expression".into()));
        }
        if self.units == FrameUnits::Groups && order_by.is_empty() {
            return Err(WhError::Plan("GROUPS frames require ORDER BY".into()));
        }
        for b in [&self.start, &self.end] {
            if let FrameBound::Preceding(s) | FrameBound::Following(s) = b {
                if s.is_null() {
                    return Err(WhError::Plan("window frame offsets cannot be NULL".into()));
                }
                if self.units != FrameUnits::Range && !s.data_type().is_integer() {
                    return Err(WhError::Plan(format!("{:?} frame offsets must be integers, got {s}", self.units)));
                }
                if s.as_i64().is_some_and(|v| v < 0) || s.as_f64().is_some_and(|v| v < 0.0) {
                    return Err(WhError::Plan("window frame offsets must not be negative".into()));
                }
            }
        }
        Ok(())
    }
}

impl fmt::Display for FrameBound {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FrameBound::UnboundedPreceding => write!(f, "UNBOUNDED PRECEDING"),
            FrameBound::Preceding(s) => write!(f, "{s} PRECEDING"),
            FrameBound::CurrentRow => write!(f, "CURRENT ROW"),
            FrameBound::Following(s) => write!(f, "{s} FOLLOWING"),
            FrameBound::UnboundedFollowing => write!(f, "UNBOUNDED FOLLOWING"),
        }
    }
}

impl fmt::Display for WindowFrame {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let units = match self.units {
            FrameUnits::Rows => "ROWS",
            FrameUnits::Range => "RANGE",
            FrameUnits::Groups => "GROUPS",
        };
        write!(f, "{units} BETWEEN {} AND {}", self.start, self.end)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct WindowExpr {
    pub func: WindowFunc,
    pub args: Vec<Expr>,
    /// `count(DISTINCT x) OVER (..)`
    pub distinct: bool,
    /// `sum(x) FILTER (WHERE ..) OVER (..)`
    pub filter: Option<Expr>,
    /// `IGNORE NULLS` (offset and value functions)
    pub ignore_nulls: bool,
    pub partition_by: Vec<Expr>,
    pub order_by: Vec<SortExpr>,
    pub frame: WindowFrame,
}

impl WindowExpr {
    /// A window function call with the default frame for its ordering.
    pub fn new(func: WindowFunc, args: Vec<Expr>, partition_by: Vec<Expr>, order_by: Vec<SortExpr>) -> Self {
        let frame = WindowFrame::default_for(!order_by.is_empty());
        Self { func, args, distinct: false, filter: None, ignore_nulls: false, partition_by, order_by, frame }
    }

    pub fn validate(&self) -> Result<()> {
        let (lo, hi) = self.func.arity();
        if self.args.len() < lo || self.args.len() > hi {
            return Err(WhError::Plan(format!(
                "{}() expects {} argument(s), got {}",
                self.func.name(),
                if lo == hi { lo.to_string() } else { format!("{lo} to {hi}") },
                self.args.len()
            )));
        }
        if matches!(self.func, WindowFunc::Rank | WindowFunc::DenseRank | WindowFunc::PercentRank | WindowFunc::CumeDist)
            && self.order_by.is_empty()
        {
            // every row is a peer of every other: legal, but almost surely a mistake
            return Err(WhError::Plan(format!("{}() requires ORDER BY in its window", self.func.name())));
        }
        let constant_arg = |i: usize| self.args.get(i).is_none_or(|a| a.is_literal());
        match self.func {
            WindowFunc::Ntile | WindowFunc::NthValue if !constant_arg(self.args.len() - 1) => {
                return Err(WhError::NotSupported(format!("{}() with a non-constant argument", self.func.name())));
            }
            WindowFunc::Lag | WindowFunc::Lead if !constant_arg(1) => {
                return Err(WhError::NotSupported(format!("{}() with a non-constant offset", self.func.name())));
            }
            _ => {}
        }
        if self.distinct && !matches!(self.func, WindowFunc::Agg(_)) {
            return Err(WhError::Plan(format!("DISTINCT is not allowed in {}()", self.func.name())));
        }
        if self.ignore_nulls && !matches!(self.func, WindowFunc::Lag | WindowFunc::Lead | WindowFunc::FirstValue | WindowFunc::LastValue | WindowFunc::NthValue) {
            return Err(WhError::Plan(format!("IGNORE NULLS is not allowed in {}()", self.func.name())));
        }
        self.frame.validate(&self.order_by)
    }
}

impl fmt::Display for WindowExpr {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let args = self.args.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(", ");
        let star = matches!(self.func, WindowFunc::Agg(AggFunc::Count)) && self.args.is_empty();
        write!(f, "{}({}{})", self.func.name(), if self.distinct { "DISTINCT " } else { "" }, if star { "*" } else { &args })?;
        if self.ignore_nulls {
            write!(f, " IGNORE NULLS")?;
        }
        if let Some(fl) = &self.filter {
            write!(f, " FILTER (WHERE {fl})")?;
        }
        let mut spec = vec![];
        if !self.partition_by.is_empty() {
            spec.push(format!(
                "PARTITION BY {}",
                self.partition_by.iter().map(|e| e.to_string()).collect::<Vec<_>>().join(", ")
            ));
        }
        if !self.order_by.is_empty() {
            spec.push(format!("ORDER BY {}", self.order_by.iter().map(|e| e.to_string()).collect::<Vec<_>>().join(", ")));
        }
        if self.func.uses_frame() && self.frame != WindowFrame::default_for(!self.order_by.is_empty()) {
            spec.push(self.frame.to_string());
        }
        write!(f, " OVER ({})", spec.join(" "))
    }
}

/// Compute the window functions used by `exprs` in one Window node over
/// `input`, and rewrite `exprs` to read their results (keeping the output
/// names).
pub fn plan_windows(input: Arc<LogicalPlan>, exprs: Vec<Expr>) -> Result<(LogicalPlan, Vec<Expr>)> {
    let mut windows: Vec<Expr> = vec![];
    for e in &exprs {
        e.visit(&mut |x| {
            if matches!(x, Expr::Window(_)) {
                if !windows.contains(x) {
                    windows.push(x.clone());
                }
                return false;
            }
            true
        });
    }
    if windows.is_empty() {
        return Ok((input.as_ref().clone(), exprs));
    }
    let names: Vec<String> = windows.iter().map(|w| w.to_string()).collect();
    let aliased = windows.iter().zip(&names).map(|(w, n)| w.clone().alias(n.clone())).collect();
    let plan = LogicalPlan::window(input, aliased)?;
    let rewritten = exprs
        .into_iter()
        .map(|e| {
            let name = e.output_name();
            let r = e.transform_down(&mut |x| {
                if matches!(x, Expr::Window(_)) {
                    let i = windows.iter().position(|w| *w == x).expect("collected above");
                    return Ok((Expr::Column(Column::from_name(names[i].clone())), false));
                }
                Ok((x, true))
            })?;
            Ok(if r.output_name() != name { r.unalias().alias(name) } else { r })
        })
        .collect::<Result<Vec<_>>>()?;
    Ok((plan, rewritten))
}
