import { describe, expect, it } from "vitest";

import type { Measure } from "@/lib/model/types";

import { fieldChoices } from "./fieldChoices";
import { buildFieldTree } from "./fieldTree";

const span = { from: 0, to: 0, line: 1, col: 1 };
const measure = (name: string, datasets: string[]): Measure => ({ name, datasets, atoms: [], expr: [], span });
const datasets = ["orders", "customer", "pending"].map((name) => ({ name, sql: "", params: {} }));
const found = {
  orders: [
    { name: "o_total", type: "double" },
    { name: "o_status", type: "string" },
  ],
  customer: [{ name: "c_segment", type: "string" }],
};
const model = { measures: [measure("revenue", ["orders"]), measure("loose", ["gone"])], calendars: [], params: [] };
const of = (query: string, values: boolean) => fieldChoices(buildFieldTree({ datasets, model, found, query }), query, { values, rows: "Rows" });
const labels = (query: string, values: boolean) => of(query, values).map((g) => [g.name, g.choices.map((c) => c.label)]);

describe("fieldChoices", () => {
  it("lists only columns for an axis, by dataset", () => {
    expect(labels("", false)).toEqual([
      ["orders", ["o_total", "o_status"]],
      ["customer", ["c_segment"]],
      ["pending", []],
    ]);
  });

  it("adds the measures and each dataset's rows for a value, measures first", () => {
    expect(labels("", true)[0]).toEqual(["orders", ["revenue", "Rows", "o_total", "o_status"]]);
    expect(labels("", true).at(-1)).toEqual(["", ["loose"]]);
  });

  it("says a dataset's columns are still being read", () => {
    expect(of("", false).find((g) => g.name === "pending")?.loading).toBe(true);
  });

  it("finds a column in any dataset, leaving out the rest", () => {
    expect(labels("segment", false)).toEqual([["customer", ["c_segment"]]]);
  });

  it("keeps a whole dataset whose name is searched, in any case", () => {
    expect(labels("ORDERS", false)).toEqual([["orders", ["o_total", "o_status"]]]);
  });

  it("finds a measure, and no rows unless asked for", () => {
    expect(labels("reven", true)).toEqual([["orders", ["revenue"]]]);
    expect(labels("rows", true).map((g) => g[1])).toEqual([]);
  });

  it("gives a column its type, so that a number comes in summed", () => {
    expect(of("o_total", false)[0].choices[0].picked).toEqual({ kind: "column", dataset: "orders", name: "o_total", type: "double" });
  });
});
