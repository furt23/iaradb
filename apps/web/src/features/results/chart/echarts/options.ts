/** The ECharts option of a chart: what to draw, in the chart's colors and number formats (pure, no React). */

import type { BarSeriesOption, LineSeriesOption, PieSeriesOption, ScatterSeriesOption } from "echarts/charts";
import { fonts } from "@iara/ui";

import type { ChartLook, LegendPosition } from "@/lib/dashboards/types";

import { isTemporalType, type Categorical, type Point } from "../chartSpec";
import { funnel, heatmap, HEATMAP_SCALE_ROOM, treemap, waterfall } from "./looks";
import { esc, FADED, labelOf, ownColor, seriesColors, show, toMs, xAxisBase, xTitle, yAxisBase, type Body, type OptionInput } from "./parts";
import type { ChartOption } from "./setup";

export type { OptionInput } from "./parts";

const MARGIN = { left: 8, right: 16, top: 16, bottom: 8 };
/** the height of the legend row above or below the grid */
const LEGEND_ROOM = 28;
/** the width of a legend beside the grid */
const LEGEND_SIDE = 130;
const MAX_PIE_LEGEND = 12;
const PERCENT = { style: "percent", decimals: 1 } as const;
/** a fuller area, where the series stack on each other */
const STACKED_AREA_OPACITY = 0.55;
const SLICE_LOOKS: readonly (ChartLook | undefined)[] = [undefined, "donut"];

const isHorizontal = (look?: ChartLook) => look === "hbar" || look === "hbar_stacked" || look === "hbar_percent";
const isPercent = (look?: ChartLook) => look === "percent" || look === "hbar_percent";
const isStacked = (look?: ChartLook) => look === "stacked" || look === "hbar_stacked" || look === "area_stacked" || isPercent(look);

/** Each value as its share of its category's total, for a chart that fills to 100%. */
function shares(series: Categorical["series"]): Categorical["series"] {
  const totals = (series[0]?.data ?? []).map((_, i) => series.reduce((sum, s) => sum + Math.abs(s.data[i] ?? 0), 0));
  return series.map((s) => ({ ...s, data: s.data.map((v, i) => (v === null || !totals[i] ? null : Math.abs(v) / totals[i])) }));
}

