/** The ECharts option of a chart: what to draw, in the app's colors and number formats (pure, no React). */

import type { BarSeriesOption, LineSeriesOption, PieSeriesOption, ScatterSeriesOption } from "echarts/charts";
import type { ChartSpec } from "@iara/protocol";
import { fonts } from "@iara/ui";

import { formatNumber } from "@/lib/dashboards/numberFormat";
import type { ChartStyle, NumberFormat } from "@/lib/dashboards/types";
import { formatCompact } from "@/lib/format";

import { isTemporalType, type Categorical, type Point } from "../chartSpec";
import type { ChartColors } from "./palette";
import type { ChartOption } from "./setup";

export interface OptionInput {
  /** never a counter: that is a number, not a chart */
  spec: ChartSpec;
  categorical: Categorical | null;
  points: { label: string; data: Point[] }[] | null;
  /** the type of the x column: a temporal one gets a time axis */
  xType: string;
  style?: ChartStyle;
  colors: ChartColors;
  /** the picked category's index, -1 for none */
  picked: number;
  locale: string;
}

/** what a builder draws; the rest of the option is the same for every chart */
type Body = Pick<ChartOption, "series" | "xAxis" | "yAxis">;

const MARGIN = { left: 8, right: 16, top: 16, bottom: 8 };
/** the height of the legend row above the grid */
const LEGEND_ROOM = 28;
const MAX_PIE_LEGEND = 12;
/** the categories that are not the picked one */
const FADED = 0.35;

/** numbers on an axis: as the chart's format says, short (35K, 1.2M) without one */
function tick(format: NumberFormat | undefined, locale: string) {
  return (v: number) => (format ? formatNumber(v, format, locale) : formatCompact(v));
}

/** a value in a tooltip or a label ("—" for none) */
function show(format: NumberFormat | undefined, locale: string) {
  return (v: unknown) => (typeof v === "number" ? formatNumber(v, format, locale) : "—");
}

