import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { HistoryEntry, TableRead, TableWrite } from "@iara/protocol";

import type { QueryLogEntry, QueryTableRow } from "@/lib/system/types";

import { noteRun } from "./lineage";
import { config } from "../config";
import { dayOf, rowsFile, systemDir, tableDir } from "./paths";

interface RunContext {
  user: string | null;
  kernel: string;
  cluster: string | null;
}

/** Appends a run to the `queries` table and each table it read or wrote to `query_tables`; never throws. */
export function appendQuery(entry: HistoryEntry, ctx: RunContext): void {
  try {
    const ts = Math.round(entry.ts * 1000);
    const id = randomUUID();
    const day = dayOf(ts);
    const tableRow = (t: TableRead | TableWrite, access: "read" | "write"): QueryTableRow => ({
      query_id: id,
      ts,
      user: ctx.user,
      kernel: ctx.kernel,
      source: entry.source,
      access,
      table: t.table,
      location: t.location,
      version: t.version,
      operation: "operation" in t ? t.operation : null,
    });
    const run: QueryLogEntry = { ...entry, id, ts, user: ctx.user, kernel: ctx.kernel, cluster: ctx.cluster };
    const tables = [...entry.reads.map((t) => tableRow(t, "read")), ...entry.writes.map((t) => tableRow(t, "write"))];
    fs.mkdirSync(tableDir("queries"), { recursive: true });
    fs.appendFileSync(rowsFile("queries", day), JSON.stringify(run) + "\n");
    if (tables.length > 0) {
      fs.mkdirSync(tableDir("query_tables"), { recursive: true });
      fs.appendFileSync(rowsFile("query_tables", day), tables.map((r) => JSON.stringify(r) + "\n").join(""));
    }
    noteRun(run);
  } catch (e) {
    console.error("query log: a run was not recorded", e);
  }
}

/** A run as `.iara/history.jsonl` wrote it, before the Studio kept its own log. */
interface LegacyRun {
  ts: number;
  query: string;
  source: string;
  elapsed_ms: number;
  rows: number | null;
  error: string | null;
  params?: Record<string, unknown>;
}

const legacyFile = () => path.join(config.workspace, ".iara", "history.jsonl");
const importedMarker = () => path.join(systemDir(), "legacy-history-imported");

/**
 * Copies the runs of a workspace's old history file into the log, once, the first time the log is read
 * or published. The old file is left as it was. Only the Studio's own workspace folder is read: a cluster
 * kept its history on the cluster's machine, which the Studio does not read.
 */
export function importLegacyHistory(): void {
  try {
    if (fs.existsSync(importedMarker()) || !fs.existsSync(legacyFile())) return;
    const byDay = new Map<string, string>();
    for (const line of fs.readFileSync(legacyFile(), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let run: LegacyRun;
      try {
        run = JSON.parse(line) as LegacyRun;
      } catch {
        continue;
      }
      const ts = Math.round(run.ts * 1000);
      const entry: QueryLogEntry = {
        id: randomUUID(),
        ts,
        kind: "sql",
        query: run.query,
        source: run.source,
        elapsed_ms: run.elapsed_ms,
        rows: run.rows,
        error: run.error,
        ...(run.params && { params: run.params }),
        memory_peak: null,
        spilled_bytes: null,
        requests: null,
        reads: [],
        writes: [],
        user: null,
        kernel: "workspace",
        cluster: null,
      };
      const day = dayOf(ts);
      byDay.set(day, (byDay.get(day) ?? "") + JSON.stringify(entry) + "\n");
    }
    fs.mkdirSync(tableDir("queries"), { recursive: true });
    for (const [day, text] of byDay) fs.appendFileSync(rowsFile("queries", day), text);
    fs.writeFileSync(importedMarker(), new Date().toISOString());
  } catch (e) {
    console.error("query log: the old history is not imported", e);
  }
}

/** The newest `limit` runs, newest first; a line that does not parse is skipped. */
export function recentQueries(limit: number): QueryLogEntry[] {
  importLegacyHistory();
  const dir = tableDir("queries");
  if (!fs.existsSync(dir)) return [];
  const days = fs
    .readdirSync(dir)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .map((f) => f.slice(0, -".jsonl".length))
    .sort()
    .reverse();
  const out: QueryLogEntry[] = [];
  for (const day of days) {
    if (out.length >= limit) break;
    const lines = fs.readFileSync(rowsFile("queries", day), "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
      try {
        out.push(JSON.parse(lines[i]) as QueryLogEntry);
      } catch {
        // a torn or foreign line: skipped
      }
    }
  }
  return out;
}
