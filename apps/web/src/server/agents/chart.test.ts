import { describe, expect, it } from "vitest";

import type { ToolContext } from "../ai/tools";
import { drawChart } from "./chart";

/** A kernel whose every query gives these columns and rows. */
function kernel(columns: { name: string; type: string }[], rows: unknown[][]): ToolContext {
  const request = async (method: string) =>
    method === "sql.run" ? { type: "table", result: { id: "r1", columns, num_rows: rows.length } } : { offset: 0, total: rows.length, rows };
  return { request: request as unknown as ToolContext["request"], allow: ["main.s.orders"] };
}

const args = { title: "Revenue", kind: "line", sql: "SELECT d, seg, r FROM main.s.orders", x: "d", y: ["r"], group: "seg" };

describe("drawChart", () => {
  it("makes a chart of the query's rows, with the x column's type", async () => {
    const ctx = kernel([{ name: "d", type: "date32" }, { name: "seg", type: "utf8" }, { name: "r", type: "float64" }], [["2024-01-01", "A", 1]]);
    const out = await drawChart(ctx, args);
    expect(out).toMatchObject({ chart: { title: "Revenue", xType: "date32", spec: { kind: "line", x: "d", y: ["r"], group: "seg" }, sql: args.sql } });
  });

  it("refuses columns the query does not give, values that are not numbers, and no rows", async () => {
    const cols = [{ name: "d", type: "date32" }, { name: "r", type: "utf8" }];
    expect(await drawChart(kernel(cols, [["x", "1"]]), { ...args, group: "" })).toEqual({ error: "r must be numeric" });
    expect(await drawChart(kernel(cols, [["x", "1"]]), args)).toEqual({ error: "the query has no column seg; it gives d, r" });
    expect(await drawChart(kernel([{ name: "d", type: "date32" }, { name: "r", type: "int64" }], []), { ...args, group: "" })).toEqual({ error: "the query gave no rows: nothing to draw" });
  });

  it("draws a pie without series", async () => {
    const ctx = kernel([{ name: "d", type: "utf8" }, { name: "seg", type: "utf8" }, { name: "r", type: "int64" }], [["a", "b", 1]]);
    expect(await drawChart(ctx, { ...args, kind: "pie" })).toMatchObject({ chart: { spec: { kind: "pie", group: null } } });
  });

  it("gives bad arguments back as an error", async () => {
    expect(await drawChart(kernel([], []), { title: "x" })).toHaveProperty("error");
  });
});
