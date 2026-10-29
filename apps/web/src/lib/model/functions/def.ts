/**
 * What a model function is, and the helpers every function family shares.
 * A function is one object: its docs for the editor, how it checks its
 * arguments, what level its result has and the SQL it renders.
 */

import type { Call, Expr } from "../ast";
import type { Parts } from "../parts";
import type { Calendar, ColumnRef, Param, Relationship, Span } from "../types";
import type { NumberFormat } from "@/lib/dashboards/types";

/** `a`, `a and b`, `a, b and c` */
export function list(items: readonly string[]): string {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * How many rows a value has: a literal is one value (`scalar`), a column is one
 * per row (`row`), an aggregation collapses the rows into one (`aggregate`).
 */
export type Level = "scalar" | "row" | "aggregate";

/** A checked expression: its level and the SQL it renders to. */
export interface Typed {
  level: Level;
  /** its SQL; an aggregate has its aggregations in it as atoms (see `Parts`), the other levels are text only */
  sql: Parts;
  /** datasets it reads, in order of appearance (a referenced measure counts its own) */
  datasets: string[];
  /** a row-level value: its first column used outside an aggregation, for the error that asks to wrap it */
  bare?: { text: string; span: Span };
  /** a text value (a string literal, or a constant made of one): arithmetic on it is an error */
  text?: boolean;
  /** only `measure(...)` sets these */
  format?: NumberFormat;
  label?: string;
}

/** Stops the statement being checked; `checkModel` turns it into a diagnostic. */
export class ModelError extends Error {
  constructor(
    readonly span: Span,
    message: string,
  ) {
    super(message);
  }
}

export function fail(at: { span: Span }, message: string): never {
  throw new ModelError(at.span, message);
}

/** What the checker offers to a function while it checks a call. */
export interface FnCx {
  /** checks a sub-expression */
  expr(node: Expr): Typed;
  /** `dataset.column`, checked against the schema */
  column(node: Expr): ColumnRef;
  /** a bare dataset name, e.g. the argument of `count_rows` */
  dataset(node: Expr): string;
  readonly relationships: readonly Relationship[];
  /** the model's calendars (their datasets are in the schema already) */
  readonly calendars: readonly Calendar[];
  /** the params declared so far; `param(...)` adds its own */
  readonly params: Param[];
  /** the name of the line this call is the whole value of (`rate = param("rate", 0.1)`), else unset */
  readonly assigned?: string;
}

/** What a `name = calendar(...)` line makes: the calendar and the relationships that tie it to its columns. */
export interface Declared {
  calendar: Calendar;
  relationships: Relationship[];
}

interface Base {
  name: string;
  signature: string;
  doc: string;
}

export type FnDef = Base &
  (
    | {
        /** usable inside any expression; `assignment`: only as the whole value of `name = ...` */
        kind: "expr" | "assignment";
        check(call: Call, cx: FnCx): Typed;
      }
    | {
        /** a line of its own */
        kind: "statement";
        check(call: Call, cx: FnCx): Relationship;
      }
    | {
        /** the whole value of `name = ...`, which makes `name` a dataset */
        kind: "declaration";
        check(call: Call, cx: FnCx, name: string): Declared;
      }
  );

export interface Params {
  /** every argument name, in positional order */
  params: readonly string[];
  /** how many of them must be given */
  required: number;
  /** how many may be given without a name (the rest only by name) */
  positional: number;
}

/** Python-style binding of a call's arguments to parameter names, with plain errors. */
export function bind(call: Call, p: Params): Record<string, Expr> {
  const f = call.func;
  const out: Record<string, Expr> = {};
  if (call.args.length > p.positional) {
    const byName = p.params.length > p.positional ? `; pass ${p.params.slice(p.positional).join(", ")} by name` : "";
    fail(call.args[p.positional], `${f}() takes ${p.positional} argument${p.positional === 1 ? "" : "s"}${byName}, got ${call.args.length}`);
  }
  call.args.forEach((a, i) => (out[p.params[i]] = a));
  for (const k of call.kwargs) {
    if (!p.params.includes(k.name)) fail(k, `${f}() has no argument named ${k.name}`);
    if (Object.hasOwn(out, k.name)) fail(k, `${f}() got ${k.name} twice`);
    out[k.name] = k.value;
  }
  const missing = p.params.slice(0, p.required).filter((n) => !Object.hasOwn(out, n));
  if (missing.length) fail(call, `${f}() is missing ${missing.map((n) => `\`${n}\``).join(", ")}`);
  return out;
}

/** For functions that take any number of values: only the keyword arguments in `named` are allowed, and they come back by name. */
export function variadic(call: Call, named: readonly string[] = []): Record<string, Expr> {
  for (const k of call.kwargs) if (!named.includes(k.name)) fail(k, `${call.func}() has no argument named ${k.name}`);
  return Object.fromEntries(call.kwargs.map((k) => [k.name, k.value]));
}

/** The measure a function reworks (calculate, windows, rank) must be an aggregation or a measure: not a column, not a fixed value. */
export function needAggregate(fn: string, node: Expr, t: Typed): void {
  if (t.level === "row") {
    const text = t.bare?.text ?? "the column";
    fail(t.bare ?? node, `\`${text}\` must be inside an aggregation, e.g. sum(${text})`);
  }
  if (t.level === "scalar") fail(node, `${fn}() needs a measure or an aggregation like sum(orders.total), not a fixed value`);
}

/** Arithmetic on text is always a mistake, so it is refused where the text is. */
export function noText(node: Expr, t: Typed): void {
  if (t.text) fail(node, "this is text: arithmetic needs numbers");
}

/**
 * The level of an expression made of `parts`: the highest of theirs. A column
 * per row next to an aggregation cannot be combined, and the error names the
 * first such column.
 */
export function merge(parts: readonly { node: Expr; typed: Typed }[]): Pick<Typed, "level" | "datasets" | "bare"> {
  const row = parts.find((p) => p.typed.level === "row");
  const aggregate = parts.some((p) => p.typed.level === "aggregate");
  if (row && aggregate) {
    const text = row.typed.bare?.text ?? "the column";
    fail(row.typed.bare ?? row.node, `\`${text}\` must be inside an aggregation, e.g. sum(${text})`);
  }
  return {
    level: aggregate ? "aggregate" : row ? "row" : "scalar",
    datasets: [...new Set(parts.flatMap((p) => p.typed.datasets))],
    bare: row?.typed.bare,
  };
}