/** a point's y: the last of its [x, y] pair, or the value itself */
function yOf(value: unknown): unknown {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

/** Tooltips are HTML: a column or group name must not become markup. */
function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** A date or timestamp in ms, as local time like the axis labels (a bare date parses as UTC, a day early in the Americas). */
function toMs(v: string | number): number {
  return typeof v === "number" ? v : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00` : v);
}

/** the look every axis shares */
function axisLook(colors: ChartColors) {
  const line = { color: colors.grid, width: 1 };
  return {
    axisLabel: { color: colors.muted, fontSize: 11 },
    axisLine: { lineStyle: line },
    axisTick: { lineStyle: line },
    splitLine: { lineStyle: line },
    nameTextStyle: { color: colors.muted, fontSize: 11 },
  };
}

/** a horizontal axis, named under its middle; its labels never get cut off */
function xAxisBase(name: string, colors: ChartColors) {
  return { ...axisLook(colors), splitLine: { show: false }, name, nameLocation: "middle" as const, nameGap: 8 };
}

/** a value axis of numbers */
function yAxisBase(colors: ChartColors, format: NumberFormat | undefined, locale: string) {
  return { ...axisLook(colors), type: "value" as const, axisLabel: { color: colors.muted, fontSize: 11, formatter: tick(format, locale) } };
}

/** The labels next to bars, points and slices when the chart asks for them. */
function labelOf(on: boolean | undefined, colors: ChartColors, text: (v: unknown) => string) {
  return on ? { show: true, position: "top" as const, color: colors.text, fontSize: 11, formatter: (p: { value?: unknown }) => text(yOf(p.value)) } : undefined;
}

/** Bars, lines and areas, singly or mixed: x is the categories, y the series. */
function cartesian(input: OptionInput, c: Categorical): Body {
  const { spec, style, colors, picked, locale, xType } = input;
  const { categories, series } = c;
  const barKind = spec.kind === "bar" || spec.kind === "histogram";
  const time = !barKind && isTemporalType(xType);
  const numeric = !barKind && !time && categories.length > 0 && categories.every((v) => typeof v === "number");
  /** where each category sits on a time or number axis */
  const xs = time ? categories.map(toMs) : numeric ? (categories as number[]) : null;
  // a series is a value column only without a group, and a histogram has just its count
  const styles = spec.group || spec.kind === "histogram" ? undefined : style?.series;
  // with several series a click picks a category, not one series' bar
  const marked = picked >= 0 && series.length === 1;
  const rightNames = series.filter((s) => styles?.[s.label]?.axis === "right").map((s) => s.label);

  const out = series.map((s): BarSeriesOption | LineSeriesOption => {
    const st = styles?.[s.label];
    const right = st?.axis === "right";
    const text = show(right ? style?.right_format : style?.format, locale);
    const base = { name: s.label, yAxisIndex: right ? 1 : 0, tooltip: { valueFormatter: text }, label: labelOf(style?.labels, colors, text) };
    if ((st?.as ?? (barKind ? "bar" : "line")) === "bar") {
      return {
        ...base,
        type: "bar",
        stack: spec.kind === "histogram" ? "bins" : undefined,
        barMaxWidth: 40,
        itemStyle: { borderRadius: [4, 4, 0, 0] },
        data: s.data.map((v, i) => {
          const value = xs ? [xs[i], v] : v;
          return marked && i !== picked ? { value, itemStyle: { opacity: FADED } } : value;
        }),
      };
    }
    return {
      ...base,
      type: "line",
      lineStyle: { width: 2 },
      showSymbol: categories.length <= 40,
      connectNulls: true,
      // the area chart's own series; `as: "line"` draws a plain line
      areaStyle: spec.kind === "area" && !st?.as ? { opacity: 0.15 } : undefined,
      data: s.data.map((v, i) => (xs ? [xs[i], v] : v)),
      markLine: marked
        ? { silent: true, symbol: "none", label: { show: false }, lineStyle: { type: "dashed", color: colors.muted }, data: [{ xAxis: xs ? xs[picked] : picked }] }
        : undefined,
    };
  });

  const xBase = xAxisBase(spec.x, colors);
  return {
    series: out,
    xAxis: [
      time
        ? { ...xBase, type: "time" }
        : numeric
          ? {
              ...xBase,
              type: "value",
              scale: true,
              // 2020, not "2,020"; whole numbers (years) get no ticks between them
              axisLabel: { ...xBase.axisLabel, formatter: String },
              minInterval: categories.every(Number.isInteger) ? 1 : undefined,
            }
          : { ...xBase, type: "category", data: categories.map(String), axisTick: { ...xBase.axisTick, alignWithLabel: true } },
    ],
    yAxis: [
      yAxisBase(colors, style?.format, locale),
      // the right axis names its series, so the reader knows what it measures
      ...(rightNames.length
        ? [{ ...yAxisBase(colors, style?.right_format, locale), position: "right" as const, splitLine: { show: false }, name: rightNames.join(", "), nameLocation: "middle" as const, nameGap: 8 }]
        : []),
    ],
  };
}

/** One series of slices, by category. */
function pie(input: OptionInput, c: Categorical): Body {
  const { style, colors, picked, locale } = input;
  const values = c.series[0]?.data ?? [];
  const text = show(style?.format, locale);
  const slices: PieSeriesOption = {
    type: "pie",
    radius: "70%",
    itemStyle: { borderColor: colors.surface, borderWidth: 2 },
    label: style?.labels ? { show: true, color: colors.text, fontSize: 11, formatter: (p) => `${p.name}: ${text(p.value)}` } : { show: false },
    labelLine: { lineStyle: { color: colors.muted } },
    tooltip: { valueFormatter: text },
    data: c.categories.map((category, i) => ({
      name: String(category),
      value: values[i] ?? 0,
      ...(picked >= 0 && i !== picked && { itemStyle: { opacity: FADED } }),
    })),
  };
  return { series: [slices] };
}

/** One series of points per value column or group; both axes are numbers. */
function scatter(input: OptionInput, groups: { label: string; data: Point[] }[]): Body {
  const { spec, style, colors, locale } = input;
  const x = show(undefined, locale);
  const y = show(style?.format, locale);
  return {
    series: groups.map(
      (g): ScatterSeriesOption => ({
        type: "scatter",
        name: g.label,
        symbolSize: 6,
        data: g.data.map((p) => [p.x, p.y]),
        tooltip: {
          formatter: (p) => {
            const [px, py] = p.value as number[];
            return `${esc(spec.x)}: ${x(px)}<br/>${p.marker}${esc(p.seriesName ?? "")}: ${y(py)}`;
          },
        },
      }),
    ),
    xAxis: [{ ...xAxisBase(spec.x, colors), type: "value", scale: true }],
    yAxis: [{ ...yAxisBase(colors, style?.format, locale), scale: true }],
  };
}

export function chartOption(input: OptionInput): ChartOption {
  const { spec, categorical, points, colors } = input;
  const body =
    spec.kind === "scatter" || !categorical ? scatter(input, points ?? []) : spec.kind === "pie" ? pie(input, categorical) : cartesian(input, categorical);
  const count = categorical && spec.kind !== "scatter" ? categorical.series.length : (points?.length ?? 0);
  const legend = spec.kind === "pie" ? (categorical?.categories.length ?? 0) <= MAX_PIE_LEGEND : count > 1;
  const top = legend ? MARGIN.top + LEGEND_ROOM : MARGIN.top;
  const along = spec.kind === "bar" || spec.kind === "histogram" || spec.kind === "line" || spec.kind === "area";
  return {
    animation: false,
    textStyle: { fontFamily: fonts.sans },
    color: colors.series,
    aria: { enabled: true },
    tooltip: {
      trigger: along ? "axis" : "item",
      axisPointer: { type: spec.kind === "bar" || spec.kind === "histogram" ? "shadow" : "line" },
      confine: true,
      backgroundColor: colors.surface,
      borderColor: colors.grid,
      textStyle: { color: colors.text, fontSize: 12 },
    },
    legend: legend
      ? {
          type: "scroll",
          top: 0,
          textStyle: { color: colors.text, fontSize: 12 },
          pageIconColor: colors.text,
          pageIconInactiveColor: colors.grid,
          pageTextStyle: { color: colors.muted },
        }
      : undefined,
    // the margins hold the axis labels and names too: the grid shrinks to leave room for them
    grid: spec.kind === "pie" ? undefined : { ...MARGIN, top, outerBoundsMode: "same" },
    ...body,
  };
}
