/** Chart styles, number formats and table column formats: checked at the trust boundary, rebuilt with the known keys only (pure). */

import type { ChartLook, ChartPalette, ChartStyle, ColorRule, ColumnFormat, LegendPosition, NumberFormat, SeriesStyle, Tone } from "./types";

type Obj = Record<string, unknown>;

const NUMBER_STYLES = ["number", "currency", "percent"] as const;
const OPS = [">", ">=", "<", "<=", "=", "!="] as const;
const TONES: readonly Tone[] = ["green", "amber", "orange", "red", "blue"];
const CURRENCY = /^[A-Z]{3}$/;
const MAX_RULES = 20;
const LOOKS: readonly ChartLook[] = ["stacked", "percent", "hbar", "hbar_stacked", "hbar_percent", "combo", "area_stacked", "donut", "treemap", "funnel", "waterfall", "heatmap", "matrix", "gauge"];
const PALETTES: readonly ChartPalette[] = ["ocean", "sunset", "forest", "berry", "earth", "mono"];
const LEGENDS: readonly LegendPosition[] = ["top", "bottom", "left", "right", "none"];
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const MAX_COLORS = 200;
const MAX_TITLE = 120;

function object(v: unknown, what: string): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} is an object`);
  return v as Obj;
}

function oneOf<T extends string>(v: unknown, list: readonly T[], what: string): T {
  if (typeof v !== "string" || !list.includes(v as T)) throw new Error(`${what} is one of ${list.join(", ")}`);
  return v as T;
}

function flag(v: unknown, what: string): boolean {
  if (typeof v !== "boolean") throw new Error(`${what} is true or false`);
  return v;
}

/** A number format; `what` names it in the messages. */
export function checkNumberFormat(v: unknown, what: string): NumberFormat {
  const { style, decimals, currency, compact } = object(v, what);
  const s = oneOf(style, NUMBER_STYLES, `${what} style`);
  if (decimals !== undefined && (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 10)) {
    throw new Error(`${what} decimals is a whole number from 0 to 10`);
  }
  if (s === "currency" && (typeof currency !== "string" || !CURRENCY.test(currency))) {
    throw new Error(`${what} currency is a 3-letter ISO code, such as BRL`);
  }
  return {
    style: s,
    ...(decimals !== undefined && { decimals: decimals as number }),
    ...(s === "currency" && { currency: currency as string }),
    ...(compact !== undefined && { compact: flag(compact, `${what} compact`) }),
  };
}

function seriesOf(v: unknown): Record<string, SeriesStyle> {
  // fromEntries, not an assignment: a column named __proto__ must stay a key
  return Object.fromEntries(
    Object.entries(object(v, "series")).map(([column, s]): [string, SeriesStyle] => {
      const o = object(s, `series ${column}`);
      return [
        column,
        {
          ...(o.axis !== undefined && { axis: oneOf<"right">(o.axis, ["right"], `series ${column} axis`) }),
          ...(o.as !== undefined && { as: oneOf<"bar" | "line">(o.as, ["bar", "line"], `series ${column} as`) }),
        },
      ];
    }),
  );
}

function colorsOf(v: unknown): Record<string, string> {
  const entries = Object.entries(object(v, "colors"));
  if (entries.length > MAX_COLORS) throw new Error(`colors holds at most ${MAX_COLORS} colors`);
  // fromEntries, not an assignment: a label named __proto__ must stay a key
  return Object.fromEntries(
    entries.map(([label, color]) => {
      if (typeof color !== "string" || !HEX_COLOR.test(color)) throw new Error(`the color of ${label} is written #rrggbb`);
      return [label, color];
    }),
  );
}

function axisTitle(v: unknown, what: string): string {
  if (typeof v !== "string" || v.length > MAX_TITLE) throw new Error(`${what} is text of at most ${MAX_TITLE} characters`);
  return v;
}

/** The style of a chart widget. */
export function checkChartStyle(v: unknown): ChartStyle {
  const { look, palette, colors, legend, gridlines, smooth, x_title, y_title, gauge_max, series, labels, format, right_format } = object(v, "style");
  if (gauge_max !== undefined && (typeof gauge_max !== "number" || !Number.isFinite(gauge_max) || gauge_max <= 0)) throw new Error("gauge_max is a number above zero");
  return {
    ...(look !== undefined && { look: oneOf(look, LOOKS, "look") }),
    ...(palette !== undefined && { palette: oneOf(palette, PALETTES, "palette") }),
    ...(colors !== undefined && { colors: colorsOf(colors) }),
    ...(legend !== undefined && { legend: oneOf(legend, LEGENDS, "legend") }),
    ...(gridlines !== undefined && { gridlines: flag(gridlines, "gridlines") }),
    ...(smooth !== undefined && { smooth: flag(smooth, "smooth") }),
    ...(x_title !== undefined && { x_title: axisTitle(x_title, "x_title") }),
    ...(y_title !== undefined && { y_title: axisTitle(y_title, "y_title") }),
    ...(gauge_max !== undefined && { gauge_max: gauge_max as number }),
    ...(series !== undefined && { series: seriesOf(series) }),
    ...(labels !== undefined && { labels: flag(labels, "labels") }),
    ...(format !== undefined && { format: checkNumberFormat(format, "format") }),
    ...(right_format !== undefined && { right_format: checkNumberFormat(right_format, "right_format") }),
  };
}

function rulesOf(v: unknown, column: string): ColorRule[] {
  if (!Array.isArray(v) || v.length > MAX_RULES) throw new Error(`rules of ${column} is a list of at most ${MAX_RULES} rules`);
  return v.map((r) => {
    const rule = object(r, `a rule of ${column}`);
    const op = oneOf(rule.op, OPS, "rule op");
    const value = rule.value;
    // text with >, <… is kept (the editor stores a half-typed number as text) and never matches
    if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new Error("rule value is a number or text");
    }
    return { op, value: value as number | string, tone: oneOf(rule.tone, TONES, "rule tone") };
  });
}

function scaleOf(v: unknown, column: string): { high: Tone; low?: Tone } {
  const s = object(v, `scale of ${column}`);
  return {
    high: oneOf(s.high, TONES, "scale high"),
    ...(s.low !== undefined && { low: oneOf(s.low, TONES, "scale low") }),
  };
}

function columnFormat(v: unknown, column: string): ColumnFormat {
  const f = object(v, `format of ${column}`);
  return {
    ...(f.number !== undefined && { number: checkNumberFormat(f.number, `number of ${column}`) }),
    ...(f.rules !== undefined && { rules: rulesOf(f.rules, column) }),
    ...(f.scale !== undefined && { scale: scaleOf(f.scale, column) }),
  };
}

/** The formats of a table's columns, by column name. */
export function checkColumnFormats(v: unknown): Record<string, ColumnFormat> {
  return Object.fromEntries(Object.entries(object(v, "formats")).map(([column, f]): [string, ColumnFormat] => [column, columnFormat(f, column)]));
}
