import type { PipelineStats, QueryProfile } from "@iara/protocol";
import { describe, expect, it } from "vitest";

import { pipelineLines, queryProgress } from "./progress";

function pipeline(done: number, total: number, finished = done === total): PipelineStats {
  return { source: "ParquetScan", operators: [], sink: "AggregateSink", morsels_total: total, morsels_done: done, rows_in: 0, rows_out: 0, elapsed_ms: 1, finished };
}

function query(pipelines: PipelineStats[], pending?: QueryProfile["pending"]): QueryProfile {
  return { id: 1, elapsed_ms: 10, cancelled: false, pipelines, pending };
}

describe("queryProgress", () => {
  it("counts the morsels of every pipeline, planned ones included", () => {
    const q = query([pipeline(10, 10), pipeline(5, 20)], [{ source: "ParquetScan", sink: "SortSink", morsels: 10 }]);
    expect(queryProgress(q)).toBe(15 / 40);
  });

  it("does not start over when the next pipeline starts", () => {
    const pending = [{ source: "ParquetScan", sink: "AggregateSink", morsels: 30 }];
    const before = queryProgress(query([pipeline(10, 10)], pending));
    const after = queryProgress(query([pipeline(10, 10), pipeline(0, 30)]));
    expect(after).toBe(before);
  });

  it("counts a planned pipeline of unknown size as one morsel", () => {
    expect(queryProgress(query([pipeline(3, 3)], [{ source: "Materialized", sink: "SortSink", morsels: null }]))).toBe(3 / 4);
  });

  it("counts a pipeline cut short as done", () => {
    expect(queryProgress(query([pipeline(2, 8, true)]))).toBe(1);
  });

  it("is 0 before anything runs", () => {
    expect(queryProgress(query([]))).toBe(0);
  });
});

describe("pipelineLines", () => {
  it("lists the started pipelines, then the planned ones", () => {
    const q = query([pipeline(4, 4), pipeline(2, 8)], [{ source: "Materialized", sink: "SortSink", morsels: null }]);
    expect(pipelineLines(q)).toEqual([
      { state: "done", done: 4, total: 4, ms: 1 },
      { state: "running", done: 2, total: 8, ms: 1 },
      { state: "pending", done: 0, total: null, ms: null },
    ]);
  });

  it("shows a pipeline cut short as complete", () => {
    expect(pipelineLines(query([pipeline(2, 8, true)]))[0]).toMatchObject({ state: "done", done: 8, total: 8 });
  });

  it("works with kernels that send no planned pipelines", () => {
    expect(pipelineLines(query([pipeline(1, 3)]))).toHaveLength(1);
  });
});
