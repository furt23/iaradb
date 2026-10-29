/**
 * The read-only SQL a dashboard widget runs (pure). A dataset is wrapped as a
 * subquery, so the engine refuses anything but a query; field filters narrow
 * it with `WHERE` conditions whose values travel as parameters, never in the
 * text.
 */

import type { ChartSpec, QueryParams } from "@iara/protocol";

import { coerce, detectParams, mergeSpecs, resolveParams, type ParamRaw } from "@/features/queries/queryParams";
import { splitStatements } from "@/lib/sqlStatements";

import type { CrossPicks, Dataset, FilterValue, FilterValues, FilterWidget, PickValue, Widget } from "./types";

export const DATASET_NAME = /^[a-z0-9_]{1,64}$/;
/** the most values a multi-select filter sends, and options a filter lists */
export const MAX_LIST = 500;
/** the most chart picks one render takes, and the longest text a pick holds */
export const MAX_PICKS = 10;
const MAX_PICK_TEXT = 1000;

type ParamValue = NonNullable<QueryParams["params"]>[string];
type ParamType = NonNullable<QueryParams["param_types"]>[string];
export type DatasetQuery = { query: string; params: QueryParams } | { missing: string[] };

/** `"name"`, with the quotes inside it doubled. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** The one statement of a dataset, without its trailing `;` (throws when there are none or several). */
export function datasetStatement(sql: string): string {
  const statements = splitStatements(sql);
  if (statements.length !== 1) throw new Error("a dataset holds one query");
  return statements[0];
}

/**
 * A dataset as a subquery. The statement goes on lines of its own: a trailing
 * `-- comment` would otherwise swallow the closing parenthesis.
 */
function source(sql: string): string {
  return `(\n${datasetStatement(sql)}\n) AS _d`;
}

/** The placeholders of a dataset, resolved for the values the viewer gave (the names of the filters' and picks' parameters are reserved). */
function datasetParams(dataset: Dataset, paramValues: Record<string, ParamRaw>): { query: QueryParams; missing: string[] } {
  const names = detectParams(dataset.sql);
  if (names.some((n) => /^_[fc]\d/.test(n))) throw new Error("placeholder names starting with _f or _c and a digit are reserved");
  return resolveParams(mergeSpecs(names, dataset.params), paramValues);
}

/** What a field filter's values are typed as. */
function typeOf(f: FilterWidget): "text" | "number" | "date" {
  return f.control === "date_range" ? "date" : f.control === "text" ? "text" : (f.value_type ?? "text");
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** Why `value` cannot be a filter's value (null: it can). Values come from the viewer's browser: nothing is assumed. */
export function filterValueProblem(filter: FilterWidget, value: FilterValue): string | null {
  const v: unknown = value;
  if (filter.param) return isScalar(v) ? null : "a single value";
  const type = typeOf(filter);
  switch (filter.control) {
    case "select":
      return isScalar(v) && (v === "" || coerce({ type }, v) !== undefined) ? null : `a ${type}`;
    case "multi":
      if (!Array.isArray(v) || v.length > MAX_LIST) return `a list of at most ${MAX_LIST} values`;
      return v.every((x) => typeof x === "string" && coerce({ type }, x) !== undefined) ? null : `a list of ${type} values`;
    case "date_range": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return "a range of dates";
      const { from, to } = v as { from?: unknown; to?: unknown };
      const ok = (d: unknown) => d === undefined || d === "" || (typeof d === "string" && coerce({ type: "date" }, d) !== undefined);
      return ok(from) && ok(to) ? null : "a range of dates (YYYY-MM-DD)";
    }
    default:
      return typeof v === "string" ? null : "text";
  }
}

/** The values of the filters that fill a placeholder, by placeholder name (an empty value leaves the placeholder's default). */
export function paramValuesOf(filters: FilterWidget[], values: FilterValues): Record<string, ParamRaw> {
  const out: Record<string, ParamRaw> = {};
  for (const f of filters) {
    const v = values[f.id];
    if (f.param && isScalar(v) && v !== "") out[f.param] = typeof v === "boolean" ? v : String(v);
  }
  return out;
}

/** Binds a value to a parameter (typed as its filter) and gives its placeholder. */
type Bind = (name: string, raw: string | number | boolean) => string;

/** The `WHERE` conditions of a field filter on a column (none: it holds no value, so it narrows nothing). */
function conditions(f: FilterWidget, i: number, column: string, value: FilterValue, bind: Bind): string[] {
  const c = quoteIdent(column);
  switch (f.control) {
    case "select":
      return value === "" ? [] : [`${c} = ${bind(`_f${i}`, value as string)}`];
    case "multi": {
      const list = value as string[];
      return list.length ? [`${c} IN (${list.map((x, j) => bind(`_f${i}_${j}`, x)).join(", ")})`] : [];
    }
    case "date_range": {
      const { from, to } = value as { from?: string; to?: string };
      // CAST: a timestamp compared with a date would leave out the last day
      return [from && `CAST(${c} AS DATE) >= ${bind(`_f${i}_from`, from)}`, to && `CAST(${c} AS DATE) <= ${bind(`_f${i}_to`, to)}`].filter((x): x is string => !!x);
    }
    default:
      // strpos, not LIKE: `%` and `_` in what is typed are plain characters
      return value === "" ? [] : [`strpos(lower(CAST(${c} AS VARCHAR)), lower(${bind(`_f${i}`, value as string)})) > 0`];
  }
}

