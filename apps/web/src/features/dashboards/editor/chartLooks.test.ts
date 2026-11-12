import { describe, expect, it } from "vitest";

import type { ChartWidget } from "@/lib/dashboards/types";

import { CHART_LOOKS, lookIdOf, withLook, type LookId } from "./chartLooks";

const COLUMNS = [
  { name: "status", type: "string" },
  { name: "total", type: "double" },
  { name: "tax", type: "double" },
];
const def = (id: LookId) => CHART_LOOKS.find((l) => l.id === id)!;
const chart = (extra: Partial<ChartWidget> = {}): ChartWidget => ({
  id: "c",
  kind: "chart",
  dataset: "orders",
  spec: { kind: "bar", x: "status", y: [], agg: "sum", group: "region" },
  values: [{ name: "Sum of total", dataset: "orders", column: "total", agg: "sum" }],
  ...extra,
});

describe("withLook", () => {
  it("keeps the fields between the looks of a kind", () => {
    const c = withLook(chart(), def("stacked"), COLUMNS);
    expect(c.style?.look).toBe("stacked");
    expect(c.values).toHaveLength(1);
    expect(c.spec.group).toBe("region");
    expect(lookIdOf(c)).toBe("stacked");
  });

  it("drops the look going back to the plain form, with the rest of the style", () => {
    const c = withLook(chart({ style: { look: "hbar", labels: true } }), def("column"), COLUMNS);
    expect(c.style).toEqual({ labels: true });
    expect(lookIdOf(c)).toBe("column");
    expect(withLook(chart({ style: { look: "hbar" } }), def("column"), COLUMNS).style).toBeUndefined();
  });

  it("gives a pie no legend field", () => {
    expect(withLook(chart(), def("donut"), COLUMNS).spec).toMatchObject({ kind: "pie", group: null });
  });

  it("gives a card one value and no x, and a gauge two", () => {
    const values = [
      { name: "a", dataset: "orders", column: "total", agg: "sum" as const },
      { name: "b", dataset: "orders", column: "tax", agg: "sum" as const },
      { name: "c", dataset: "orders", column: "tax", agg: "max" as const },
    ];
    const card = withLook(chart({ values }), def("counter"), COLUMNS);
    expect(card.spec).toMatchObject({ kind: "counter", x: "", group: null });
    expect(card.values?.map((v) => v.name)).toEqual(["a"]);
    expect(withLook(chart({ values }), def("gauge"), COLUMNS).values?.map((v) => v.name)).toEqual(["a", "b"]);
  });

  it("gets x back from the columns when leaving a card", () => {
    const card = withLook(chart(), def("counter"), COLUMNS);
    expect(withLook(card, def("column"), COLUMNS).spec.x).toBe("status");
  });

  it("takes a scatter's columns from its own dataset's values, and only those", () => {
    const c = withLook(chart({ measures: ["m"], values: [{ name: "v", dataset: "customer", column: "x", agg: "sum" }] }), def("scatter"), COLUMNS);
    expect(c.measures).toBeUndefined();
    expect(c.values).toBeUndefined();
    expect(c.spec).toMatchObject({ kind: "scatter", agg: "none", x: "total", y: ["tax"] });
  });

  it("makes a histogram of the value column", () => {
    const c = withLook(chart(), def("histogram"), COLUMNS);
    expect(c.spec).toMatchObject({ kind: "histogram", x: "total", y: [], agg: "count" });
  });

  it("converts a chart that still aggregates in the kernel", () => {
    const c = withLook(chart({ values: undefined, spec: { kind: "bar", x: "status", y: ["total"], agg: "avg" } }), def("line"), COLUMNS);
    expect(c.values).toEqual([{ name: "Average of total", dataset: "orders", column: "total", agg: "avg" }]);
    expect(c.spec).toMatchObject({ kind: "line", y: [] });
  });
});
