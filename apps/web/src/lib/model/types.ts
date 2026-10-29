/**
 * The semantic model of a dashboard: `dashboards/<slug>/model.py`, Python
 * syntax that is parsed and checked here, never run. Relationships between
 * datasets carry filters from the "one" side to the "many" side and let a
 * chart group by a related dataset's column; measures are expressions over
 * aggregations, each aggregation reading one dataset.
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
}

/** One aggregation over one dataset's rows (`SUM("valor")`, `COUNT(*)`), its columns quoted and unqualified. */
export interface Atom {
  dataset: string;
  sql: string;
}

/** SQL text with holes for atoms: `{ atom: i }` is `atoms[i]`'s value once computed. */
export type Template = (string | { atom: number })[];

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
  /** the relationships that checked (the graph has no cycle and one path at most between two datasets) */
  relationships: Relationship[];
  /** the measures that checked, in file order (one with an error is left out, the rest stay) */
  measures: Measure[];
}

/** column names by dataset; null: not known, so any column name is accepted */
export type Schema = Record<string, string[] | null>;

export interface Checked {
  model: Model;
  diagnostics: Diagnostic[];
}
