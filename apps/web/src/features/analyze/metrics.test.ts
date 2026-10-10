import type { AnalyzedNode } from "@workhouse/protocol";
import { describe, expect, it } from "vitest";

import { heat, hottestMs, metricRows, planNodes, timeShare } from "./metrics";

function op(name: string, elapsed_ms: number | null, ...children: AnalyzedNode[]): AnalyzedNode {
  return {
    name,
    detail: name,
    role: null,
    metrics: elapsed_ms === null ? null : { rows_out: 1, elapsed_ms },
    children,
  };
}

const plan = op("Sort", 10, op("HashJoin", 60, op("ParquetScan", 25), op("Filter", 5)));

describe("plan metrics", () => {
  it("lists the nodes parents first", () => {
    expect(planNodes(plan).map((n) => n.name)).toEqual(["Sort", "HashJoin", "ParquetScan", "Filter"]);
  });

  it("finds the hottest operator", () => {
    expect(hottestMs(plan)).toBe(60);
    expect(hottestMs(op("Scan", null))).toBe(0);
  });

  it("gives an operator's share of the run, clamped to 1", () => {
    const join = plan.children[0];
    expect(timeShare(join, 120)).toBe(0.5);
    expect(timeShare(join, 30)).toBe(1);
    expect(timeShare(join, 0)).toBe(0);
    expect(timeShare(op("Scan", null), 120)).toBe(0);
  });

  it("gives the hottest operator the full tint and the others less", () => {
    const join = plan.children[0];
    const filter = join.children[1];
    expect(heat(join, hottestMs(plan))).toBe(1);
    expect(heat(filter, hottestMs(plan))).toBeCloseTo(5 / 60);
    expect(heat(op("Scan", null), 60)).toBe(0);
  });

  it("lists the metrics that were reported", () => {
    expect(metricRows({ rows_out: 1234, elapsed_ms: 2000 }, 0.256)).toEqual([
      ["Rows out", "1,234"],
      ["Time", "2.00 s"],
      ["Share of the run", "26%"],
    ]);
    const rows = metricRows({ rows_out: 1, elapsed_ms: 1, batches: 4, memory_peak: 2048, spilled_bytes: 0 }, 0);
    expect(rows.slice(3)).toEqual([
      ["Batches", "4"],
      ["Memory peak", "2.0 KB"],
      ["Spilled", "0 B"],
    ]);
  });
});
