import "server-only";

import path from "node:path";

import { dataDir } from "../compute/store";

/**
 * Where the Studio keeps the rows of the `system` catalog before they are
 * published: `<data folder>/system/<table>/<file>.jsonl`, one JSON object per
 * line. A log table has one file per UTC day; a snapshot table has one file.
 */

export function systemDir(): string {
  return path.join(dataDir(), "system");
}

/** `2026-11-14`: the UTC day of a time in unix milliseconds. */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function tableDir(table: string): string {
  return path.join(systemDir(), table);
}

/** The JSON lines file `name` (a day, or `snapshot`) of a table. */
export function rowsFile(table: string, name: string): string {
  return path.join(tableDir(table), `${name}.jsonl`);
}
