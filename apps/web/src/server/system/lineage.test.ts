import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { QueryLogEntry } from "@/lib/system/types";

type Lineage = typeof import("./lineage");

const run = (over: Partial<QueryLogEntry> = {}): QueryLogEntry => ({
  id: "r1",
  ts: 1_700_000_000_000,
  user: "ana@example.com",
  kernel: "notebook:etl.ipynb",
  cluster: null,
  kind: "sql",
  query: "select 1",
  source: "etl.ipynb",
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

const read = (table: string | null, version: number | null = 1) => ({ table, location: "/l", version });
const write = (table: string | null, version: number | null = 2) => ({ table, location: "/l", version, operation: "WRITE" });

let dir: string;
let lineage: Lineage;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lineage-"));
  process.env.IARA_STUDIO_DATA = dir;
  vi.resetModules();
  delete (globalThis as { __iaraLineage?: unknown }).__iaraLineage; // a fresh index, as after a restart
  lineage = await import("./lineage");
});

afterEach(() => {
  vi.useRealTimers();
  delete process.env.IARA_STUDIO_DATA;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("lineage", () => {
  it("puts a read on the reader side and a write on the writer side of the right tables", () => {
    lineage.noteRun(run({ reads: [read("main.raw.orders")], writes: [write("main.gold.sales", 7)] }));
    expect(lineage.lineageOf("main.raw.orders").readers).toMatchObject([{ source: { kind: "notebook", id: "etl.ipynb" }, version: 1 }]);
    expect(lineage.lineageOf("main.raw.orders").writers).toEqual([]);
    expect(lineage.lineageOf("main.gold.sales").writers).toMatchObject([{ user: "ana@example.com", ts: 1_700_000_000_000, version: 7 }]);
    expect(lineage.lineageOf("main.gold.sales").readers).toEqual([]);
  });

  it("replaces an earlier run of the same source", () => {
    lineage.noteRun(run({ id: "a", ts: 1_000, writes: [write("t")] }));
    lineage.noteRun(run({ id: "b", ts: 2_000, writes: [write("t", 9)] }));
    const { writers } = lineage.lineageOf("t");
    expect(writers).toHaveLength(1);
    expect(writers[0]).toMatchObject({ ts: 2_000, version: 9 });
  });

  it("shows two sources side by side, newest first", () => {
    lineage.noteRun(run({ ts: 1_000, kernel: "assistant", source: "assistant", reads: [read("t")] }));
    lineage.noteRun(run({ ts: 2_000, reads: [read("t")] }));
    expect(lineage.lineageOf("t").readers.map((u) => u.source.kind)).toEqual(["notebook", "assistant"]);
  });

  it("lists the tables a writing run read, without the written table or nameless reads", () => {
    lineage.noteRun(run({ reads: [read("a"), read("b"), read("a"), read(null), read("t")], writes: [write("t"), write(null)] }));
    expect(lineage.lineageOf("t").writers[0].inputs).toEqual(["a", "b"]);
  });

  it("ignores a run with no source", () => {
    lineage.noteRun(run({ kernel: "metadata", source: "catalog", reads: [read("t")] }));
    expect(lineage.lineageOf("t")).toEqual({ writers: [], readers: [] });
  });

  it("returns empty lists for an unknown table", () => {
    expect(lineage.lineageOf("nope")).toEqual({ writers: [], readers: [] });
  });

  it("saves the index to lineage.json and loads the same index again", async () => {
    vi.useFakeTimers();
    lineage.noteRun(run({ reads: [read("a")], writes: [write("t")] }));
    vi.advanceTimersByTime(5_000);
    expect(fs.existsSync(path.join(dir, "system", "lineage.json"))).toBe(true);
    const before = lineage.lineageOf("t");
    vi.resetModules();
    delete (globalThis as { __iaraLineage?: unknown }).__iaraLineage; // a fresh index, as after a restart
    const fresh = await import("./lineage");
    expect(fresh.lineageOf("t")).toEqual(before);
    expect(fresh.lineageOf("a").readers).toHaveLength(1);
  });

  it("loads a broken file as an empty index", async () => {
    fs.mkdirSync(path.join(dir, "system"), { recursive: true });
    fs.writeFileSync(path.join(dir, "system", "lineage.json"), "{ not json");
    vi.resetModules();
    delete (globalThis as { __iaraLineage?: unknown }).__iaraLineage; // a fresh index, as after a restart
    const fresh = await import("./lineage");
    expect(fresh.lineageOf("t")).toEqual({ writers: [], readers: [] });
  });
});
