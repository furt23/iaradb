import { describe, expect, it } from "vitest";

import { defaultSpec, fitSpec, pickOf, specProblem, toCategorical, toPoints } from "./chartSpec";

const columns = [
  { name: "region", type: "string_view" },
  { name: "day", type: "date32[day]" },
  { name: "amount", type: "double" },
  { name: "qty", type: "int64" },
];

describe("defaultSpec", () => {
  it("sums the first number by the first category", () => {
    expect(defaultSpec(columns)).toEqual({ kind: "bar", x: "region", y: ["amount"], agg: "sum", group: null });
  });

  it("draws time as a line and counts when there is nothing to sum", () => {
    expect(defaultSpec([{ name: "day", type: "date32[day]" }])).toEqual({ kind: "line", x: "day", y: [], agg: "count", group: null });
    expect(defaultSpec([])).toBeNull();
  });
});

describe("fitSpec and specProblem", () => {
  it("drops columns the result lost", () => {
    const spec = { kind: "bar" as const, x: "gone", y: ["amount", "old"], agg: "sum" as const, group: "nope" };
    expect(fitSpec(spec, columns)).toEqual({ ...spec, x: "region", y: ["amount"], group: null });
  });

  it("explains what is missing", () => {
    expect(specProblem({ kind: "bar", x: "region", y: [], agg: "sum" }, columns)).toMatch(/value column/);
    expect(specProblem({ kind: "bar", x: "region", y: ["region"], agg: "avg" }, columns)).toMatch(/numeric/);
    expect(specProblem({ kind: "histogram", x: "region", y: [], agg: "count" }, columns)).toMatch(/numeric/);
    expect(specProblem({ kind: "bar", x: "region", y: [], agg: "count" }, columns)).toBeNull();
  });

  it("keeps a counter without an x and explains what it needs", () => {
    const spec = { kind: "counter" as const, x: "", y: ["amount"], agg: "sum" as const, group: null };
    expect(fitSpec(spec, columns)).toEqual(spec);
    expect(specProblem({ kind: "counter", x: "", y: [], agg: "count" }, columns)).toBeNull();
    expect(specProblem({ kind: "counter", x: "", y: ["amount"], agg: "sum" }, columns)).toBeNull();
    expect(specProblem({ kind: "counter", x: "", y: [], agg: "sum" }, columns)).toMatch(/value column/);
    expect(specProblem({ kind: "counter", x: "", y: ["region"], agg: "max" }, columns)).toMatch(/numeric/);
    expect(specProblem({ kind: "counter", x: "", y: ["amount"], agg: "none" }, columns)).toMatch(/aggregation/);
  });
});

describe("toCategorical", () => {
  it("makes one series per value column", () => {
    const data = { columns: ["region", "amount", "qty"], rows: [["north", 10, 1], ["south", 5, "2"]], truncated: false };
    expect(toCategorical(data, { kind: "bar", x: "region", y: ["amount", "qty"], agg: "sum" })).toEqual({
      categories: ["north", "south"],
      raw: ["north", "south"],
      series: [
        { label: "amount", data: [10, 5] },
        { label: "qty", data: [1, 2] },
      ],
    });
  });

  it("splits groups into series, with gaps where a group has no value", () => {
    const data = { columns: ["year", "region", "count"], rows: [[2020, "n", 3], [2020, "s", 4], [2021, "s", 5]], truncated: false };
    expect(toCategorical(data, { kind: "line", x: "year", y: [], agg: "count", group: "region" })).toEqual({
      categories: [2020, 2021],
      raw: [2020, 2021],
      series: [
        { label: "n", data: [3, null] },
        { label: "s", data: [4, 5] },
      ],
    });
  });

  it("draws a pie from the categories of a bar", () => {
    const data = { columns: ["region", "amount"], rows: [["north", 10], ["south", 5]], truncated: false };
    expect(toCategorical(data, { kind: "pie", x: "region", y: ["amount"], agg: "sum" })).toEqual({
      categories: ["north", "south"],
      raw: ["north", "south"],
      series: [{ label: "amount", data: [10, 5] }],
    });
  });

  it("keeps each category's x value as the kernel sent it, a null too, for a click to pick", () => {
    const data = { columns: ["flag", "n"], rows: [[true, 1], [null, 2], [false, 3], [true, 4]], truncated: false };
    const c = toCategorical(data, { kind: "bar", x: "flag", y: ["n"], agg: "sum" });
    expect(c.categories).toEqual(["true", "(null)", "false"]);
    expect(c.raw).toEqual([true, null, false]);
    expect([0, 1, 2].map((i) => pickOf(c, i))).toEqual([true, null, false]);
  });

  it("labels histogram bins by their range", () => {
    const data = { columns: ["bin_start", "bin_end", "count"], rows: [[0, 1.5, 2], [1.5, 3, 7]], truncated: false };
    expect(toCategorical(data, { kind: "histogram", x: "v", y: [], agg: "count", bins: 2 })).toEqual({
      categories: ["0–1.50", "1.50–3"],
      raw: ["0–1.50", "1.50–3"],
      series: [{ label: "count", data: [2, 7] }],
    });
  });
});

describe("pickOf", () => {
  const c = { categories: ["a", "b"], raw: ["a", { k: 1 }], series: [] };

  it("has nothing to pick for a missing category or a value that is not plain", () => {
    expect(pickOf(c, 0)).toBe("a");
    expect(pickOf(c, 1)).toBeUndefined();
    expect(pickOf(c, 2)).toBeUndefined();
    expect(pickOf(c, undefined)).toBeUndefined();
    expect(pickOf(c, null)).toBeUndefined();
  });
});

describe("toPoints", () => {
  it("skips points without both coordinates", () => {
    const data = { columns: ["qty", "amount"], rows: [[1, 2], [null, 3], [4, "5"]], truncated: false };
    expect(toPoints(data, { kind: "scatter", x: "qty", y: ["amount"], agg: "none" })).toEqual([
      {
        label: "amount",
        data: [
          { x: 1, y: 2, id: 0 },
          { x: 4, y: 5, id: 2 },
        ],
      },
    ]);
  });
});
