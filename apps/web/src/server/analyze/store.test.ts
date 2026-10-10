import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { QueryAnalysis } from "@workhouse/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getAnalysis, listAnalyses, saveAnalysis } from "./store";

function analysis(query: string, at: number, extra: Partial<QueryAnalysis> = {}): QueryAnalysis {
  return {
    query,
    at,
    rows: 7,
    plan: { name: "Aggregate", detail: "Aggregate", role: null, metrics: null, children: [] },
    text: "Aggregate",
    profile: { id: 1, elapsed_ms: 12.5, cancelled: false, pipelines: [] },
    ...extra,
  };
}

describe("analysis store", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "analyses-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("saves an analysis under an 8-character id and gets it back", () => {
    const saved = saveAnalysis({ ...analysis("select 1", 1000), source: "sql editor" }, dir);
    expect(saved.id).toMatch(/^[a-z0-9]{8}$/);
    expect(getAnalysis(saved.id, dir)).toEqual(saved);
    expect(getAnalysis(saved.id, dir)?.source).toBe("sql editor");
  });

  it("refuses ids that are not stored analyses (no path escapes)", () => {
    saveAnalysis(analysis("select 1", 1000), dir);
    expect(getAnalysis("../secret", dir)).toBeNull();
    expect(getAnalysis("abc", dir)).toBeNull();
    expect(getAnalysis("zzzzzzzz", dir)).toBeNull();
  });

  it("lists the newest first, with a one-line preview", () => {
    saveAnalysis(analysis("select *\n  from sales", 1000), dir);
    saveAnalysis(analysis("select 2", 2000, { rows: 3 }), dir);
    const list = listAnalyses(dir);
    expect(list.map((a) => a.preview)).toEqual(["select 2", "select * from sales"]);
    expect(list[0]).toMatchObject({ at: 2000, elapsed_ms: 12.5, rows: 3 });
  });

  it("lists nothing when the folder does not exist yet", () => {
    expect(listAnalyses(path.join(dir, "missing"))).toEqual([]);
  });

  it("keeps the newest analyses and removes the older ones", () => {
    for (let i = 0; i < 5; i++) saveAnalysis(analysis(`select ${i}`, i + 1), dir, 3);
    const list = listAnalyses(dir);
    expect(list.map((a) => a.at)).toEqual([5, 4, 3]);
    expect(fs.readdirSync(dir)).toHaveLength(3);
  });

  it("skips files it cannot read", () => {
    saveAnalysis(analysis("select 1", 1000), dir);
    fs.writeFileSync(path.join(dir, "deadbeef.json"), "{ not json");
    expect(listAnalyses(dir).map((a) => a.preview)).toEqual(["select 1"]);
  });
});