/** Whether a chart can cross-filter: it has categories to click (a histogram's bins, a scatter's points and a counter's number are not). */
export function canPick(spec: ChartSpec): boolean {
  return spec.kind === "bar" || spec.kind === "line" || spec.kind === "area" || spec.kind === "pie";
}

/** The ids of the chart widgets that can cross-filter. */
export function pickableIds(widgets: Widget[]): Set<string> {
  return new Set(widgets.flatMap((w) => (w.kind === "chart" && canPick(w.spec) ? [w.id] : [])));
}

/** Throws unless every pick names a different chart of the dashboard that can cross-filter, with a plain value (picks come from a browser). */
export function checkPicks(widgets: Widget[], cross: CrossPicks): void {
  if (!Array.isArray(cross) || cross.length > MAX_PICKS) throw new Error(`at most ${MAX_PICKS} chart picks`);
  const pickable = pickableIds(widgets);
  const seen = new Set<string>();
  for (const p of cross) {
    const id: unknown = p?.widget;
    if (typeof id !== "string" || !pickable.has(id)) throw new Error(`${String(id)} is not a chart of this dashboard that can filter`);
    if (seen.has(id)) throw new Error(`${id} is picked twice`);
    seen.add(id);
    const v: unknown = p.value;
    const plain = v === null || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v)) || (typeof v === "string" && v.length <= MAX_PICK_TEXT);
    if (!plain) throw new Error(`the pick of ${id} is not a value of a column`);
  }
}

const CLOCK = /^((?:\d{4}-\d\d-\d\d[T ])?\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)?$/;

/**
 * What `CAST(column AS VARCHAR)` can read as for a text the kernel sent: the
 * text itself and, for a timestamp or time, the engine's spelling of it (the
 * kernel sends Python's `isoformat`: a fraction of 6 digits where the engine
 * prints 3, 6 or 9, and +00:00 where it prints Z).
 */
function spellings(text: string): string[] {
  const m = CLOCK.exec(text);
  if (!m) return [text];
  const [, head, fraction = "", zone = ""] = m;
  const nine = fraction.padEnd(9, "0");
  const digits = /^0+$/.test(nine) ? "" : nine.endsWith("000000") ? nine.slice(0, 3) : nine.endsWith("000") ? nine.slice(0, 6) : nine;
  const zones = zone === "+00:00" ? [zone, "Z"] : [zone];
  return [...new Set([text, ...zones.map((z) => `${head}${digits && `.${digits}`}${z}`)])];
}

/** A chart's pick as a condition on a column; `id` names its parameters (absent: its position among the picks). */
export interface PickBy {
  column: string;
  value: PickValue;
  id?: number;
}

/**
 * A dataset narrowed by the rows of another (a dimension's, reached by a relationship): `column IN (SELECT key FROM (query) AS alias)`.
 * `cast: "date"`: the column is compared as a DATE (a timestamp is not a calendar's date).
 */
export interface Semi {
  column: string;
  key: string;
  cast?: "date";
  query: { query: string; params: QueryParams };
  alias: string;
}

/** The parameters of two queries in one. Throws when a name is bound to two values or types: the placeholders of one query share their names. */
export function mergeParams(a: QueryParams, b: QueryParams): QueryParams {
  const params: Record<string, ParamValue> = { ...a.params };
  const param_types: Record<string, ParamType> = { ...a.param_types };
  for (const [name, v] of Object.entries(b.params ?? {})) {
    const type = b.param_types?.[name];
    if (Object.hasOwn(params, name) && (params[name] !== v || param_types[name] !== type)) throw new Error(`:${name} is bound to two different values in one query`);
    params[name] = v;
    if (type) param_types[name] = type;
  }
  return Object.keys(params).length ? { params, param_types } : {};
}

/**
 * The `WHERE` conditions the filters (by their position in `filters`, so a
 * filter's parameters have the same names on every dataset) and the picks put on
 * a dataset's columns; their values are bound in `params`.
 */
