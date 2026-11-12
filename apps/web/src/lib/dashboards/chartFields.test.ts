import { describe, expect, it } from "vitest";

import { asValues, chartMissing, drawnNames, firstCategories, isModelChart, valueName } from "./chartFields";
import type { ChartWidget } from "./types";
import { checkWidget } from "./widgets";

const chart = (spec: Partial<ChartWidget["spec"]> = {}, extra: Partial<ChartWidget> = {}): ChartWidget => ({
  id: "c",
  kind: "chart",
  dataset: "orders",
  spec: { kind: "bar", x: "status", y: [], agg: "sum", ...spec },
  ...extra,
});

describe("asValues", () => {
  it("turns what the kernel would aggregate into value fields", () => {
    const c = asValues(chart({ y: ["total", "tax"], agg: "avg" }));
    expect(c.values).toEqual([
      { name: "Average of total", dataset: "orders", column: "total", agg: "avg" },
      { name: "Average of tax", dataset: "orders", column: "tax", agg: "avg" },
    ]);
    expect(c.spec.y).toEqual([]);
  });

  it("counts rows for a count, and sums raw rows", () => {
    expect(asValues(chart({ agg: "count" })).values).toEqual([{ name: "Rows", dataset: "orders", agg: "count" }]);
    expect(asValues(chart({ y: ["total"], agg: "none" })).values?.[0].agg).toBe("sum");
  });

  it("leaves a chart with fields, and the kinds drawn from rows, alone", () => {
    const withMeasures = chart({ y: ["total"] }, { measures: ["m"] });
    expect(asValues(withMeasures)).toBe(withMeasures);
    const scatter = chart({ kind: "scatter", y: ["total"], agg: "none" });
    expect(asValues(scatter)).toBe(scatter);
  });

  it("gives a chart with nothing to aggregate no values", () => {
    expect(asValues(chart()).values).toBeUndefined();
  });
});

describe("the chart's state", () => {
  it("draws through the model only with fields of its own", () => {
    expect(isModelChart(chart({ y: ["total"] }))).toBe(false);
    expect(isModelChart(chart({}, { measures: ["m"] }))).toBe(true);
    expect(isModelChart(chart({}, { values: [{ name: "n", dataset: "orders", agg: "count" }] }))).toBe(true);
  });

  it("names measures first, then values", () => {
    expect(drawnNames(chart({}, { measures: ["m"], values: [{ name: "n", dataset: "orders", agg: "count" }] }))).toEqual(["m", "n"]);
  });

  it("says what is missing", () => {
    expect(chartMissing(chart())).toBe("Add a value from the Fields pane");
    expect(chartMissing(chart({ x: "", y: ["total"] }))).toBe("Add a column to the X axis");
    expect(chartMissing(chart({ kind: "counter", x: "", agg: "count" }))).toBeNull();
    expect(chartMissing(chart({ kind: "histogram", x: "total", agg: "count" }))).toBeNull();
  });
});

describe("firstCategories", () => {
  it("keeps every row of the first categories", () => {
    const rows = [["a", 1], ["a", 2], ["b", 3], ["c", 4], ["b", 5]];
    expect(firstCategories(rows, 0, 2)).toEqual([["a", 1], ["a", 2], ["b", 3], ["b", 5]]);
  });
});

describe("valueName", () => {
  it("keeps a colon out of the name", () => {
    expect(valueName("sum", "a:b")).toBe("Sum of a b");
  });
});

describe("checkWidget on a chart's fields", () => {
  const base = { kind: "chart", dataset: "orders", spec: { kind: "bar", x: "s", y: [], agg: "sum" } };

  it("keeps values, sort and top", () => {
    const values = [{ name: "Sum of t", dataset: "customer", column: "t", agg: "sum" }];
    expect(checkWidget("abcd1234", { ...base, values, sort: "value_asc", top: 5 })).toMatchObject({ values, sort: "value_asc", top: 5 });
  });

  it.each([
    [{ values: [] }],
    [{ values: [{ name: "a:b", dataset: "d", column: "c", agg: "sum" }] }],
    [{ values: [{ name: "n", dataset: "d", agg: "sum" }] }],
    [{ values: [{ name: "n", dataset: "d", column: "c", agg: "median" }] }],
    [{ values: [{ name: "m", dataset: "d", column: "c", agg: "sum" }], measures: ["m"] }],
    [{ sort: "random" }],
    [{ top: 0 }],
  ])("refuses %j", (bad) => {
    expect(() => checkWidget("abcd1234", { ...base, ...bad })).toThrow();
  });
});
