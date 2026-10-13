import { describe, expect, it } from "vitest";

import { prettyValues, restoreStatement, summariseMetrics, versionQuery } from "./deltaHistory";

describe("deltaHistory", () => {
  it("summarises row and file metrics, skipping zeros", () => {
    expect(summariseMetrics({ numOutputRows: "1200", numAddedFiles: "2", numRemovedFiles: "0" })).toEqual(["+1,200 rows", "2 files added"]);
    expect(summariseMetrics({ numDeletedRows: "5", numRemovedFiles: "1" })).toEqual(["-5 rows", "1 files removed"]);
    expect(summariseMetrics({})).toEqual([]);
    expect(summariseMetrics({ numOutputRows: "x" })).toEqual([]);
  });
  it("builds the statements", () => {
    expect(versionQuery("orders", 3)).toBe("SELECT * FROM orders VERSION AS OF 3 LIMIT 100");
    expect(restoreStatement("s.t", 0)).toBe("RESTORE TABLE s.t TO VERSION AS OF 0");
  });
  it("parses JSON values for display and keeps plain text", () => {
    expect(JSON.parse(prettyValues({ mode: "Append", partitionBy: '["a"]' }))).toEqual({ mode: "Append", partitionBy: ["a"] });
  });
});
