/** The cluster picker's rules: which clusters it offers, how they group, what the header says (pure). */

import type { ClusterState, ClusterView } from "@/server/compute/types";

import { formatMinutes, minutesSince, terminatesIn } from "./clusterTime";

/** Above this many clusters the picker shows a search field. */
export const SEARCH_THRESHOLD = 6;

const STOPPED: ClusterState[] = ["terminated", "error"];

export interface ClusterGroups {
  running: ClusterView[];
  stopped: ClusterView[];
}

/** Clusters made for job runs are not offered to notebooks. */
export function pickable(clusters: ClusterView[]): ClusterView[] {
  return clusters.filter((c) => !c.job);
}

export function showSearch(clusters: ClusterView[]): boolean {
  return pickable(clusters).length > SEARCH_THRESHOLD;
}

export function isStopped(c: Pick<ClusterView, "state">): boolean {
  return STOPPED.includes(c.state);
}

/** Only EC2 machines that are up or coming up can be terminated from the picker. */
export function canTerminate(c: ClusterView): boolean {
  return c.kind === "ec2" && (c.state === "running" || c.state === "starting");
}

/** The clusters whose name contains `query` (case-insensitive), the default one first, split by whether they run. */
export function groupClusters(clusters: ClusterView[], query = ""): ClusterGroups {
  const q = query.trim().toLowerCase();
  // sort is stable: the other clusters keep their order
  const visible = pickable(clusters)
    .filter((c) => !q || c.name.toLowerCase().includes(q))
    .sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
  return {
    running: visible.filter((c) => !isStopped(c)),
    stopped: visible.filter(isStopped),
  };
}

export function notebooksLabel(n: number): string {
  return `${n} notebook${n === 1 ? "" : "s"}`;
}

/** "up 1 h 5 min · idle 3 min · terminates in 12 min if idle" (null unless an EC2 machine runs). */
export function runtimeSummary(c: ClusterView, now: number): string | null {
  if (c.kind !== "ec2" || c.state !== "running") return null;
  const parts: string[] = [];
  const up = minutesSince(c.startedAt, now);
  if (up !== null) parts.push(`up ${formatMinutes(up)}`);
  const idle = minutesSince(c.lastActivity ?? c.startedAt, now);
  if (idle !== null) parts.push(`idle ${formatMinutes(idle)}`);
  const left = terminatesIn(c, now);
  if (left !== null) parts.push(left === 0 ? "terminates soon if idle" : `terminates in ${formatMinutes(left)} if idle`);
  return parts.join(" · ");
}
