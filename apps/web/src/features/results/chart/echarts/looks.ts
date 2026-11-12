/** The charts drawn in a look of their own, each from the shape of data its kind gives (pure). */

import type { FunnelSeriesOption, GaugeSeriesOption, HeatmapSeriesOption, TreemapSeriesOption } from "echarts/charts";

import type { ChartStyle } from "@/lib/dashboards/types";

import type { Categorical } from "../chartSpec";
import { esc, FADED, ownColor, seriesColors, show, tick, xAxisBase, xTitle, yAxisBase, axisLook, type Body, type OptionInput } from "./parts";
import type { ChartColors } from "./palette";
import type { ChartOption } from "./setup";

/** room under the plot for the heatmap's scale */
export const HEATMAP_SCALE_ROOM = 36;

/** a slice-like item: its category's index (`i`) comes back on a click, whatever order it is drawn in */
function itemsOf(input: OptionInput, c: Categorical) {
  const { style, picked } = input;
  const palette = seriesColors(input);
  const values = c.series[0]?.data ?? [];
  return c.categories.map((category, i) => {
    const name = String(category);
    return {
      i,
      name,
      // a treemap's areas cannot be negative
      value: Math.max(values[i] ?? 0, 0),
      itemStyle: { color: ownColor(style, name)?.color ?? palette[i % palette.length], ...(picked >= 0 && i !== picked && { opacity: FADED }) },
    };
  });
}

export function treemap(input: OptionInput, c: Categorical): Body {
  const { style, colors, locale } = input;
  const text = show(style?.format, locale);
  const series: TreemapSeriesOption = {
    type: "treemap",
    roam: false,
    nodeClick: false,
    breadcrumb: { show: false },
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    itemStyle: { borderColor: colors.surface, borderWidth: 2, gapWidth: 2 },
    label: { show: true, color: "#fff", fontSize: 12, overflow: "truncate", formatter: (p) => (style?.labels ? `${p.name}\n${text(p.value)}` : p.name) },
    tooltip: { valueFormatter: text },
    data: itemsOf(input, c),
  };
  return { series: [series] };
}

export function funnel(input: OptionInput, c: Categorical): Body {
  const { style, colors, locale } = input;
  const text = show(style?.format, locale);
  const series: FunnelSeriesOption = {
    type: "funnel",
    sort: "descending",
    gap: 2,
    left: "15%",
    right: "15%",
    top: 32,
    bottom: 8,
    minSize: "8%",
    itemStyle: { borderColor: colors.surface, borderWidth: 1 },
    label: { show: true, position: "inside", color: "#fff", fontSize: 11, formatter: (p) => (style?.labels ? `${p.name}: ${text(p.value)}` : p.name) },
    tooltip: { valueFormatter: text },
    data: itemsOf(input, c),
  };
  return { series: [series] };
}

/**
 * The first series as steps from zero, ending in their total. Stacked bars: an empty one holds each step up.
 * shortcut: a step that crosses zero is drawn from zero only; split the bar in two if a chart needs it exact.
 */
export function waterfall(input: OptionInput, c: Categorical): Body {
  const { spec, style, colors, locale } = input;
  const palette = seriesColors(input);
  const steps = (c.series[0]?.data ?? []).map((v) => v ?? 0);
  const text = show(style?.format, locale);
  const label = c.series[0]?.label ?? "";
  const up = ownColor(style, "Increase")?.color ?? palette[0];
  const down = ownColor(style, "Decrease")?.color ?? palette[1 % palette.length];
  const total = ownColor(style, "Total")?.color ?? colors.muted;
  let running = 0;
  const base: number[] = [];
  const shown: { value: number; itemStyle: { color: string }; written: string }[] = [];
  steps.forEach((v) => {
    const next = running + v;
    base.push(Math.max(Math.min(running, next), 0));
    shown.push({ value: Math.abs(v), itemStyle: { color: v >= 0 ? up : down }, written: text(v) });
    running = next;
  });
  base.push(0);
  shown.push({ value: Math.abs(running), itemStyle: { color: total }, written: text(running) });
  const x = xAxisBase(xTitle(spec, style), colors);
  return {
    series: [
      { type: "bar", stack: "w", silent: true, itemStyle: { color: "transparent" }, tooltip: { show: false }, data: base },
      {
        type: "bar",
        name: label,
        stack: "w",
        barMaxWidth: 40,
        data: shown,
        label: style?.labels ? { show: true, position: "top", color: colors.text, fontSize: 11, formatter: (p) => (p.data as { written: string }).written } : undefined,
        tooltip: { formatter: (p) => `${esc(p.name)}: ${esc((p.data as { written: string }).written)}` },
      },
    ],
    xAxis: [{ ...x, type: "category", data: [...c.categories.map(String), "Total"], axisTick: { ...x.axisTick, alignWithLabel: true } }],
    yAxis: [yAxisBase(colors, style?.format, locale, style)],
    tooltip: { trigger: "item" },
  };
}