/** Bars, lines and areas, singly or mixed: x is the categories, y the series. */
function cartesian(input: OptionInput, c: Categorical): Body {
  const { spec, style, colors, picked, locale, xType, formats } = input;
  const { categories } = c;
  const look = style?.look;
  const horizontal = isHorizontal(look);
  const percent = isPercent(look);
  const stacked = isStacked(look);
  const series = percent ? shares(c.series) : c.series;
  const barKind = spec.kind === "bar" || spec.kind === "histogram";
  const time = !barKind && isTemporalType(xType);
  const numeric = !barKind && !time && categories.length > 0 && categories.every((v) => typeof v === "number");
  /** where each category sits on a time or number axis */
  const xs = time ? categories.map(toMs) : numeric ? (categories as number[]) : null;
  // a series is a value column only without a group, a histogram has just its count, and a horizontal chart has one value axis
  const styles = spec.group || spec.kind === "histogram" || horizontal ? undefined : style?.series;
  // with several series a click picks a category, not one series' bar
  const marked = picked >= 0 && series.length === 1;
  const rightNames = series.filter((s) => styles?.[s.label]?.axis === "right").map((s) => s.label);
  const lastSeries = series.length - 1;

  const out = series.map((s, at): BarSeriesOption | LineSeriesOption => {
    const st = styles?.[s.label];
    const right = st?.axis === "right";
    const text = show(percent ? PERCENT : (formats?.[s.label] ?? (right ? style?.right_format : style?.format)), locale);
    const own = ownColor(style, s.label);
    const base = {
      name: s.label,
      yAxisIndex: right ? 1 : 0,
      tooltip: { valueFormatter: text },
      label: labelOf(style?.labels, colors, text, horizontal ? "right" : stacked ? "inside" : "top"),
    };
    // a combo chart's last series is its line, until the author says otherwise
    const drawn = st?.as ?? (look === "combo" && series.length > 1 && at === lastSeries ? "line" : barKind ? "bar" : "line");
    if (drawn === "bar") {
      const round = horizontal ? [0, 4, 4, 0] : [4, 4, 0, 0];
      return {
        ...base,
        type: "bar",
        stack: spec.kind === "histogram" ? "bins" : stacked ? "total" : undefined,
        barMaxWidth: 40,
        itemStyle: { borderRadius: stacked ? 0 : round, ...own },
        data: s.data.map((v, i) => {
          const value = xs ? [xs[i], v] : v;
          return marked && i !== picked ? { value, itemStyle: { opacity: FADED } } : value;
        }),
      };
    }
    return {
      ...base,
      type: "line",
      smooth: style?.smooth === true,
      stack: stacked ? "total" : undefined,
      lineStyle: { width: 2, ...own },
      itemStyle: own,
      showSymbol: categories.length <= 40,
      connectNulls: true,
      // the area chart's own series; `as: "line"` draws a plain line
      areaStyle: spec.kind === "area" && !st?.as ? { opacity: stacked ? STACKED_AREA_OPACITY : 0.15 } : undefined,
      data: s.data.map((v, i) => (xs ? [xs[i], v] : v)),
      markLine: marked
        ? { silent: true, symbol: "none", label: { show: false }, lineStyle: { type: "dashed", color: colors.muted }, data: [{ xAxis: xs ? xs[picked] : picked }] }
        : undefined,
    };
  });

  const xBase = xAxisBase(xTitle(spec, style), colors);
  const format = percent ? PERCENT : style?.format;
  const values = yAxisBase(colors, format, locale, style);
  const categoryAxis = { ...xBase, type: "category" as const, data: categories.map(String), axisTick: { ...xBase.axisTick, alignWithLabel: true } };
  if (horizontal) {
    return {
      series: out,
      // the first category on top, as it reads
      yAxis: [{ ...categoryAxis, inverse: true, nameLocation: "middle", nameGap: 8 }],
      xAxis: [{ ...values, ...(percent && { max: 1 }) }],
    };
  }
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
          : categoryAxis,
    ],
    yAxis: [
      { ...values, ...(percent && { max: 1 }) },
      // the right axis names its series, so the reader knows what it measures
      ...(rightNames.length
        ? [{ ...yAxisBase(colors, style?.right_format, locale), position: "right" as const, splitLine: { show: false }, name: rightNames.join(", "), nameLocation: "middle" as const, nameGap: 8 }]
        : []),
    ],
  };
}

/** Where a pie's middle goes, out of the legend's way. */
function pieCenter(legend: LegendPosition | undefined): [string, string] {
  if (legend === "right") return ["40%", "50%"];
  if (legend === "left") return ["60%", "50%"];
  if (legend === "bottom") return ["50%", "45%"];
  return legend === "none" ? ["50%", "50%"] : ["50%", "55%"];
}

/** One series of slices, by category. */
function pie(input: OptionInput, c: Categorical): Body {
  const { style, colors, picked, locale } = input;
  const values = c.series[0]?.data ?? [];
  const text = show(style?.format, locale);
  const slices: PieSeriesOption = {
    type: "pie",
    radius: style?.look === "donut" ? ["42%", "70%"] : "70%",
    center: pieCenter(style?.legend),
    itemStyle: { borderColor: colors.surface, borderWidth: 2 },
    label: style?.labels ? { show: true, color: colors.text, fontSize: 11, formatter: (p) => `${p.name}: ${text(p.value)}` } : { show: false },
    labelLine: { lineStyle: { color: colors.muted } },
    tooltip: { valueFormatter: text },
    data: c.categories.map((category, i) => {
      const own = ownColor(style, String(category));
      const faded = picked >= 0 && i !== picked;
      return {
        name: String(category),
        value: values[i] ?? 0,
        ...((own || faded) && { itemStyle: { ...own, ...(faded && { opacity: FADED }) } }),
      };
    }),
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
        itemStyle: ownColor(style, g.label),
        data: g.data.map((p) => [p.x, p.y]),
        tooltip: {
          formatter: (p) => {
            const [px, py] = p.value as number[];
            return `${esc(spec.x)}: ${x(px)}<br/>${p.marker}${esc(p.seriesName ?? "")}: ${y(py)}`;
          },
        },
      }),
    ),
    xAxis: [{ ...xAxisBase(xTitle(spec, style), colors), type: "value", scale: true }],
    yAxis: [{ ...yAxisBase(colors, style?.format, locale, style), scale: true }],
  };
}

