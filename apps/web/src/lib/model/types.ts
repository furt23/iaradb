/**
 * The semantic model of a dashboard: `dashboards/<slug>/model.py`, Python
 * syntax that is parsed and checked here, never run. Relationships between
 * datasets carry filters from the "one" side to the "many" side and let a
 * chart group by a related dataset's column; measures are expressions over
 * aggregations, each aggregation reading one dataset, possibly in a changed
 * filter context (`calculate`) or along the chart's x (time and windows).
 */

import type { NumberFormat } from "@/lib/dashboards/types";

/** where something is in the source: offsets for the editor, line and column (1-based) for messages */
export interface Span {
  from: number;
  to: number;
  line: number;
  col: number;
}

export interface Diagnostic extends Span {
  severity: "error" | "warning";
  message: string;
}

export interface ColumnRef {
  dataset: string;
  column: string;
}

/** `relate(many.column, one.column)`: each row of `many` points at one row of `one` */
export interface Relationship {
  many: ColumnRef;
  one: ColumnRef;
  span: Span;
  /** the many side is compared as a DATE (`CAST(col AS DATE)`): the relationships a calendar makes */
  cast?: "date";
}

/** The columns of a calendar, in this order. */
export const CALENDAR_COLUMNS = ["date", "year", "quarter", "month", "week", "month_of_year", "day_of_week"] as const;
export type CalendarColumn = (typeof CALENDAR_COLUMNS)[number];

/**
 * `dates = calendar(orders.o_orderdate, targets.t_date)`: a dataset the model
 * makes of the distinct dates of those columns, with CALENDAR_COLUMNS (`date`;
 * `year` and `month_of_year` (1–12) and `day_of_week` (1 = Monday) as integers;
 * `quarter`, `month` and `week` as the DATE they start on, the week on Monday),
 * related to each column (`cast: "date"` relationships in `Model.relationships`).
 */
export interface Calendar {
  name: string;
  columns: ColumnRef[];
  span: Span;
}

/** `param("discount", 0.1)`: a value a dashboard filter can set (`:discount` in the SQL), else its default */
export interface Param {
  name: string;
  default: number | string;
  span: Span;
}

/** The filter context of an aggregation, as `calculate` changes it. */
export interface AtomContext {
  /** conditions added on a dataset's rows: boolean SQL over its columns, quoted and unqualified */
  filters: { dataset: string; sql: string }[];
  /**
   * Dashboard filters, chart picks and chart grouping that no longer apply: a
   * whole dataset (with what is reached through it on its "one" side), or one
   * column of it. A filter added on a column removes that column too.
   */
  removed: { dataset: string; column?: string }[];
}

/**
 * Along the chart's x: `shift` is the value of an earlier period
 * (previous_year, previous_period; "grain": x's own grain), `to_date` the
 * total since the period began (ytd, qtd, mtd), `running` the total since the
 * first x, `rolling` the total of the last `n` x values or periods. All but
 * `running` read past the calendar's filters.
 */
export type AtomWindow =
  | { kind: "shift"; unit: "year" | "quarter" | "month" | "week" | "day" | "grain" }
  | { kind: "to_date"; period: "year" | "quarter" | "month" }
  | { kind: "running" }
  | { kind: "rolling"; n: number };

/** One aggregation over one dataset's rows (`SUM("valor")`, `COUNT(*)`), its columns quoted and unqualified. */
export interface Atom {
  dataset: string;
  sql: string;
  /** how a window accumulates it: sums and counts add up, min and max compare, a distinct count cannot (avg is sum / count) */
  agg: "sum" | "count" | "min" | "max" | "count_distinct";
  context?: AtomContext;
  window?: AtomWindow;
}

/**
 * SQL text with holes: `{ atom: i }` is `atoms[i]`'s value once computed,
 * `{ rank }` is the rank of that inner value among the chart's x values (1 =
 * highest), within each series.
 */
export type Template = (string | { atom: number } | { rank: Template })[];

export interface Measure {
  name: string;
  /** the datasets its atoms read, in first-use order */
  datasets: string[];
  atoms: Atom[];
  /** its value over the atoms' values (a plain aggregation is `[{ atom: 0 }]`) */
  expr: Template;
  format?: NumberFormat;
  label?: string;
  span: Span;
}

export interface Model {
  /** the relationships that checked, the calendars' included (the graph has no cycle and one path at most between two datasets) */
  relationships: Relationship[];
  /** the measures that checked, in file order (one with an error is left out, the rest stay) */
  measures: Measure[];
  calendars: Calendar[];
  params: Param[];
}

/** column names by dataset; null: not known, so any column name is accepted */
export type Schema = Record<string, string[] | null>;

export interface Checked {
  model: Model;
  diagnostics: Diagnostic[];
}
