/** Uptime, idle time and auto-termination of clusters, for the UI (pure). */

import type { ClusterView } from "@/server/compute/types";

/** Whole minutes from `t` to `now` (null without a time). */
export function minutesSince(t: number | undefined, now: number): number | null {
  return t ? Math.max(0, Math.floor((now - t) / 60_000)) : null;
}

/** "12 min", "2 h 5 min" */
export function formatMinutes(m: number): string {
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/** Minutes left before a running EC2 cluster is terminated for being idle (null when that does not apply). */
export function terminatesIn(c: ClusterView, now: number): number | null {
  if (c.kind !== "ec2" || c.state !== "running" || !c.autoTerminateMinutes) return null;
  const idle = minutesSince(c.lastActivity ?? c.startedAt, now);
  return idle === null ? null : Math.max(0, c.autoTerminateMinutes - idle);
}