/** What the chart's kind and look draw. */
function bodyOf(input: OptionInput): Body {
  const { spec, categorical, points, style } = input;
  if (spec.kind === "scatter" || !categorical) return scatter(input, points ?? []);
  if (style?.look === "treemap") return treemap(input, categorical);
  if (style?.look === "funnel") return funnel(input, categorical);
  if (style?.look === "waterfall") return waterfall(input, categorical);
  if (style?.look === "heatmap") return heatmap(input, categorical);
  return spec.kind === "pie" ? pie(input, categorical) : cartesian(input, categorical);
}

/** Where the legend sits, and what the grid must leave for it. */
function legendAt(position: LegendPosition): { place: object; room: Partial<typeof MARGIN> } {
  if (position === "bottom") return { place: { bottom: 0 }, room: { bottom: MARGIN.bottom + LEGEND_ROOM } };
  if (position === "left") return { place: { left: 0, top: "middle", orient: "vertical" }, room: { left: MARGIN.left + LEGEND_SIDE } };
  if (position === "right") return { place: { right: 0, top: "middle", orient: "vertical" }, room: { right: MARGIN.right + LEGEND_SIDE } };
  return { place: { top: 0 }, room: { top: MARGIN.top + LEGEND_ROOM } };
}

/** How the chart can be clicked: by category under the pointer, across or down the plot, or by the item under it. */
export function pickModeOf(kind: string, look: ChartLook | undefined): "axis" | "axisY" | "item" {
  if (kind === "pie" || look === "heatmap") return "item";
  return isHorizontal(look) ? "axisY" : "axis";
}

export function chartOption(input: OptionInput): ChartOption {
  const { spec, categorical, points, colors, style } = input;
  const look = style?.look;
  const { tooltip, ...body } = bodyOf(input);
  const slices = spec.kind === "pie" && SLICE_LOOKS.includes(look);
  const plain = spec.kind !== "pie" && look !== "waterfall" && look !== "heatmap";
  const count = categorical && spec.kind !== "scatter" ? categorical.series.length : (points?.length ?? 0);
  const auto = slices ? (categorical?.categories.length ?? 0) <= MAX_PIE_LEGEND : plain && count > 1;
  const legend = auto && style?.legend !== "none" ? legendAt(style?.legend ?? "top") : null;
  const along = plain && spec.kind !== "scatter";
  const grid = spec.kind === "pie" ? undefined : { ...MARGIN, ...legend?.room, ...(look === "heatmap" && { bottom: MARGIN.bottom + HEATMAP_SCALE_ROOM }), outerBoundsMode: "same" as const };
  return {
    animation: false,
    textStyle: { fontFamily: fonts.sans },
    color: seriesColors(input),
    aria: { enabled: true },
    tooltip: {
      trigger: along ? "axis" : "item",
      axisPointer: { type: spec.kind === "bar" || spec.kind === "histogram" ? "shadow" : "line" },
      confine: true,
      backgroundColor: colors.surface,
      borderColor: colors.grid,
      textStyle: { color: colors.text, fontSize: 12 },
      ...(tooltip as object | undefined),
    },
    legend: legend
      ? {
          type: "scroll",
          ...legend.place,
          textStyle: { color: colors.text, fontSize: 12 },
          pageIconColor: colors.text,
          pageIconInactiveColor: colors.grid,
          pageTextStyle: { color: colors.muted },
        }
      : undefined,
    // the margins hold the axis labels and names too: the grid shrinks to leave room for them
    grid,
    ...body,
  };
}
