import type { ChartSpec } from "@iara/protocol";
import { SVGRenderer } from "echarts/renderers";
import { describe, expect, it } from "vitest";

import type { ChartLook, ChartStyle } from "@/lib/dashboards/types";

import type { Categorical } from "../chartSpec";
import { gaugeOption } from "./looks";
import { chartOption, pickModeOf } from "./options";
import { PALETTES } from "./palette";
import { echarts, type ChartOption } from "./setup";

echarts.use([SVGRenderer]);

const colors = { series: ["#2a78d6", "#eb6834"], text: "#111", muted: "#666", grid: "#ddd", surface: "#fff" };

const sales: Categorical = {
  categories: ["north", "south"],
  raw: ["north", "south"],
  series: [
    { label: "revenue", data: [30, 10] },
    { label: "cost", data: [10, 30] },
  ],
};
const one: Categorical = { ...sales, series: [sales.series[0]] };

type Kind = ChartSpec["kind"];

function build(kind: Kind, look: ChartLook | undefined, c: Categorical = sales, style: ChartStyle = {}) {
  const spec: ChartSpec = { kind, x: "customer.region", y: [], agg: "sum", group: null };
  return chartOption({ spec, categorical: c, points: null, xType: "string", style: { ...style, ...(look && { look }) }, colors, picked: -1, locale: "en-US" });
}

/** Draws the option as ECharts would on a page: a bad option throws here. */
function draw(option: ChartOption): string {
  const chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 400, height: 300 });
  chart.setOption(option);
  const svg = chart.renderToSVGString();
  chart.dispose();
  return svg;
}

const seriesOf = (o: ChartOption) => o.series as Record<string, unknown>[];

describe("every visual draws", () => {
  it.each<[Kind, ChartLook | undefined]>([
    ["bar", undefined],
    ["bar", "stacked"],
    ["bar", "percent"],
    ["bar", "hbar"],
    ["bar", "hbar_stacked"],
    ["bar", "hbar_percent"],
    ["bar", "combo"],
    ["bar", "waterfall"],
    ["bar", "heatmap"],
    ["line", undefined],
    ["area", undefined],
    ["area", "area_stacked"],
    ["pie", undefined],
    ["pie", "donut"],
    ["pie", "treemap"],
    ["pie", "funnel"],
  ])("%s %s", (kind, look) => {
    expect(draw(build(kind, look))).toContain("<svg");
  });

  it("draws a gauge, with its top from a second value or a round number", () => {
    const at = (value: number, target: number | null) => gaugeOption({ value, target, name: "n", colors, palette: colors.series, locale: "en-US" });
    expect(draw(at(70, 100))).toContain("<svg");
    expect((at(70, 100).series as { max: number }[])[0].max).toBe(100);
    expect((at(70, null).series as { max: number }[])[0].max).toBe(100);
    expect((at(120, null).series as { max: number }[])[0].max).toBe(200);
  });
});

describe("the looks of bars", () => {
  it("stacks", () => {
    expect(seriesOf(build("bar", "stacked")).map((s) => s.stack)).toEqual(["total", "total"]);
    expect(seriesOf(build("bar", undefined)).map((s) => s.stack)).toEqual([undefined, undefined]);
  });

  it("fills to 100% with each value's share of its category", () => {
    const o = build("bar", "percent");
    expect(seriesOf(o).map((s) => s.data)).toEqual([
      [0.75, 0.25],
      [0.25, 0.75],
    ]);
    expect((o.yAxis as { max: number }[])[0].max).toBe(1);
  });

  it("swaps the axes of a horizontal chart, the first category on top, and picks down the plot", () => {
    const o = build("bar", "hbar");
    expect((o.xAxis as { type: string }[])[0].type).toBe("value");
    expect((o.yAxis as { type: string; inverse: boolean; data: string[] }[])[0]).toMatchObject({ type: "category", inverse: true, data: ["north", "south"] });
    expect(pickModeOf("bar", "hbar")).toBe("axisY");
  });

  it("draws the last series of a combo as its line", () => {
    expect(seriesOf(build("bar", "combo")).map((s) => s.type)).toEqual(["bar", "line"]);
    expect(seriesOf(build("bar", "combo", one)).map((s) => s.type)).toEqual(["bar"]);
  });

  it("adds a waterfall's steps up to a total, each step on what came before", () => {
    const fall: Categorical = { categories: ["a", "b", "c"], raw: ["a", "b", "c"], series: [{ label: "v", data: [10, -4, 5] }] };
    const o = build("bar", "waterfall", fall);
    const [base, bars] = seriesOf(o) as { data: (number | { value: number })[] }[];
    expect(base.data).toEqual([0, 6, 6, 0]);
    expect(bars.data.map((d) => (d as { value: number }).value)).toEqual([10, 4, 5, 11]);
    expect((o.xAxis as { data: string[] }[])[0].data).toEqual(["a", "b", "c", "Total"]);
  });

  it("colors a heatmap's cells by value, a cell for each value there is", () => {
    const gap: Categorical = { ...sales, series: [{ label: "a", data: [1, null] }, { label: "b", data: [3, 4] }] };
    const o = build("bar", "heatmap", gap);
    expect(seriesOf(o)[0].data).toEqual([[0, 0, 1], [0, 1, 3], [1, 1, 4]]);
    expect((o.visualMap as { max: number }[])[0].max).toBe(4);
    expect(o.legend).toBeUndefined();
    expect(pickModeOf("bar", "heatmap")).toBe("item");
  });
});

