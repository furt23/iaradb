import type { ChartSpec } from "@iara/protocol";
import { describe, expect, it } from "vitest";

import type { ChartStyle } from "@/lib/dashboards/types";

import type { Categorical } from "../chartSpec";
import { chartOption, type OptionInput } from "./options";

const colors = { series: ["#2a78d6", "#eb6834"], text: "#111", muted: "#666", grid: "#ddd", surface: "#fff" };

const sales: Categorical = {
  categories: ["north", "south", "east"],
  raw: ["north", "south", "east"],
  series: [
    { label: "revenue", data: [10, 20, 30] },
    { label: "cost", data: [4, 5, 6] },
  ],
};
const single: Categorical = { ...sales, series: [sales.series[0]] };

function build(spec: Partial<ChartSpec>, categorical: Categorical | null, rest: Partial<OptionInput> = {}) {
  const full: ChartSpec = { kind: "bar", x: "region", y: ["revenue"], agg: "sum", group: null, ...spec };
  const option = chartOption({ spec: full, categorical, points: null, xType: "string_view", colors, picked: -1, locale: "en-US", ...rest });
  return {
    option,
    series: option.series as { type: string; name: string; yAxisIndex?: number; stack?: string; label?: { show: boolean }; data: unknown[] }[],
    yAxis: option.yAxis as { position?: string; name?: string; axisLabel: { formatter(v: number): string } }[],
    xAxis: option.xAxis as { type: string }[],
  };
}

const style = (s: ChartStyle) => ({ style: s });

describe("chartOption", () => {
  it("draws a single-series bar chart with one value axis", () => {
    const { series, yAxis, option } = build({}, single);
    expect(series.map((s) => s.type)).toEqual(["bar"]);
    expect(yAxis).toHaveLength(1);
    expect(option.legend).toBeUndefined();
  });

  it("puts a series on the right axis, named after it", () => {
    const { series, yAxis } = build({ y: ["revenue", "cost"] }, sales, style({ series: { cost: { axis: "right" } } }));
    expect(yAxis).toHaveLength(2);
    expect(yAxis[1]).toMatchObject({ position: "right", name: "cost" });
    expect(series.map((s) => s.yAxisIndex)).toEqual([0, 1]);
  });

  it("draws a series as a line on a bar chart", () => {
    const { series } = build({ y: ["revenue", "cost"] }, sales, style({ series: { cost: { as: "line" } } }));
    expect(series.map((s) => s.type)).toEqual(["bar", "line"]);
  });

  it("ignores series styles when the chart has a group", () => {
    const { series, yAxis } = build({ group: "year" }, sales, style({ series: { revenue: { axis: "right", as: "line" }, cost: { axis: "right" } } }));
    expect(series.map((s) => s.type)).toEqual(["bar", "bar"]);
    expect(yAxis).toHaveLength(1);
  });

  it("shows the values on request", () => {
    expect(build({}, single).series[0].label).toBeUndefined();
    expect(build({}, single, style({ labels: true })).series[0].label?.show).toBe(true);
  });

  it("writes the axis numbers as the format says, and short without one", () => {
    const currency = build({}, single, style({ format: { style: "currency", currency: "USD", decimals: 0 } }));
    expect(currency.yAxis[0].axisLabel.formatter(1200)).toBe("$1,200");
    expect(build({}, single).yAxis[0].axisLabel.formatter(35_000)).toBe("35K");
  });

  it("fades the slices that are not picked", () => {
    const { series } = build({ kind: "pie" }, single, { picked: 1 });
    expect(series[0].data).toEqual([
      { name: "north", value: 10, itemStyle: { opacity: 0.35 } },
      { name: "south", value: 20 },
      { name: "east", value: 30, itemStyle: { opacity: 0.35 } },
    ]);
  });

  it("marks the picked category of a line with a dashed line", () => {
    const { series } = build({ kind: "line" }, single, { picked: 2 });
    expect(series[0]).toMatchObject({ type: "line", markLine: { silent: true, data: [{ xAxis: 2 }] } });
  });

  it("draws time on a time axis, a bare date at local midnight", () => {
    const days: Categorical = { categories: ["2024-03-01", "2024-03-02"], raw: ["2024-03-01", "2024-03-02"], series: [{ label: "revenue", data: [1, 2] }] };
    const { xAxis, series } = build({ kind: "line", x: "day" }, days, { xType: "date32[day]" });
    expect(xAxis[0].type).toBe("time");
    expect(series[0].data).toEqual([
      [new Date(2024, 2, 1).getTime(), 1],
      [new Date(2024, 2, 2).getTime(), 2],
    ]);
  });

  it("stacks a histogram", () => {
    const bins: Categorical = { categories: ["0–10", "10–20"], raw: ["0–10", "10–20"], series: [{ label: "count", data: [3, 5] }] };
    expect(build({ kind: "histogram" }, bins).series[0].stack).toBe("bins");
  });
});
