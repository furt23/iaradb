/**
 * The semantic model of a dashboard: `dashboards/<slug>/model.py`, Python
 * syntax that is parsed and checked here, never run. Phase 1: relationships
 * between datasets (checked, not used yet) and measures over one dataset.
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

export interface Measure {
  name: string;
  /** the one dataset it aggregates */
  dataset: string;
  /** its value as one SELECT expression over the dataset's columns, quoted (`SUM("valor")`) */
  sql: string;
  format?: NumberFormat;
  label?: string;
  span: Span;
}

export interface Model {
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
