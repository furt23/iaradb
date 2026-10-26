import type { AnalyzedNode, PipelineStats } from "@iara/protocol";

import { operatorName } from "@/features/results/operators";

/** A pipeline's sink as the profile names it, without "Sink": JoinBuild, Aggregate, Sort… */
export function sinkName(sink: string): string {
  return sink.replace(/Sink$/, "");
}

/**
 * What a pipeline reads, in a word: the table a scan reads, else the operator
 * whose output it reads. `nodes` are the plan's nodes in pre-order.
 */
export function sourceLabel(p: PipelineStats, nodes: AnalyzedNode[]): string {
  const id = p.nodes?.[0];
  const node = id == null ? undefined : nodes[id];
  if (!node) return operatorName(p.source);
  // `ParquetScan[customer, files=1, …]`
  const table = /^\w*Scan\[([^,\]=]+)[,\]]/.exec(node.detail)?.[1]?.trim();
  return table || node.name;
}

/** The pipelines before `index` that end in plan node `id`: a join's build side, or the result a source reads. */
export function pipelinesInto(pipelines: PipelineStats[], index: number, id: number): number[] {
  return pipelines.flatMap((p, j) => (j < index && p.nodes?.at(-1) === id ? [j] : []));
}

/** The first pipeline after `index` that goes on from the node it ends in (null: the query's result). */
export function pipelineAfter(pipelines: PipelineStats[], index: number): number | null {
  const last = pipelines[index]?.nodes?.at(-1);
  if (last == null) return null;
  const j = pipelines.findIndex((p, k) => k > index && p.nodes?.includes(last));
  return j < 0 ? null : j;
}
