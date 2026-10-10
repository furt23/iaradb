/** Recently opened workspace files, most recent first (pure). */

import { isWithin, movedPath } from "@/lib/paths";

export const MAX_RECENT = 8;

export function touchRecent(recent: string[], path: string): string[] {
  if (recent[0] === path) return recent;
  return [path, ...recent.filter((p) => p !== path)].slice(0, MAX_RECENT);
}

/** A file or folder moved: its entries follow. */
export function renameRecent(recent: string[], from: string, to: string): string[] {
  return recent.map((p) => movedPath(p, from, to) ?? p);
}

/** A file or folder was deleted: its entries go. */
export function dropRecent(recent: string[], path: string): string[] {
  return recent.filter((p) => !isWithin(p, path));
}

export function parseRecent(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((p): p is string => typeof p === "string"))].slice(0, MAX_RECENT) : [];
}
