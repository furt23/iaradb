import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { HistoryEntry } from "@iara/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryTableRow } from "@/lib/system/types";

import { appendQuery, recentQueries } from "./queryLog";
import { rowsFile } from "./paths";

const DAY = 86_400;
const ctx = { user: "ana@example.com", kernel: "workspace", cluster: null };

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry => ({
  ts: 1_700_000_000,
  kind: "sql",
  query: "SELECT 1",
  source: "sql editor",
  elapsed_ms: 3,
  rows: 1,
  error: null,
  memory_peak: null,
  spilled_bytes: null,
  requests: null,
  reads: [],
  writes: [],
  ...over,
});

const lines = (file: string) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "querylog-"));
  process.env.IARA_STUDIO_DATA = dir;
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.IARA_STUDIO_DATA;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the query log", () => {
  it("appends the run and one row per table it read or wrote", () => {
    appendQuery(
      entry({
        reads: [{ table: "sales.orders", location: "/ws/orders", version: 3 }],
        writes: [{ table: null, location: "s3://b/out", version: null, operation: "WRITE" }],
      }),
      ctx,
    );
    const day = rowsFile("queries", "2023-11-14");
    const [run] = lines(day).map((l) => JSON.parse(l));
    expect(run).toMatchObject({ query: "SELECT 1", ts: 1_700_000_000_000, user: "ana@example.com", kernel: "workspace", cluster: null });
    expect(typeof run.id).toBe("string");
    const rows = lines(rowsFile("query_tables", "2023-11-14")).map((l) => JSON.parse(l) as QueryTableRow);
    expect(rows).toEqual([
      { query_id: run.id, ts: 1_700_000_000_000, user: "ana@example.com", kernel: "workspace", source: "sql editor", access: "read", table: "sales.orders", location: "/ws/orders", version: 3, operation: null },
      { query_id: run.id, ts: 1_700_000_000_000, user: "ana@example.com", kernel: "workspace", source: "sql editor", access: "write", table: null, location: "s3://b/out", version: null, operation: "WRITE" },
    ]);
  });

  it("returns the newest runs first across days, and respects the limit", () => {
    appendQuery(entry({ ts: 1_700_000_000, query: "old" }), ctx);
    appendQuery(entry({ ts: 1_700_000_000 + DAY, query: "middle" }), ctx);
    appendQuery(entry({ ts: 1_700_000_000 + DAY + 5, query: "new" }), ctx);
    expect(recentQueries(10).map((r) => r.query)).toEqual(["new", "middle", "old"]);
    expect(recentQueries(2).map((r) => r.query)).toEqual(["new", "middle"]);
  });

  it("skips a line that does not parse", () => {
    appendQuery(entry({ query: "good" }), ctx);
    fs.appendFileSync(rowsFile("queries", "2023-11-14"), "{not json\n");
    expect(recentQueries(10).map((r) => r.query)).toEqual(["good"]);
  });

  it("does not throw when the folder cannot be written", () => {
    const blocker = path.join(dir, "blocker");
    fs.writeFileSync(blocker, "a file, not a folder");
    process.env.IARA_STUDIO_DATA = path.join(blocker, "data");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => appendQuery(entry(), ctx)).not.toThrow();
    expect(error).toHaveBeenCalled();
  });
});
