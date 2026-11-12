/** What the builders of a chart's option share: its input, and the look of axes, labels and tooltips (pure). */

import type { ChartSpec } from "@iara/protocol";

import { formatNumber } from "@/lib/dashboards/numberFormat";
import type { ChartStyle, NumberFormat } from "@/lib/dashboards/types";
import { formatCompact } from "@/lib/format";

import type { Categorical, Point } from "../chartSpec";
import { PALETTES, type ChartColors } from "./palette";
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
  /** a series' own number format, by its label */
  formats?: Record<string, NumberFormat>;
}

/** what a builder draws; the rest of the option is the same for every chart */
export type Body = Pick<ChartOption, "series" | "xAxis" | "yAxis" | "visualMap"> & { tooltip?: ChartOption["tooltip"] };

/** the categories that are not the picked one */
export const FADED = 0.35;

/** numbers on an axis: as the chart's format says, short (35K, 1.2M) without one */
export function tick(format: NumberFormat | undefined, locale: string) {
  return (v: number) => (format ? formatNumber(v, format, locale) : formatCompact(v));
}

/** a value in a tooltip or a label ("—" for none) */
export function show(format: NumberFormat | undefined, locale: string) {
  return (v: unknown) => (typeof v === "number" ? formatNumber(v, format, locale) : "—");
}

/** a point's y: the last of its [x, y] pair, or the value itself */
export function yOf(value: unknown): unknown {
  return Array.isArray(value) ? value[value.length - 1] : value;
}

/** Tooltips are HTML: a column or group name must not become markup. */
export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** A date or timestamp in ms, as local time like the axis labels (a bare date parses as UTC, a day early in the Americas). */
export function toMs(v: string | number): number {
  return typeof v === "number" ? v : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00` : v);
}

/** The colors the chart takes in turn: its palette's, or the app's. */
export function seriesColors({ style, colors }: Pick<OptionInput, "style" | "colors">): string[] {
  return style?.palette ? PALETTES[style.palette] : colors.series;
}

/** A series' or category's own color, as an item style (nothing when it has none). */
export function ownColor(style: ChartStyle | undefined, label: string): { color: string } | undefined {
  const color = style?.colors && Object.hasOwn(style.colors, label) ? style.colors[label] : undefined;
  return color ? { color } : undefined;
}

/** the look every axis shares */
export function axisLook(colors: ChartColors) {
  const line = { color: colors.grid, width: 1 };
  return {
    axisLabel: { color: colors.muted, fontSize: 11 },
    axisLine: { lineStyle: line },
    axisTick: { lineStyle: line },
    splitLine: { lineStyle: line },
    nameTextStyle: { color: colors.muted, fontSize: 11 },
  };
}

/** What the x axis is called: the title the chart gives it, else its column, without the dataset of a related one. */
export function xTitle(spec: ChartSpec, style: ChartStyle | undefined): string {
  return style?.x_title ?? spec.x.slice(spec.x.lastIndexOf(".") + 1);
}

/** a horizontal axis, named under its middle; its labels never get cut off */
export function xAxisBase(name: string, colors: ChartColors) {
  return { ...axisLook(colors), splitLine: { show: false }, name, nameLocation: "middle" as const, nameGap: 8 };
}

/** a value axis of numbers; `style` gives it its title and says whether it draws lines across the plot */
export function yAxisBase(colors: ChartColors, format: NumberFormat | undefined, locale: string, style?: ChartStyle) {
  const look = axisLook(colors);
  return {
    ...look,
    type: "value" as const,
    axisLabel: { color: colors.muted, fontSize: 11, formatter: tick(format, locale) },
    ...(style?.gridlines === false && { splitLine: { show: false } }),
    ...(style?.y_title && { name: style.y_title, nameLocation: "middle" as const, nameGap: 8 }),
  };
}

/** The labels next to bars, points and slices when the chart asks for them. */
export function labelOf(on: boolean | undefined, colors: ChartColors, text: (v: unknown) => string, position: "top" | "right" | "inside" = "top") {
  return on ? { show: true, position, color: colors.text, fontSize: 11, formatter: (p: { value?: unknown }) => text(yOf(p.value)) } : undefined;
}
