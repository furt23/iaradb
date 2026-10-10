/**
 * The text of open SQL files, kept outside their editors: a tab remounts
 * when its file is renamed, and its unsaved text follows it to the new path.
 */

import { isWithin, movedPath } from "@/lib/paths";

export interface Draft {
  text: string;
  /** the text known to be on disk */
  saved: string;
}

export type Drafts = Map<string, Draft>;

export function renameDrafts(drafts: Drafts, from: string, to: string): void {
  for (const [path, draft] of [...drafts]) {
    const next = movedPath(path, from, to);
    if (next === null) continue;
    drafts.delete(path);
    drafts.set(next, draft);
  }
}

export function dropDrafts(drafts: Drafts, path: string): void {
  for (const p of [...drafts.keys()]) if (isWithin(p, path)) drafts.delete(p);
}

/** The open SQL files of this browser tab. */
export const drafts: Drafts = new Map();

const editors = new Map<string, number>();

/** An editor of `path` mounted. */
export function retain(path: string): void {
  editors.set(path, (editors.get(path) ?? 0) + 1);
}

/** An editor of `path` unmounted: whether none is left. */
export function release(path: string): boolean {
  const n = (editors.get(path) ?? 1) - 1;
  if (n > 0) editors.set(path, n);
  else editors.delete(path);
  return n <= 0;
}

export function isEdited(path: string): boolean {
  return editors.has(path);
}
