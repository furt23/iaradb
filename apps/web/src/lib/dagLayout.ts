/**
 * The picture of a job's task graph (pure): tasks in layers from left to
 * right (a task's layer is the longest path from a task without upstream
 * tasks), each layer centred top to bottom in declaration order. Tasks in a
 * cycle get no position (validateDag reports them).
 */

import { topoOrder } from "./jobDag";
import type { TaskSpec } from "./jobs";

/** the size of a task's box and the gaps between boxes, in pixels */
export const DAG_NODE = { width: 200, height: 56, layerGap: 72, rowGap: 24 } as const;

export interface DagNode {
  key: string;
  /** 0 for the tasks without upstream tasks */
  layer: number;
  /** the row within the layer */
  index: number;
  /** the top left corner of the box */
  x: number;
  y: number;
}

/** an arrow from an upstream task to a task that depends on it */
export interface DagEdge {
  from: string;
  to: string;
}

export interface DagLayout {
  nodes: DagNode[];
  edges: DagEdge[];
  width: number;
  height: number;
}

export function layoutDag(tasks: TaskSpec[]): DagLayout {
  const unique = [...new Map(tasks.map((t) => [t.key, t])).values()];
  const byKey = new Map(unique.map((t) => [t.key, t]));

  const layer = new Map<string, number>();
  for (const key of topoOrder(unique)) {
    const ups = (byKey.get(key)?.dependsOn ?? []).filter((k) => layer.has(k));
    layer.set(key, Math.max(-1, ...ups.map((k) => layer.get(k) ?? -1)) + 1);
  }
  const placed = unique.filter((t) => layer.has(t.key));
  const at = (key: string) => layer.get(key) ?? 0;

  // tasks per layer (layers are contiguous: a task sits one layer under its deepest upstream)
  const counts = new Map<number, number>();
  for (const t of placed) counts.set(at(t.key), (counts.get(at(t.key)) ?? 0) + 1);
  const layers = counts.size;
  const tallest = Math.max(0, ...counts.values());

  const rowOf = new Map<number, number>();
  const nodes: DagNode[] = placed.map((t) => {
    const l = at(t.key);
    const index = rowOf.get(l) ?? 0;
    rowOf.set(l, index + 1);
    // a shorter layer is centred against the tallest one
    const y = ((tallest - (counts.get(l) ?? 0)) / 2 + index) * (DAG_NODE.height + DAG_NODE.rowGap);
    return { key: t.key, layer: l, index, x: l * (DAG_NODE.width + DAG_NODE.layerGap), y };
  });

  const edges: DagEdge[] = [];
  const keys = new Set(placed.map((t) => t.key));
  for (const t of placed) {
    for (const up of new Set(t.dependsOn)) {
      if (up !== t.key && keys.has(up)) edges.push({ from: up, to: t.key });
    }
  }

  return {
    nodes,
    edges,
    width: layers ? layers * DAG_NODE.width + (layers - 1) * DAG_NODE.layerGap : 0,
    height: tallest ? tallest * DAG_NODE.height + (tallest - 1) * DAG_NODE.rowGap : 0,
  };
}
