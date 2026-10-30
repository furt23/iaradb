import { describe, expect, it } from "vitest";

import type { ChartWidget, TableWidget, Widget } from "@/lib/dashboards/types";

import { removeFromWidgets, renameInWidgets, widgetsUsing, withMeasure, withoutMeasure } from "./measureWidgets";

const chart = (id: string, measures?: string[], extra: Partial<ChartWidget> = {}): ChartWidget => ({
  id,
  kind: "chart",
  dataset: "orders",
  spec: { kind: "bar", x: "region", y: [], agg: "sum" },
  measures,
  ...extra,
});
const counter = (id: string, measures?: string[]): ChartWidget => ({ ...chart(id, measures), spec: { kind: "counter", x: "", y: [], agg: "count" } });
const table: TableWidget = { id: "t", kind: "table", dataset: "orders" };

describe("withMeasure / withoutMeasure", () => {
  it("adds a measure to a chart once, and replaces a counter's", () => {
    expect(withMeasure(chart("a", ["x"]), "y").measures).toEqual(["x", "y"]);
    expect(withMeasure(chart("a", undefined), "y").measures).toEqual(["y"]);
    const same = chart("a", ["x"]);
    expect(withMeasure(same, "x")).toBe(same);
    expect(withMeasure(counter("c", ["x"]), "y").measures).toEqual(["y"]);
  });

  it("removes a measure, and the key with the last one", () => {
    expect(withoutMeasure(chart("a", ["x", "y"]), "x").measures).toEqual(["y"]);
    expect("measures" in withoutMeasure(chart("a", ["x"]), "x")).toBe(false);
  });

  it("drops the series style of the removed measure", () => {
    const styled = chart("a", ["x", "y"], { style: { labels: true, series: { x: { axis: "right" }, y: { as: "line" } } } });
    expect(withoutMeasure(styled, "x").style).toEqual({ labels: true, series: { y: { as: "line" } } });
    const only = chart("a", ["x"], { style: { series: { x: { axis: "right" } } } });
    expect("style" in withoutMeasure(only, "x")).toBe(false);
  });
});

describe("widgetsUsing", () => {
  it("finds the charts that draw the measure, not tables or other charts", () => {
    const widgets: Widget[] = [chart("a", ["x"]), chart("b", ["y"]), chart("c"), table, counter("d", ["x"])];
    expect(widgetsUsing(widgets, "x").map((w) => w.id)).toEqual(["a", "d"]);
    expect(widgetsUsing(widgets, "nope")).toEqual([]);
  });
});

describe("renameInWidgets", () => {
  it("returns only the charts that drew the old name, drawing the new one in the same place", () => {
    const widgets: Widget[] = [chart("a", ["x", "y"]), chart("b", ["y"]), table];
    const changed = renameInWidgets(widgets, "x", "total");
    expect(changed.map((w) => [w.id, w.measures])).toEqual([["a", ["total", "y"]]]);
  });

  it("moves the series style to the new name", () => {
    const widgets: Widget[] = [chart("a", ["x"], { style: { series: { x: { axis: "right" } } } })];
    expect(renameInWidgets(widgets, "x", "total")[0].style).toEqual({ series: { total: { axis: "right" } } });
  });

  it("does not repeat a measure the chart already drew", () => {
    expect(renameInWidgets([chart("a", ["x", "total"])], "x", "total")[0].measures).toEqual(["total"]);
  });
});

describe("removeFromWidgets", () => {
  it("returns the charts that drew it, without it", () => {
    const widgets: Widget[] = [chart("a", ["x", "y"]), chart("b", ["x"]), chart("c", ["y"])];
    const changed = removeFromWidgets(widgets, "x");
    expect(changed.map((w) => [w.id, w.measures])).toEqual([
      ["a", ["y"]],
      ["b", undefined],
    ]);
  });
});
