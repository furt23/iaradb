//! Window expressions for the DataFrame API (`Expr.over`, `rank`, `shift`,
//! `cum_sum`, ...).

use iara_core::expr::{AggFunc, Expr, FrameBound, FrameUnits, SortExpr, WindowExpr, WindowFrame, WindowFunc};
use iara_core::{Scalar, WhError};

type Result<T> = std::result::Result<T, WhError>;

/// `units` is `rows`, `range` or `groups`; `start` and `end` are offsets
/// relative to the current row (negative: preceding, positive: following,
/// missing: unbounded).
#[napi_derive::napi(object)]
pub struct FrameSpec {
    pub units: String,
    pub start: Option<i64>,
    pub end: Option<i64>,
}

fn bound(offset: Option<i64>, unbounded: FrameBound) -> FrameBound {
    match offset {
        None => unbounded,
        Some(0) => FrameBound::CurrentRow,
        Some(k) if k < 0 => FrameBound::Preceding(Scalar::int64(-k)),
        Some(k) => FrameBound::Following(Scalar::int64(k)),
    }
}

pub fn frame(FrameSpec { units, start, end }: FrameSpec) -> Result<WindowFrame> {
    let units = match units.to_ascii_lowercase().as_str() {
        "rows" => FrameUnits::Rows,
        "range" => FrameUnits::Range,
        "groups" => FrameUnits::Groups,
        o => return Err(WhError::Plan(format!("unknown frame units '{o}' (expected rows, range or groups)"))),
    };
    Ok(WindowFrame::new(units, bound(start, FrameBound::UnboundedPreceding), bound(end, FrameBound::UnboundedFollowing)))
}

fn sort_keys(order_by: Vec<Expr>, descending: &[bool], nulls_last: &[bool]) -> Vec<SortExpr> {
    order_by
        .into_iter()
        .enumerate()
        .map(|(i, e)| {
            let desc = descending.get(i).copied().unwrap_or(false);
            let nulls_first = !nulls_last.get(i).copied().unwrap_or(true);
            SortExpr::new(e, desc, nulls_first)
        })
        .collect()
}

/// A window function that gets its partitioning (and ordering, if it has
/// none) from a later `over()`.
pub fn function(name: &str, args: Vec<Expr>, order_by: Vec<Expr>, descending: &[bool], frame_spec: Option<FrameSpec>) -> Result<Expr> {
    let func = match WindowFunc::from_name(name) {
        Some(f) => f,
        None => WindowFunc::Agg(AggFunc::from_name(name).ok_or_else(|| WhError::Plan(format!("unknown window function '{name}'")))?),
    };
    let mut w = WindowExpr::new(func, args, vec![], sort_keys(order_by, descending, &[]));
    if let Some(f) = frame_spec {
        w.frame = frame(f)?;
    }
    Ok(Expr::Window(Box::new(w)))
}

pub fn over(
    e: Expr,
    partition_by: Vec<Expr>,
    order_by: Vec<Expr>,
    descending: &[bool],
    nulls_last: &[bool],
    frame_spec: Option<FrameSpec>,
) -> Result<Expr> {
    let frame = frame_spec.map(frame).transpose()?;
    e.over(partition_by, sort_keys(order_by, descending, nulls_last), frame)
}