/** Each series a row and each category a column, colored by value. */
export function heatmap(input: OptionInput, c: Categorical): Body {
  const { spec, style, colors, locale } = input;
  const palette = seriesColors(input);
  const text = show(style?.format, locale);
  const cells = c.series.flatMap((s, y) => s.data.flatMap((v, x) => (v === null ? [] : [[x, y, v]])));
  const values = cells.map((cell) => cell[2]);
  const x = xAxisBase(xTitle(spec, style), colors);
  const series: HeatmapSeriesOption = {
    type: "heatmap",
    data: cells,
    itemStyle: { borderColor: colors.surface, borderWidth: 1 },
    label: style?.labels ? { show: true, fontSize: 11, formatter: (p) => tick(style.format, locale)((p.value as number[])[2]) } : { show: false },
    tooltip: {
      formatter: (p) => {
        const [cx, cy, v] = p.value as number[];
        return `${esc(String(c.categories[cx]))} · ${esc(c.series[cy].label)}: ${text(v)}`;
      },
    },
  };
  return {
    series: [series],
    xAxis: [{ ...x, type: "category", data: c.categories.map(String), splitArea: { show: false } }],
    yAxis: [{ ...axisLook(colors), type: "category", data: c.series.map((s) => s.label), splitLine: { show: false } }],
    visualMap: [
      {
        type: "continuous",
        min: Math.min(0, ...values),
        max: Math.max(1, ...values),
        orient: "horizontal",
        left: "center",
        bottom: 0,
        itemHeight: 120,
        itemWidth: 10,
        textStyle: { color: colors.muted, fontSize: 11 },
        formatter: (v) => tick(style?.format, locale)(Number(v)),
        inRange: { color: [colors.surface, ownColor(style, "Scale")?.color ?? palette[0]] },
      },
    ],
    tooltip: { trigger: "item" },
  };
}

/** A round number above `value`: 1, 2 or 5 and zeros. */
function roundAbove(value: number): number {
  if (value <= 0) return 1;
  const scale = 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5, 10].map((n) => n * scale).find((n) => n >= value) ?? value;
}

/** One value against a top: the style's, else a second value on the chart, else a round number above it. */
export function gaugeOption({ value, target, name, style, colors, palette, locale }: { value: number | null; target: number | null; name: string; style?: ChartStyle; colors: ChartColors; palette: string[]; locale: string }): ChartOption {
  const text = show(style?.format, locale);
  const v = value ?? 0;
  const series: GaugeSeriesOption = {
    type: "gauge",
    min: 0,
    max: style?.gauge_max ?? target ?? roundAbove(v),
    startAngle: 200,
    endAngle: -20,
    progress: { show: true, width: 14, itemStyle: { color: ownColor(style, name)?.color ?? palette[0] } },
    axisLine: { lineStyle: { width: 14, color: [[1, colors.grid]] } },
    axisTick: { show: false },
    splitLine: { show: false },
    axisLabel: { show: false },
    pointer: { show: false },
    anchor: { show: false },
    title: { offsetCenter: [0, "32%"], color: colors.muted, fontSize: 12 },
    detail: { offsetCenter: [0, "2%"], valueAnimation: false, color: colors.text, fontSize: 28, fontWeight: 600, formatter: () => text(value) },
    data: [{ value: v, name }],
  };
  return { animation: false, series: [series], aria: { enabled: true } };
}
