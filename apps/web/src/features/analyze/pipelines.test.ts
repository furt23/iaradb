import type { AnalyzedNode, PipelineStats } from "@iara/protocol";
import { describe, expect, it } from "vitest";

import { pipelineAfter, pipelinesInto, sinkName, sourceLabel } from "./pipelines";

function pipeline(sink: string, nodes?: number[], source = "ParquetScan[x, files=1]"): PipelineStats {
  return { source, operators: [], sink, nodes, morsels_total: 1, morsels_done: 1, rows_in: 0, rows_out: 0, elapsed_ms: 1, finished: true };
}

const leaf = (name: string, detail = name): AnalyzedNode => ({ name, detail, role: null, metrics: null, children: [] });

// 0 Sort <- 1 HashAggregate <- 2 HashJoin <- [3 ParquetScan(lineitem), 4 ParquetScan(orders)]
const nodes: AnalyzedNode[] = [
  leaf("Sort"),
  leaf("HashAggregate"),
  leaf("HashJoin"),
  leaf("ParquetScan", "ParquetScan[lineitem, files=1, row_groups=4/4, morsels=4, columns=3]"),
  leaf("ParquetScan", "ParquetScan[orders, files=1, row_groups=2/2, morsels=2, columns=2]"),
];
const pipelines = [
  pipeline("JoinBuildSink", [4, 2]), // build the join from orders
  pipeline("AggregateSink", [3, 2, 1]), // probe it with lineitem, aggregate
  pipeline("SortSink", [1, 0], "Materialized[1 morsels]"), // sort the groups
];

describe("pipelines", () => {
  it("names a sink without its suffix", () => {
    expect(sinkName("JoinBuildSink")).toBe("JoinBuild");
    expect(sinkName("StreamSink")).toBe("Stream");
  });

  it("labels a scan by its table and another source by its operator", () => {
    expect(sourceLabel(pipelines[0], nodes)).toBe("orders");
    expect(sourceLabel(pipelines[1], nodes)).toBe("lineitem");
    expect(sourceLabel(pipelines[2], nodes)).toBe("HashAggregate");
  });

  it("falls back to the source's description without nodes (an unmeasured run)", () => {
    expect(sourceLabel(pipeline("CollectSink", undefined, "ParquetScan[files=1, morsels=3]"), nodes)).toBe("ParquetScan");
    expect(sourceLabel(pipeline("CollectSink", [3]), [leaf("ParquetScan", "ParquetScan[files=1, morsels=3]")])).toBe("ParquetScan");
  });

  it("finds the pipelines that feed a node", () => {
    expect(pipelinesInto(pipelines, 1, 2)).toEqual([0]); // the join's build side
    expect(pipelinesInto(pipelines, 2, 1)).toEqual([1]); // the groups the sort reads
    expect(pipelinesInto(pipelines, 1, 3)).toEqual([]);
  });

  it("finds the pipeline that goes on from one", () => {
    expect(pipelineAfter(pipelines, 0)).toBe(1);
    expect(pipelineAfter(pipelines, 1)).toBe(2);
    expect(pipelineAfter(pipelines, 2)).toBeNull();
    expect(pipelineAfter([pipeline("CollectSink")], 0)).toBeNull();
  });
});
