//! `EXPLAIN ANALYZE`: run a query measuring every operator, and show the
//! physical plan with what each operator did.
//!
//! The measuring itself is in [`crate::exec::metrics`]; here a run is
//! started, and the numbers are laid over the plan's nodes.

use std::fmt::Write as _;
use std::sync::Arc;

use arrow::record_batch::RecordBatch;

use crate::error::Result;
use crate::exec::metrics::{OperatorMetrics, PlanMetrics};
use crate::exec::query::{QueryStats, with_query};
use crate::logical::LogicalPlan;
use crate::optimizer::optimize;
use crate::physical::execute::execute_analyzed;
use crate::physical::planner::{PlanNode, create_physical_plan};

/// A plan node with its run metrics (None: the node took no part in the run).
#[derive(Clone, Debug)]
pub struct AnalyzedNode {
    pub name: String,
    pub detail: String,
    pub role: Option<&'static str>,
    pub metrics: Option<OperatorMetrics>,
    pub children: Vec<AnalyzedNode>,
}

/// A plan with the metrics of its nodes: node `i` in pre-order (the order
/// of `PhysicalPlan::tree`) gets the metrics of node `i`.
pub fn analyzed_plan(tree: &PlanNode, metrics: &PlanMetrics) -> AnalyzedNode {
    fn node(n: &PlanNode, metrics: &PlanMetrics, next: &mut usize) -> AnalyzedNode {
        let id = *next;
        *next += 1;
        AnalyzedNode {
            name: n.name.clone(),
            detail: n.detail.clone(),
            role: n.role,
            metrics: metrics.snapshot(id),
            children: n.children.iter().map(|c| node(c, metrics, next)).collect(),
        }
    }
    node(tree, metrics, &mut 0)
}

/// An analyzed run.
pub struct Analysis {
    /// rows of the result (which was not kept)
    pub rows: u64,
    pub plan: AnalyzedNode,
    pub stats: QueryStats,
}

/// Run a query as an observable, cancellable one with every operator
/// measured; its result is handed to `emit` as it is produced.
pub fn analyze_with(plan: &LogicalPlan, emit: &mut (dyn FnMut(RecordBatch) -> Result<()> + Send)) -> Result<Analysis> {
    with_query(|q| {
        let phys = create_physical_plan(&optimize(plan)?)?;
        let metrics = Arc::new(PlanMetrics::new(phys.node_count()));
        let mut rows = 0u64;
        execute_analyzed(&phys, &metrics, &mut |b| {
            rows += b.num_rows() as u64;
            emit(b)
        })?;
        Ok(Analysis { rows, plan: analyzed_plan(&phys.tree(), &metrics), stats: q.stats() })
    })
}

/// [`analyze_with`], discarding the result.
pub fn analyze(plan: &LogicalPlan) -> Result<Analysis> {
    analyze_with(plan, &mut |_| Ok(()))
}

/// The plan as text, one line per operator with what it did.
pub fn plan_text(plan: &AnalyzedNode) -> String {
    fn go(n: &AnalyzedNode, depth: usize, out: &mut String) {
        let indent = "  ".repeat(depth);
        match &n.metrics {
            Some(m) => {
                let _ = writeln!(out, "{indent}{}  ({})", n.detail, metrics_text(m));
            }
            None => {
                let _ = writeln!(out, "{indent}{}", n.detail);
            }
        }
        for c in &n.children {
            match c.role {
                Some(role) => {
                    let _ = writeln!(out, "{indent}  [{role}]");
                    go(c, depth + 2, out);
                }
                None => go(c, depth + 1, out),
            }
        }
    }
    let mut out = String::new();
    go(plan, 0, &mut out);
    out
}

fn metrics_text(m: &OperatorMetrics) -> String {
    let mut s = format!("rows={} time={:.2}ms", m.rows_out, m.elapsed_ms);
    if let Some(b) = m.memory_peak {
        let _ = write!(s, " memory={}", bytes_text(b));
    }
    if let Some(b) = m.spilled_bytes {
        let _ = write!(s, " spilled={}", bytes_text(b));
    }
    s
}

fn bytes_text(b: u64) -> String {
    const UNITS: [&str; 4] = ["B", "KB", "MB", "GB"];
    let (mut v, mut u) = (b as f64, 0);
    while v >= 1024.0 && u < UNITS.len() - 1 {
        v /= 1024.0;
        u += 1;
    }
    if u == 0 { format!("{b}B") } else { format!("{v:.1}{}", UNITS[u]) }
}

/// `EXPLAIN ANALYZE`: run the query (its result is discarded) and show its
/// physical plan with the metrics of every operator.
pub fn explain_analyze(plan: &LogicalPlan) -> Result<String> {
    Ok(plan_text(&analyze(plan)?.plan))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn node(detail: &str, rows: Option<u64>, children: Vec<AnalyzedNode>) -> AnalyzedNode {
        AnalyzedNode {
            name: detail.into(),
            detail: detail.into(),
            role: None,
            metrics: rows.map(|rows_out| OperatorMetrics { rows_out, elapsed_ms: 1.5, batches: 1, memory_peak: None, spilled_bytes: Some(2048) }),
            children,
        }
    }

    #[test]
    fn text_shows_each_operator_with_its_numbers() {
        let mut build = node("Scan b", Some(3), vec![]);
        build.role = Some("build");
        let mut probe = node("Scan a", None, vec![]);
        probe.role = Some("probe");
        let text = plan_text(&node("Join", Some(7), vec![probe, build]));
        assert_eq!(
            text,
            "Join  (rows=7 time=1.50ms spilled=2.0KB)\n  [probe]\n    Scan a\n  [build]\n    Scan b  (rows=3 time=1.50ms spilled=2.0KB)\n"
        );
    }
}
