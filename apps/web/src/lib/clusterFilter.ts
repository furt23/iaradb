/** Search and filters of the Compute page's cluster list (pure). */

import type { ClusterState, ClusterView } from "@/server/compute/types";

export interface ClusterFilter {
  /** matched against name, instance type and owner (case-insensitive) */
  query: string;
  state: "all" | "running" | "stopped";
  /** exact owner email (null: anyone) */
  owner: string | null;
  /** false hides the clusters made for job runs */
  jobs: boolean;
}

export const EMPTY_FILTER: ClusterFilter = { query: "", state: "all", owner: null, jobs: true };

const RUNNING: ClusterState[] = ["starting", "running", "terminating"];
const STOPPED: ClusterState[] = ["terminated", "error"];

/** The clusters that pass every part of the filter, in their order. */
export function filterClusters(clusters: ClusterView[], f: ClusterFilter): ClusterView[] {
  const q = f.query.trim().toLowerCase();
  return clusters.filter((c) => {
    if (q) {
      const haystack = [c.name, c.instanceType?.name, c.owner].filter(Boolean).join("\n").toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    if (f.state === "running" && !RUNNING.includes(c.state)) return false;
    if (f.state === "stopped" && !STOPPED.includes(c.state)) return false;
    if (f.owner !== null && c.owner !== f.owner) return false;
    if (!f.jobs && c.job) return false;
    return true;
  });
}

/** How many clusters are running, stopped, and in total (the toggle counts). */
export function stateCounts(clusters: ClusterView[]): { all: number; running: number; stopped: number } {
  return {
    all: clusters.length,
    running: clusters.filter((c) => RUNNING.includes(c.state)).length,
    stopped: clusters.filter((c) => STOPPED.includes(c.state)).length,
  };
}

/** The distinct owners of the clusters, sorted. */
export function owners(clusters: ClusterView[]): string[] {
  const set = new Set<string>();
  for (const c of clusters) if (c.owner) set.add(c.owner);
  return [...set].sort((a, b) => a.localeCompare(b));
}