function conditionsOf(
  dataset: string,
  filters: FilterWidget[],
  values: FilterValues,
  picks: PickBy[],
  params: Record<string, ParamValue>,
  param_types: Record<string, ParamType>,
): string[] {
  const where: string[] = [];
  filters.forEach((f, i) => {
    const columns = (f.fields ?? []).filter((x) => x.dataset === dataset).map((x) => x.column);
    const value = values[f.id];
    if (!columns.length || value === undefined) return;
    const problem = filterValueProblem(f, value);
    if (problem) throw new Error(`${f.title ?? "a filter"}: expected ${problem}`);
    const bind: Bind = (name, raw) => {
      params[name] = coerce({ type: typeOf(f) }, raw) as ParamValue;
      param_types[name] = typeOf(f);
      return `:${name}`;
    };
    for (const column of columns) where.push(...conditions(f, i, column, value, bind));
  });
  picks.forEach(({ column, value, id }, n) => {
    const c = quoteIdent(column);
    const k = id ?? n;
    const bind = (name: string, v: string | number | boolean, type: ParamType) => {
      params[name] = v;
      param_types[name] = type;
      return `:${name}`;
    };
    if (value === null) where.push(`${c} IS NULL`);
    // text, date, timestamp and decimal x values reach the browser as text (kernel `json_value`): they match as the column's text
    else if (typeof value === "string") {
      const names = spellings(value).map((s, j) => bind(j ? `_c${k}_${j}` : `_c${k}`, s, "text"));
      where.push(`CAST(${c} AS VARCHAR) ${names.length > 1 ? `IN (${names.join(", ")})` : `= ${names[0]}`}`);
    } else where.push(`${c} = ${bind(`_c${k}`, value, typeof value === "number" ? "number" : "boolean")}`);
  });
  return where;
}

/** Whether the filters' values and the picks put any condition on the dataset's own columns. */
export function narrows(dataset: string, filters: FilterWidget[], values: FilterValues, picks: PickBy[]): boolean {
  return conditionsOf(dataset, filters, values, picks, {}, {}).length > 0;
}

/**
 * The rows of a dataset as they are read: its statement and its placeholders
 * from `paramValues` (or their defaults); `missing`: placeholders without a value.
 * A calendar's rows have the same form (narrow.ts), so narrowing and filter
 * options work on both.
 */
export function datasetRows(dataset: Dataset, paramValues: Record<string, ParamRaw>): DatasetQuery {
  const own = datasetParams(dataset, paramValues);
  return own.missing.length ? { missing: own.missing } : { query: dataset.sql, params: own.query };
}

/**
 * `rows` (named `name`) narrowed: the field filters that include it as
 * conditions, the `picks` (a column and the value a chart's category holds) as
 * conditions too, and the `semis` that narrow it through a relationship, whose
 * parameters join its own. A filter's parameters are named by its position in
 * `filters` (`_f2`, `_f2_from`), a pick's by its `id` (`_c1`, `_c1_1`), so one
 * name is one value in every dataset of a query. Throws when `rows` is not one
 * statement or a filter value is not valid for its filter.
 */
export function rowsQuery(
  name: string,
  rows: { query: string; params: QueryParams },
  filters: FilterWidget[],
  values: FilterValues,
  picks: PickBy[] = [],
  semis: Semi[] = [],
): { query: string; params: QueryParams } {
  const params: Record<string, ParamValue> = { ...rows.params.params };
  const param_types: Record<string, ParamType> = { ...rows.params.param_types };
  const where = conditionsOf(name, filters, values, picks, params, param_types);
  let merged: QueryParams = Object.keys(params).length ? { params, param_types } : {};
  for (const s of semis) {
    const c = quoteIdent(s.column);
    where.push(`${s.cast === "date" ? `CAST(${c} AS DATE)` : c} IN (SELECT ${quoteIdent(s.key)} FROM (\n${s.query.query}\n) AS ${s.alias})`);
    merged = mergeParams(merged, s.query.params);
  }
  const query = `SELECT * FROM ${source(rows.query)}${where.length ? `\nWHERE ${where.join("\n  AND ")}` : ""}`;
  return { query, params: merged };
}

/**
 * The query of a dataset for the viewer's values: its own placeholders from
 * `paramValues` (or their defaults), narrowed as `rowsQuery` does. `missing`:
 * placeholders without a value.
 */
export function datasetQuery(
  dataset: Dataset,
  filters: FilterWidget[],
  values: FilterValues,
  paramValues: Record<string, ParamRaw>,
  picks: PickBy[] = [],
  semis: Semi[] = [],
): DatasetQuery {
  const rows = datasetRows(dataset, paramValues);
  return "missing" in rows ? rows : rowsQuery(dataset.name, rows, filters, values, picks, semis);
}

/** The distinct values of a column of some rows (what a filter offers). */
export function optionsQuery(rows: DatasetQuery, column: string): DatasetQuery {
  if ("missing" in rows) return rows;
  const c = quoteIdent(column);
  return { query: `SELECT DISTINCT ${c} AS value FROM ${source(rows.query)} WHERE ${c} IS NOT NULL ORDER BY 1 LIMIT ${MAX_LIST}`, params: rows.params };
}
