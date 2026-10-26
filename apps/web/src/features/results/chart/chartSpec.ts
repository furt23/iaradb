/** Chart specs over result columns, and the kernel's points shaped into series (pure). */

import type { CellValue, ChartData, ChartSpec, ColumnInfo } from "@iara/protocol";

import type { PickValue } from "@/lib/dashboards/types";
import { isNumericType } from "@/lib/format";

export function isTemporalType(type: string): boolean {
  return /^(date|timestamp|time)/i.test(type);
}

/** A first chart for a result: a category (or time) on x, the first numeric column summed. */
export function defaultSpec(columns: ColumnInfo[]): ChartSpec | null {
  if (!columns.length) return null;
  const numeric = columns.filter((c) => isNumericType(c.type));
  const x = columns.find((c) => !isNumericType(c.type)) ?? columns[0];
  const y = numeric.find((c) => c.name !== x.name);
  return {
    kind: isTemporalType(x.type) ? "line" : "bar",
    x: x.name,
    y: y ? [y.name] : [],
    agg: y ? "sum" : "count",
    group: null,
  };
}

/** The spec without columns the result no longer has (its query changed). */
export function fitSpec(spec: ChartSpec, columns: ColumnInfo[]): ChartSpec {
  const names = new Set(columns.map((c) => c.name));
  return {
    ...spec,
    x: spec.kind === "counter" || names.has(spec.x) ? spec.x : (columns[0]?.name ?? ""),
    y: spec.y.filter((y) => names.has(y)),
    group: spec.group && names.has(spec.group) ? spec.group : null,
  };
}

/** Why the spec cannot be drawn yet, or null. */
export function specProblem(spec: ChartSpec, columns: ColumnInfo[]): string | null {
  const type = (name: string) => columns.find((c) => c.name === name)?.type;
  if (spec.kind === "counter") {
    if (spec.agg === "none") return "A counter needs an aggregation.";
    if (spec.agg === "count") return null;
    if (spec.y.length !== 1) return "Pick a value column.";
    return isNumericType(type(spec.y[0]) ?? "") ? null : "Values must be numeric to be summed or averaged.";
  }
  if (!type(spec.x)) return "Pick a column for the x axis.";
  if (spec.kind === "histogram") return isNumericType(type(spec.x)!) ? null : "A histogram needs a numeric column.";
  const counting = spec.agg === "count";
  if (!counting && !spec.y.length) return "Pick a value column.";
  if (!counting && spec.agg !== "none" && spec.y.some((y) => !isNumericType(type(y) ?? ""))) return "Values must be numeric to be summed or averaged.";
  if (spec.kind === "scatter" && !isNumericType(type(spec.x)!)) return "A scatter plot needs a numeric x.";
  return null;
}

export interface Series {
  label: string;
  data: (number | null)[];
}

export interface Categorical {
  /** x values, in the kernel's order */
  categories: (string | number)[];
  /** each category's x value as the kernel sent it (a null shows as "(null)" in `categories`) */
  raw: CellValue[];
  series: Series[];
}

export interface Point {
  x: number;
  y: number;
  id: number;
}

function num(v: CellValue | undefined): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function key(v: CellValue | undefined): string | number {
  return typeof v === "number" ? v : v === null || v === undefined ? "(null)" : String(v);
}

/** Bars, pies, lines and areas: one series per value column, or per group value. */
export function toCategorical(data: ChartData, spec: ChartSpec): Categorical {
  if (spec.kind === "histogram") {
    const start = data.columns.indexOf("bin_start");
    const end = data.columns.indexOf("bin_end");
    const count = data.columns.indexOf("count");
    const g = spec.group ? data.columns.indexOf(spec.group) : -1;
    const label = (r: CellValue[]) => `${fmt(num(r[start]))}–${fmt(num(r[end]))}`;
    return pivot(data.rows, label, g, [count], ["count"]);
  }
  const x = data.columns.indexOf(spec.x);
  const g = spec.group ? data.columns.indexOf(spec.group) : -1;
  const values = data.columns.map((c, i) => i).filter((i) => i !== x && i !== g);
  return pivot(data.rows, (r) => key(r[x]), g, values, values.map((i) => data.columns[i]), (r) => r[x]);
}

/** What a click on category `i` picks: its x value, or undefined when there is no such category or it is not a plain value (a list or struct has nothing to compare). */
export function pickOf(c: Categorical, i: number | null | undefined): PickValue | undefined {
  const v = i == null ? undefined : c.raw[i];
  return v === undefined || (typeof v === "object" && v !== null) ? undefined : v;
}

function pivot(
  rows: CellValue[][],
  xOf: (r: CellValue[]) => string | number,
  group: number,
  values: number[],
  names: string[],
  rawOf: (r: CellValue[]) => CellValue = xOf,
): Categorical {
  const categories: (string | number)[] = [];
  const raw: CellValue[] = [];
  const index = new Map<string | number, number>();
  for (const r of rows) {
    const k = xOf(r);
    if (!index.has(k)) {
      index.set(k, categories.length);
      categories.push(k);
      raw.push(rawOf(r));
    }
  }
  const series = new Map<string, Series>();
  const at = (label: string) => {
    let s = series.get(label);
    if (!s) series.set(label, (s = { label, data: categories.map(() => null) }));
    return s;
  };
  for (const r of rows) {
    const i = index.get(xOf(r))!;
    values.forEach((v, j) => {
      const label = group >= 0 ? (values.length > 1 ? `${key(r[group])} · ${names[j]}` : String(key(r[group]))) : names[j];
      at(label).data[i] = num(r[v]);
    });
  }
  return { categories, raw, series: [...series.values()] };
}

/** Scatter plots: one series of points per value column, or per group value. */
export function toPoints(data: ChartData, spec: ChartSpec): { label: string; data: Point[] }[] {
  const x = data.columns.indexOf(spec.x);
  const g = spec.group ? data.columns.indexOf(spec.group) : -1;
  const out = new Map<string, Point[]>();
  data.rows.forEach((r, id) => {
    const px = num(r[x]);
    for (const y of spec.y) {
      const py = num(r[data.columns.indexOf(y)]);
      if (px === null || py === null) continue;
      const label = g >= 0 ? String(key(r[g])) : y;
      if (!out.has(label)) out.set(label, []);
      out.get(label)!.push({ x: px, y: py, id });
    }
  });
  return [...out].map(([label, points]) => ({ label, data: points }));
}

function fmt(n: number | null): string {
  if (n === null) return "?";
  return Math.abs(n) >= 1000 || Number.isInteger(n) ? Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(n) : n.toPrecision(3);
}
