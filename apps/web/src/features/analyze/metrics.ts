import type { AnalyzedNode, OperatorMetrics } from "@workhouse/protocol";

import { formatBytes, formatCount, formatDuration } from "@/lib/format";

/** The nodes of a plan, parents before children (pure). */
export function planNodes(plan: AnalyzedNode): AnalyzedNode[] {
  return [plan, ...plan.children.flatMap((c) => planNodes(c))];
}

/** The most time any one operator took (0 without metrics). */
export function hottestMs(plan: AnalyzedNode): number {
  return Math.max(0, ...planNodes(plan).map((n) => n.metrics?.elapsed_ms ?? 0));
}

/** The share of the run's time an operator took, 0..1 (parallel operators can add up to more: clamped). */
export function timeShare(node: AnalyzedNode, totalMs: number): number {
  if (!node.metrics || totalMs <= 0) return 0;
  return Math.min(1, node.metrics.elapsed_ms / totalMs);
}

/** How much of the hottest operator's time a node took, 0..1: the strength of its tint. */
export function heat(node: AnalyzedNode, hottest: number): number {
  if (!node.metrics || hottest <= 0) return 0;
  return Math.min(1, node.metrics.elapsed_ms / hottest);
}

/** An operator's metrics as label/value rows, for its details (the optional ones only when reported). */
export function metricRows(m: OperatorMetrics, share: number): [string, string][] {
  const rows: [string, string][] = [
    ["Rows out", formatCount(m.rows_out)],
    ["Time", formatDuration(m.elapsed_ms)],
    ["Share of the run", `${Math.round(share * 100)}%`],
  ];
  if (m.batches != null) rows.push(["Batches", formatCount(m.batches)]);
  if (m.memory_peak != null) rows.push(["Memory peak", formatBytes(m.memory_peak)]);
  if (m.spilled_bytes != null) rows.push(["Spilled", formatBytes(m.spilled_bytes)]);
  return rows;
}
