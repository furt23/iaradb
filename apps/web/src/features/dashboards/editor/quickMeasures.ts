/** The measures the Quick measure dialog writes for you (pure). */

import type { Calendar, ColumnRef } from "@/lib/model/types";

export type QuickKind =
  | "sum"
  | "avg"
  | "min"
  | "max"
  | "count"
  | "distinct"
  | "rows"
  | "percent"
  | "ytd"
  | "qtd"
  | "mtd"
  | "yoy"
  | "running"
  | "rank"
  | "rolling";

/** What a template asks for: a column (of a dataset), a dataset, a measure and what to total over, a measure, a measure and a size. */
export type QuickShape = "column" | "dataset" | "percent" | "measure" | "rolling";

export interface QuickTemplate {
  kind: QuickKind;
  /** English key for `t` */
  label: string;
  shape: QuickShape;
  /** needs a calendar in the model */
  time?: true;
}

export const QUICK_TEMPLATES: readonly QuickTemplate[] = [
  { kind: "sum", label: "Sum", shape: "column" },
  { kind: "avg", label: "Average", shape: "column" },
  { kind: "min", label: "Minimum", shape: "column" },
  { kind: "max", label: "Maximum", shape: "column" },
  { kind: "count", label: "Count", shape: "column" },
  { kind: "distinct", label: "Distinct count", shape: "column" },
  { kind: "rows", label: "Count rows", shape: "dataset" },
  { kind: "percent", label: "% of total", shape: "percent" },
  { kind: "ytd", label: "Year to date", shape: "measure", time: true },
  { kind: "qtd", label: "Quarter to date", shape: "measure", time: true },
  { kind: "mtd", label: "Month to date", shape: "measure", time: true },
  { kind: "yoy", label: "Change vs previous year (%)", shape: "measure", time: true },
  { kind: "running", label: "Running total", shape: "measure" },
  { kind: "rank", label: "Rank", shape: "measure" },
  { kind: "rolling", label: "Rolling total (last N)", shape: "rolling" },
];

export const templateOf = (kind: QuickKind): QuickTemplate => QUICK_TEMPLATES.find((t) => t.kind === kind)!;

/** What the fields of the dialog hold; each template reads the ones its shape names (an empty string: not picked). */
export interface QuickFields {
  /** `column`, `dataset`: the dataset read; `percent`: the dataset totalled over */
  dataset: string;
  /** `column`: the column read; `percent`: the column totalled over (empty: the whole dataset) */
  column: string;
  /** every shape but `column` and `dataset` */
  measure: string;
  /** `rolling` */
  n: number;
  /** the date column a calendar is made of, when a time template finds the model without one */
  date: ColumnRef;
}

/** What the dialog opens with: a template and the fields it reads (the rest start as they do without). */
export type QuickInitial = { kind: QuickKind } & Partial<Pick<QuickFields, "dataset" | "column" | "measure">>;

/** the model function a template calls (the others write their own expression) */
const FUNCTION: Partial<Record<QuickKind, string>> = {
  sum: "sum",
  avg: "avg",
  min: "min",
  max: "max",
  count: "count",
  distinct: "count_distinct",
  ytd: "ytd",
  qtd: "qtd",
  mtd: "mtd",
  running: "running_total",
  rank: "rank",
};

/** The expression of a template, null while a field it needs is missing. */
function expression(kind: QuickKind, f: QuickFields): string | null {
  const { shape } = templateOf(kind);
  const m = f.measure;
  switch (shape) {
    case "column":
      return f.dataset && f.column ? `${FUNCTION[kind]}(${f.dataset}.${f.column})` : null;
    case "dataset":
      return f.dataset ? `count_rows(${f.dataset})` : null;
    case "percent":
      return m && f.dataset ? `divide(${m}, calculate(${m}, all_(${f.column ? `${f.dataset}.${f.column}` : f.dataset})))` : null;
    case "rolling":
      return m && Number.isInteger(f.n) && f.n >= 1 ? `rolling(${m}, ${f.n})` : null;
    case "measure":
      if (!m) return null;
      return kind === "yoy" ? `divide(${m} - previous_year(${m}), previous_year(${m}))` : `${FUNCTION[kind]}(${m})`;
  }
}

/** `base`, or `base_2`, `base_3`… the first not in `taken`. */
export function freeName(base: string, taken: readonly string[]): string {
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}_${n}`;
  return name;
}

/** Part of a name: the characters an identifier allows. */
const part = (s: string) => s.replace(/\W+/g, "_").replace(/^_+|_+$/g, "");

const SUFFIX: Partial<Record<QuickKind, string>> = { percent: "pct_of_total", ytd: "ytd", qtd: "qtd", mtd: "mtd", yoy: "yoy", running: "running", rank: "rank" };

/** A name for the measure a template writes, free among `taken`. */
export function suggestName(kind: QuickKind, f: QuickFields, taken: readonly string[]): string {
  const { shape } = templateOf(kind);
  const base =
    shape === "column"
      ? `${kind}_${part(f.column)}`
      : shape === "dataset"
        ? `${part(f.dataset)}_rows`
        : shape === "rolling"
          ? `${part(f.measure)}_rolling_${f.n}`
          : `${part(f.measure)}_${SUFFIX[kind]}`;
  return freeName(base.replace(/^_+/, "").replace(/^(\d)/, "_$1") || "measure", taken);
}

export interface QuickMeasure {
  /** the measure's line: `name = expression` */
  text: string;
  /** what goes into the model, in order: a calendar when the model has none and the template needs one, then `text` */
  lines: string[];
}

/** The line a template writes for `name`; null while a field (or the name) is missing. `taken`: names the model already uses. */
export function quickMeasure(kind: QuickKind, f: QuickFields, name: string, calendars: readonly Calendar[], taken: readonly string[]): QuickMeasure | null {
  const body = expression(kind, f);
  if (body === null || !name.trim()) return null;
  const text = `${name.trim()} = ${body}`;
  if (!templateOf(kind).time || calendars.length) return { text, lines: [text] };
  if (!f.date.dataset || !f.date.column) return null;
  return { text, lines: [`${freeName("dates", [...taken, name.trim()])} = calendar(${f.date.dataset}.${f.date.column})`, text] };
}
