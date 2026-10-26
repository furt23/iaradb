import "server-only";

import crypto from "node:crypto";

import type { CrossPicks, Dataset, FilterValues, RenderResult, Widget } from "@/lib/dashboards/types";

/**
 * Rendered dashboards, in memory: every viewer who asks within a dashboard's
 * refresh time gets the same render, and viewers who ask at the same moment
 * share one run. Lost on restart, which only costs a render.
 */

const MAX_ENTRIES = 200;

interface Entry {
  at: number;
  result: Promise<RenderResult>;
}

const globalForCache = globalThis as unknown as { __iaraDashboardCache?: Map<string, Entry> };
/** Survives module reloads in development; oldest entry first. */
const entries: Map<string, Entry> = (globalForCache.__iaraDashboardCache ??= new Map());

/**
 * The key of a render: the dashboard `id`, its content (a republish changes it),
 * the filter values, the chart picks and the tables the viewer may read, so
 * viewers with different grants never share a render.
 */
export function cacheKey(id: string, content: { datasets: Dataset[]; widgets: Widget[] }, values: FilterValues, allow: string[] | null, cross: CrossPicks): string {
  const hash = crypto.createHash("sha1").update(JSON.stringify([content.datasets, content.widgets])).digest("hex");
  // sorted, so the same values asked in another order are one entry
  const sorted = Object.entries(values).sort(([a], [b]) => (a < b ? -1 : 1));
  const grants = allow ? [...allow].sort() : null;
  // a chart is picked once, so its id orders the picks
  const picks = [...cross].sort((a, b) => (a.widget < b.widget ? -1 : 1)).map((p) => [p.widget, p.value]);
  return `${id}:${hash}:${JSON.stringify(sorted)}:${JSON.stringify(grants)}:${JSON.stringify(picks)}`;
}

/** The render under `key` if it is younger than `ttlMs`, else `fn()` (kept for the next ones). A failed run is not kept. */
export function cached(key: string, ttlMs: number, fn: () => Promise<RenderResult>): Promise<RenderResult> {
  const hit = entries.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.result;
  entries.delete(key);
  const entry: Entry = { at: Date.now(), result: fn() };
  entries.set(key, entry);
  entry.result.catch(() => {
    if (entries.get(key) === entry) entries.delete(key);
  });
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  return entry.result;
}

/** Forget the renders of a dashboard (it was republished, unpublished or deleted). */
export function forget(id: string): void {
  for (const key of [...entries.keys()]) if (key.startsWith(`${id}:`)) entries.delete(key);
}