describe("the looks of slices", () => {
  it("makes a hole in a donut", () => {
    expect(seriesOf(build("pie", "donut", one))[0].radius).toEqual(["42%", "70%"]);
  });

  it("keeps each category's index on a treemap and a funnel, for a click", () => {
    for (const look of ["treemap", "funnel"] as const) {
      expect((seriesOf(build("pie", look, one))[0].data as { i: number; name: string }[]).map((d) => [d.i, d.name])).toEqual([[0, "north"], [1, "south"]]);
      expect(pickModeOf("pie", look)).toBe("item");
    }
  });

  it("shows no negative area on a treemap", () => {
    const c: Categorical = { ...one, series: [{ label: "v", data: [-5, 3] }] };
    expect((seriesOf(build("pie", "treemap", c))[0].data as { value: number }[]).map((d) => d.value)).toEqual([0, 3]);
  });
});

describe("colors and layout", () => {
  it("takes the colors in turn from the palette", () => {
    expect(build("bar", undefined, sales, { palette: "forest" }).color).toBe(PALETTES.forest);
    expect(build("bar", undefined).color).toBe(colors.series);
  });

  it("gives a series its own color, and only that one", () => {
    const [revenue, cost] = seriesOf(build("bar", undefined, sales, { colors: { revenue: "#112233" } })) as { itemStyle: { color?: string } }[];
    expect(revenue.itemStyle.color).toBe("#112233");
    expect(cost.itemStyle.color).toBeUndefined();
  });

  it("colors a line along with its points", () => {
    const [line] = seriesOf(build("line", undefined, one, { colors: { revenue: "#112233" } })) as { lineStyle: { color: string }; itemStyle: { color: string } }[];
    expect(line.lineStyle.color).toBe("#112233");
    expect(line.itemStyle.color).toBe("#112233");
  });

  it("gives a slice its own color", () => {
    const [north, south] = seriesOf(build("pie", undefined, one, { colors: { south: "#112233" } }))[0].data as { itemStyle?: { color: string } }[];
    expect(north.itemStyle).toBeUndefined();
    expect(south.itemStyle?.color).toBe("#112233");
  });

  it("does not take a color from an object's own methods", () => {
    const c: Categorical = { categories: ["constructor"], raw: ["constructor"], series: [{ label: "v", data: [1] }] };
    expect((seriesOf(build("pie", undefined, c, { colors: {} }))[0].data as { itemStyle?: unknown }[])[0].itemStyle).toBeUndefined();
  });

  it("moves or hides the legend, and leaves room for it", () => {
    const at = (legend: ChartStyle["legend"]) => build("bar", undefined, sales, { legend });
    expect(at(undefined).legend).toMatchObject({ top: 0 });
    expect(at("bottom").legend).toMatchObject({ bottom: 0 });
    expect(at("right").legend).toMatchObject({ right: 0, orient: "vertical" });
    expect((at("right").grid as { right: number }).right).toBeGreaterThan(100);
    expect(at("none").legend).toBeUndefined();
  });

  it("names the x axis after its column, without a related dataset's name, unless the chart titles it", () => {
    expect((build("bar", undefined).xAxis as { name: string }[])[0].name).toBe("region");
    expect((build("bar", undefined, sales, { x_title: "Região" }).xAxis as { name: string }[])[0].name).toBe("Região");
  });

  it("titles the y axis and takes its lines off on request", () => {
    const y = (build("bar", undefined, sales, { y_title: "R$", gridlines: false }).yAxis as { name: string; splitLine: { show: boolean } }[])[0];
    expect(y.name).toBe("R$");
    expect(y.splitLine.show).toBe(false);
  });

  it("writes a series in its own format, the others in the axis'", () => {
    const spec: ChartSpec = { kind: "bar", x: "region", y: [], agg: "sum", group: null };
    const o = chartOption({ spec, categorical: sales, points: null, xType: "string", colors, picked: -1, locale: "en-US", formats: { cost: { style: "percent" } } });
    const [revenue, cost] = seriesOf(o) as { tooltip: { valueFormatter(v: number): string } }[];
    expect(revenue.tooltip.valueFormatter(0.5)).toBe("0.5");
    expect(cost.tooltip.valueFormatter(0.5)).toBe("50%");
  });

  it("curves a line on request", () => {
    expect(seriesOf(build("line", undefined, one, { smooth: true }))[0].smooth).toBe(true);
  });
});
