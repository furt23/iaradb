/**
 * Stage 3b: the relationship graph. Each relationship is a step from the
 * "many" dataset to the "one" dataset it points at; a filter travels the steps
 * backwards and a grouping column is reached by following them. For that to be
 * unambiguous the graph has no cycle and at most one path between two datasets.
 */

import type { Relationship } from "./types";

/** the relationships that leave `dataset` from its many side (dataset.fk → other.key) */
export function outgoing(rels: readonly Relationship[], dataset: string): Relationship[] {
  return rels.filter((r) => r.many.dataset === dataset);
}

/** Every dataset reachable from `from` and the steps that lead there (breadth first, so a graph with a cycle still ends). */
function walk(rels: readonly Relationship[], from: string): Map<string, Relationship[]> {
  const paths = new Map<string, Relationship[]>([[from, []]]);
  for (const dataset of paths.keys()) {
    for (const r of outgoing(rels, dataset)) {
      if (!paths.has(r.one.dataset)) paths.set(r.one.dataset, [...paths.get(dataset)!, r]);
    }
  }
  return paths;
}

/** the many→one steps from `from` to `to` (empty when from === to; null when `to` is not reachable) */
export function pathToOne(rels: readonly Relationship[], from: string, to: string): Relationship[] | null {
  return walk(rels, from).get(to) ?? null;
}

/** every dataset reachable from `from` through many→one steps, `from` first */
export function reachable(rels: readonly Relationship[], from: string): string[] {
  return [...walk(rels, from).keys()];
}

const step = (r: Relationship) => `${r.many.dataset}.${r.many.column} → ${r.one.dataset}.${r.one.column}`;
/** `orders.customer_id → customers.id then customers.region_id → regions.id` */
const route = (steps: readonly Relationship[]) => steps.map(step).join(" then ");

/**
 * Why `rel` cannot join `rels`, or null when it fits: it would close a cycle,
 * or give some dataset a second path to another one. The text names both paths.
 */
export function conflict(rels: readonly Relationship[], rel: Relationship): string | null {
  const { many, one } = rel;
  const back = pathToOne(rels, one.dataset, many.dataset);
  if (back) return `this relationship creates a cycle: ${route([rel])} and, the other way, ${route(back)}`;

  // new paths run from a dataset that reaches `many` (or `many` itself), over `rel`, to a dataset `one` reaches (or `one` itself)
  const starts = new Set([many.dataset, ...rels.map((r) => r.many.dataset)]);
  for (const from of starts) {
    const head = pathToOne(rels, from, many.dataset);
    if (!head) continue;
    for (const to of reachable(rels, one.dataset)) {
      const existing = pathToOne(rels, from, to);
      if (!existing) continue;
      const added = [...head, rel, ...pathToOne(rels, one.dataset, to)!];
      return `this relationship gives ${from} a second path to ${to}: ${route(added)} and ${route(existing)}`;
    }
  }
  return null;
}
