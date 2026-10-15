//! `func(..) OVER (..)`: window specifications, named windows and frames.

use sqlparser::ast as sql;

use super::{Scope, SqlPlanner, ident, sort_opts};
use crate::error::{Result, WhError};
use crate::expr::{AggFunc, Expr, FrameBound, FrameUnits, SortExpr, WindowExpr, WindowFrame, WindowFunc};
use crate::physical::expr::evaluate_constant;
use crate::schema::PlanSchema;

/// A window specification before it is attached to a function.
pub(super) struct Spec {
    partition_by: Vec<Expr>,
    order_by: Vec<SortExpr>,
    frame: Option<WindowFrame>,
}

impl SqlPlanner<'_> {
    /// The WINDOW clause definitions of the SELECT being planned.
    fn named_window(&self, name: &sql::Ident) -> Result<sql::WindowSpec> {
        let wanted = ident(name);
        let defs = self.windows.last().map(|v| v.as_slice()).unwrap_or(&[]);
        let mut seen = 0;
        let mut current = wanted.clone();
        loop {
            let def = defs
                .iter()
                .find(|d| ident(&d.0).eq_ignore_ascii_case(&current))
                .ok_or_else(|| WhError::Plan(format!("window '{current}' is not defined")))?;
            match &def.1 {
                sql::NamedWindowExpr::WindowSpec(s) => return Ok(s.clone()),
                sql::NamedWindowExpr::NamedWindow(other) => current = ident(other),
            }
            seen += 1;
            if seen > defs.len() {
                return Err(WhError::Plan(format!("window '{wanted}' is defined in terms of itself")));
            }
        }
    }

    fn window_spec(&mut self, over: &sql::WindowType, scope: Scope<'_>) -> Result<Spec> {
        let spec = match over {
            sql::WindowType::NamedWindow(name) => self.named_window(name)?,
            sql::WindowType::WindowSpec(s) => s.clone(),
        };
        // `OVER (w ORDER BY ..)` refines the named window `w`
        let base = match &spec.window_name {
            Some(name) => Some(self.named_window(name)?),
            None => None,
        };
        let partition = match &base {
            Some(_) if !spec.partition_by.is_empty() => {
                return Err(WhError::Plan("a window that refines another cannot redefine PARTITION BY".into()));
            }
            Some(b) => b.partition_by.clone(),
            None => spec.partition_by.clone(),
        };
        let order = match &base {
            Some(b) if spec.order_by.is_empty() => b.order_by.clone(),
            _ => spec.order_by.clone(),
        };
        let frame = spec.window_frame.clone().or_else(|| base.and_then(|b| b.window_frame));
        let partition_by = partition.iter().map(|e| self.sql_expr(e, scope)).collect::<Result<_>>()?;
        let mut order_by = vec![];
        for o in &order {
            let (desc, nulls_first) = sort_opts(o);
            order_by.push(SortExpr::new(self.sql_expr(&o.expr, scope)?, desc, nulls_first));
        }
        let frame = frame.map(|f| self.window_frame(&f)).transpose()?;
        Ok(Spec { partition_by, order_by, frame })
    }

    fn frame_bound(&mut self, b: &sql::WindowFrameBound, units: FrameUnits) -> Result<FrameBound> {
        let offset = |this: &mut Self, e: &sql::Expr| -> Result<crate::scalar::Scalar> {
            let empty = PlanSchema::empty();
            let x = this.sql_expr(e, Scope::new(&empty, None))?;
            let v = evaluate_constant(&x)?.ok_or_else(|| WhError::Plan(format!("window frame offset must be a constant: {e}")))?;
            // ROWS / GROUPS count rows: a whole number like 2.0 is fine
            if units != FrameUnits::Range && !v.data_type().is_integer() {
                if let Some(n) = v.as_f64().filter(|n| n.fract() == 0.0) {
                    return Ok(crate::scalar::Scalar::int64(n as i64));
                }
            }
            Ok(v)
        };
        Ok(match b {
            sql::WindowFrameBound::CurrentRow => FrameBound::CurrentRow,
            sql::WindowFrameBound::Preceding(None) => FrameBound::UnboundedPreceding,
            sql::WindowFrameBound::Following(None) => FrameBound::UnboundedFollowing,
            sql::WindowFrameBound::Preceding(Some(e)) => FrameBound::Preceding(offset(self, e)?),
            sql::WindowFrameBound::Following(Some(e)) => FrameBound::Following(offset(self, e)?),
        })
    }

    fn window_frame(&mut self, f: &sql::WindowFrame) -> Result<WindowFrame> {
        let units = match f.units {
            sql::WindowFrameUnits::Rows => FrameUnits::Rows,
            sql::WindowFrameUnits::Range => FrameUnits::Range,
            sql::WindowFrameUnits::Groups => FrameUnits::Groups,
        };
        let start = self.frame_bound(&f.start_bound, units)?;
        let end = match &f.end_bound {
            Some(b) => self.frame_bound(b, units)?,
            None => FrameBound::CurrentRow,
        };
        Ok(WindowFrame::new(units, start, end))
    }

    /// `name(args) [FILTER (..)] [IGNORE NULLS] OVER (..)`.
    pub(super) fn window_function(
        &mut self,
        f: &sql::Function,
        over: &sql::WindowType,
        name: &str,
        args: Vec<Expr>,
        distinct: bool,
        filter: Option<Expr>,
        scope: Scope<'_>,
    ) -> Result<Expr> {
        let func = match WindowFunc::from_name(name) {
            Some(w) => w,
            None => match name {
                "count_distinct" | "n_unique" => WindowFunc::Agg(AggFunc::Count),
                _ => WindowFunc::Agg(
                    AggFunc::from_name(name).ok_or_else(|| WhError::NotSupported(format!("window function '{name}'")))?,
                ),
            },
        };
        let distinct = distinct || matches!(name, "count_distinct" | "n_unique");
        let mut ignore_nulls = matches!(f.null_treatment, Some(sql::NullTreatment::IgnoreNulls));
        if let sql::FunctionArguments::List(l) = &f.args {
            for c in &l.clauses {
                if let sql::FunctionArgumentClause::IgnoreOrRespectNulls(t) = c {
                    ignore_nulls = matches!(t, sql::NullTreatment::IgnoreNulls);
                }
            }
        }
        let spec = self.window_spec(over, scope)?;
        let mut w = WindowExpr::new(func, args, spec.partition_by, spec.order_by);
        if let Some(frame) = spec.frame {
            w.frame = frame;
        }
        w.distinct = distinct;
        w.filter = filter;
        w.ignore_nulls = ignore_nulls;
        w.validate()?;
        Ok(Expr::Window(Box::new(w)))
    }
}
