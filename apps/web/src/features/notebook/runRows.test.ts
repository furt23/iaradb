import type { Cell, CellState, PipelineStats, QueryProfile } from "@iara/protocol";
import { describe, expect, it } from "vitest";

import { runRows } from "./runRows";

const cell = (id: string, code: string): Cell => ({ id, kind: "python", code, name: "_", output: null, config: {}, setup: false });
const state = (status: CellState["status"], elapsed_ms: number | null = null): CellState => ({ status, stale: false, output: null, streams: [], elapsed_ms });

function pipeline(done: number, total: number): PipelineStats {
  return { source: "ParquetScan", operators: [], sink: "JoinBuildSink", morsels_total: total, morsels_done: done, rows_in: 0, rows_out: 0, elapsed_ms: 1, finished: done === total };
}

const cells = [cell("a", "import iara"), cell("b", "\n  df = big.collect()\n"), cell("c", "x".repeat(80)), cell("d", "print(1)")];

describe("runRows", () => {
  it("lists the queued cells in run order with their number in the notebook", () => {
    const rows = runRows(["b", "d"], cells, { b: state("done", 1200), d: state("queued") }, {});
    expect(rows.map((r) => [r.number, r.preview, r.status, r.elapsed])).toEqual([
      [2, "df = big.collect()", "done", 1200],
      [4, "print(1)", "queued", null],
    ]);
  });

  it("says where the running cell's query is", () => {
    const q: QueryProfile = {
      id: 1,
      elapsed_ms: 10,
      cancelled: false,
      pipelines: [pipeline(4, 4), pipeline(1, 4)],
      pending: [{ source: "Materialized", sink: "SortSink", morsels: 2 }],
    };
    const [row] = runRows(["a"], cells, { a: state("running") }, { a: [q] });
    expect(row.query).toEqual({ share: 5 / 10, pipeline: 2, pipelines: 3 });
  });

  it("has no query position for a cell that runs no query, or is done", () => {
    const q: QueryProfile = { id: 1, elapsed_ms: 1, cancelled: false, pipelines: [] };
    expect(runRows(["a"], cells, { a: state("running") }, { a: [q] })[0].query).toBeUndefined();
    expect(runRows(["a"], cells, { a: state("done", 5) }, {})[0].query).toBeUndefined();
  });

  it("cuts a long first line and skips cells that are gone", () => {
    const rows = runRows(["c", "gone"], cells, {}, {});
    expect(rows).toHaveLength(1);
    expect(rows[0].preview).toHaveLength(48);
    expect(rows[0].preview.endsWith("…")).toBe(true);
    expect(rows[0].status).toBe("queued");
  });
});
