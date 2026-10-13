import { formatCount } from "./format";

/** The metric names Delta writers use for rows and files, first match wins. */
const ROWS_ADDED = ["numOutputRows", "numTargetRowsInserted", "numAddedRows"];
const ROWS_REMOVED = ["numDeletedRows", "numTargetRowsDeleted", "numRemovedRows"];
const ROWS_UPDATED = ["numUpdatedRows", "numTargetRowsUpdated"];
const FILES_ADDED = ["numAddedFiles", "numFiles"];
const FILES_REMOVED = ["numRemovedFiles"];

function metric(metrics: Record<string, string>, names: string[]): number | null {
  for (const n of names) {
    const raw = metrics[n];
    if (raw === undefined) continue;
    const v = Number(raw);
    if (Number.isFinite(v)) return v;
  }
  return null;
}

/** The headline metrics of a commit as short labels (`+120 rows`, `2 files added`); none that are zero or missing. */
export function summariseMetrics(metrics: Record<string, string>): string[] {
  const out: string[] = [];
  const add = (v: number | null, label: (n: string) => string) => {
    if (v !== null && v > 0) out.push(label(formatCount(v)));
  };
  add(metric(metrics, ROWS_ADDED), (n) => `+${n} rows`);
  add(metric(metrics, ROWS_UPDATED), (n) => `~${n} rows`);
  add(metric(metrics, ROWS_REMOVED), (n) => `-${n} rows`);
  add(metric(metrics, FILES_ADDED), (n) => `${n} files added`);
  add(metric(metrics, FILES_REMOVED), (n) => `${n} files removed`);
  return out;
}

export function versionQuery(table: string, version: number): string {
  return `SELECT * FROM ${table} VERSION AS OF ${version} LIMIT 100`;
}

export function restoreStatement(table: string, version: number): string {
  return `RESTORE TABLE ${table} TO VERSION AS OF ${version}`;
}

/** The parameters or metrics of a commit as indented JSON; values that are JSON (numbers, lists) are shown as such. */
export function prettyValues(values: Record<string, string>): string {
  const parsed = Object.fromEntries(
    Object.entries(values).map(([k, v]) => {
      try {
        return [k, JSON.parse(v) as unknown];
      } catch {
        return [k, v];
      }
    }),
  );
  return JSON.stringify(parsed, null, 2);
}
