import "server-only";

import type { KernelMethod, ParamsOf, ResultOf } from "@iara/protocol";

import type { ParamSpec } from "@/features/queries/queryHeader";
import { coerce, detectParams, mergeSpecs, shown, type ParamRaw } from "@/features/queries/queryParams";
import { freshEntry, uncovered, wantsExtract, type ExtractManifest } from "@/lib/dashboards/extracts";
import { checkPicks, datasetQuery, filterValueProblem, MAX_LIST, optionsQuery, paramValuesOf, type DatasetQuery } from "@/lib/dashboards/query";
import type { ChartWidget, CrossPick, CrossPicks, Dataset, FilterValues, FilterWidget, RenderResult, TableWidget, Widget, WidgetData } from "@/lib/dashboards/types";

import { datasetHash } from "./extractStore";

/** Rows a table widget shows. */
const TABLE_ROWS = 100;
/** What a viewer reads in place of a widget's error. */
export const HIDDEN_ERROR = "This tile could not be loaded.";

/** What the serving kernel answers: reads of extracts. */
type ServeMethod = "sql.run" | "result.page" | "result.chart";

export interface RunDeps {
  /** the dashboard's kernel */
  request: <M extends KernelMethod>(method: M, params: ParamsOf<M>) => Promise<ResultOf<M>>;
  /** errors say nothing about the data or the queries (viewers); the real message goes to the server log */
  redact: boolean;
  /** the query history's note for the queries run */
  source: string;
  /** the tables the queries may read (`*`, `c`, `c.s` or `c.s.t`); null or absent: unchecked */
  allow?: string[] | null;
  /** the dashboard's extracts (absent: every dataset runs live) */
  extracts?: {
    manifest: ExtractManifest | null;
    /** the serving kernel: it refuses an `allow`, so the viewer's grants are checked against the manifest's sources instead */
    serve: <M extends ServeMethod>(method: M, params: ParamsOf<M>) => Promise<ResultOf<M>>;
    url(dataset: string, version: string): string;
  };
}

/** Where a dataset runs in a render: on the serving kernel, reading its extract (`serve`), or live on the dashboard's kernel. */
interface Route {
  dataset: Dataset;
  serve?: NonNullable<RunDeps["extracts"]>["serve"];
}

/** The `allow` a kernel request carries: none when unchecked, since the kernel checks only what it is sent. */
export function allowParam(allow: string[] | null | undefined): { allow?: string[] } {
  return allow == null ? {} : { allow };
}

/** The dataset with the SQL its recipe compiles to on the kernel (a SQL dataset, or a compiled one, comes back as it is). */
export async function withSql(dataset: Dataset, request: RunDeps["request"]): Promise<Dataset> {
  if (!dataset.recipe || dataset.sql) return dataset;
  const { sql } = await request("wrangle.sql", { source: dataset.recipe.source, steps: dataset.recipe.steps });
  return { ...dataset, sql };
}

/** A value of the placeholder's type that the kernel takes: the check is of the query's shape, not its rows. */
function neutral(spec: ParamSpec): ParamRaw {
  switch (spec.type) {
    case "number":
      return "0";
    case "date":
      return "2000-01-01";
    case "boolean":
      return false;
    case "select":
      return spec.options?.[0] ?? "x";
    default:
      return "x";
  }
}

/**
 * Why datasets cannot run on the kernel, from `sql.explain` (nothing runs), for
 * the `allow` given. A placeholder with no usable default gets a neutral value.
 * Empty: all can run.
 */
export async function explainDatasets(datasets: Dataset[], deps: Pick<RunDeps, "request" | "allow">): Promise<string[]> {
  const problems: string[] = [];
  for (const d of datasets) {
    try {
      const dataset = await withSql(d, deps.request);
      const specs = mergeSpecs(detectParams(dataset.sql), dataset.params);
      const values: Record<string, ParamRaw> = {};
      for (const [name, spec] of Object.entries(specs)) if (coerce(spec, shown(spec, undefined)) === undefined) values[name] = neutral(spec);
      const q = datasetQuery(dataset, [], {}, values);
      if ("missing" in q) throw new Error(`needs a value for ${q.missing.map((n) => `:${n}`).join(", ")}`);
      await deps.request("sql.explain", { query: q.query, ...q.params, ...allowParam(deps.allow) });
    } catch (e) {
      problems.push(`dataset ${d.name}: ${(e as Error).message}`);
    }
  }
  return problems;
}

/** The filter widgets whose value is not valid, or not a filter's (throws: values come from a browser). */
function checkValues(widgets: Widget[], values: FilterValues): void {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("the filter values are an object");
  const filters = new Map(widgets.flatMap((w) => (w.kind === "filter" ? [[w.id, w] as const] : [])));
  for (const [id, value] of Object.entries(values)) {
    const filter = filters.get(id);
    if (!filter) throw new Error(`${id} is not a filter of this dashboard`);
    const problem = filterValueProblem(filter, value);
    if (problem) throw new Error(`${filter.title ?? "a filter"}: expected ${problem}`);
  }
}

/** The first rows of a result, as a table widget shows them. */
function tableData(widget: TableWidget, columns: { name: string; type: string }[], page: ResultOf<"result.page">): WidgetData {
  if (!widget.columns?.length) return { kind: "table", columns, rows: page.rows, total: page.total };
  const at = widget.columns.map((name) => {
    const i = columns.findIndex((c) => c.name === name);
    if (i < 0) throw new Error(`the dataset has no column ${name}`);
    return i;
  });
  return { kind: "table", columns: at.map((i) => columns[i]), rows: page.rows.map((r) => at.map((i) => r[i])), total: page.total };
}

/**
 * The data of the chart, table and filter widgets of a dashboard, for the
 * filter values (by filter id) and the chart picks (`cross`) given. A chart or
 * table is narrowed by the picks of the other charts on its dataset, so the
 * widgets that share their picks share one run of the dataset. Queries run one
 * after another, on the dashboard's kernel (or the serving kernel, for a dataset
 * with a fresh extract); one that fails fails its widgets only.
 */
export async function renderDashboard(input: { datasets: Dataset[]; widgets: Widget[] }, values: FilterValues, deps: RunDeps, cross: CrossPicks = []): Promise<RenderResult> {
  checkValues(input.widgets, values);
  checkPicks(input.widgets, cross);
  const filters = input.widgets.filter((w): w is FilterWidget => w.kind === "filter");
  const paramValues = paramValuesOf(filters, values);
  const out: Record<string, WidgetData> = {};

  const fail = (id: string, e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    if (deps.redact) console.error(`dashboard widget ${id}: ${message}`);
    out[id] = { kind: "error", message: deps.redact ? HIDDEN_ERROR : message };
  };

  /** A request on the kernel the route names. */
  const call = <M extends ServeMethod>(r: Route, method: M, params: ParamsOf<M>): Promise<ResultOf<M>> => (r.serve ? r.serve(method, params) : deps.request(method, params));

  /** Runs a query; its result's id and columns. */
  async function run(r: Route, q: DatasetQuery) {
    if ("missing" in q) throw new Error(`needs a value for ${q.missing.map((n) => `:${n}`).join(", ")}`);
    const output = await call(r, "sql.run", { query: q.query, source: deps.source, ...q.params, ...(r.serve ? {} : allowParam(deps.allow)) });
    if (output.type === "error") throw new Error(`${output.ename}: ${output.evalue}`);
    if (output.type !== "table") throw new Error("the dataset did not return a table");
    return output.result;
  }

  /** A dataset with a fresh extract is read from it (its SQL is the read: nothing to compile); any other runs live. */
  async function resolve(d: Dataset): Promise<Route> {
    const { extracts } = deps;
    const entry = extracts && wantsExtract(d) ? freshEntry(extracts.manifest, d.name, datasetHash(d)) : null;
    if (!extracts || !entry) return { dataset: await withSql(d, deps.request) };
    const lost = uncovered(entry, deps.allow);
    if (lost) throw new Error(`no read grant on table ${lost}`);
    const url = extracts.url(d.name, entry.version).replaceAll("'", "''");
    return { dataset: { name: d.name, sql: `SELECT * FROM read_parquet('${url}')`, params: {} }, serve: extracts.serve };
  }

  // a dataset is routed (and a recipe compiled) at most once per render, by whichever widget or filter needs it first
  const routes = new Map<string, Promise<Route>>();
  async function route(name: string): Promise<Route> {
    const d = input.datasets.find((x) => x.name === name);
    if (!d) throw new Error(`there is no dataset ${name}`);
    if (!routes.has(name)) routes.set(name, resolve(d));
    return routes.get(name)!;
  }

  // chart and table widgets by dataset and the picks that narrow them (a chart's own never does), in the order they first appear
  const charts = new Map(input.widgets.flatMap((w) => (w.kind === "chart" ? [[w.id, w] as const] : [])));
  const groups = new Map<string, { name: string; picks: CrossPick[]; widgets: (ChartWidget | TableWidget)[] }>();
  for (const w of input.widgets) {
    if (w.kind !== "chart" && w.kind !== "table") continue;
    // sorted, so the parameters of the same picks are named the same
    const picks = cross.filter((p) => p.widget !== w.id && charts.get(p.widget)!.dataset === w.dataset).sort((a, b) => (a.widget < b.widget ? -1 : 1));
    const key = JSON.stringify([w.dataset, picks.map((p) => p.widget)]);
    if (!groups.has(key)) groups.set(key, { name: w.dataset, picks, widgets: [] });
    groups.get(key)!.widgets.push(w);
  }

  for (const { name, picks, widgets } of groups.values()) {
    try {
      const narrowing = picks.map((p) => ({ column: charts.get(p.widget)!.spec.x, value: p.value }));
      const r = await route(name);
      const result = await run(r, datasetQuery(r.dataset, filters, values, paramValues, narrowing));
      await Promise.all(
        widgets.map(async (w) => {
          try {
            if (w.kind === "chart") {
              out[w.id] = { kind: "chart", data: await call(r, "result.chart", { result_id: result.id, spec: w.spec }), columns: result.columns };
            } else {
              out[w.id] = tableData(w, result.columns, await call(r, "result.page", { result_id: result.id, offset: 0, limit: TABLE_ROWS }));
            }
          } catch (e) {
            fail(w.id, e);
          }
        }),
      );
    } catch (e) {
      for (const w of widgets) fail(w.id, e);
    }
  }

  // a filter lists the values of the first column it narrows
  for (const f of filters) {
    if (!f.fields) continue;
    try {
      const r = await route(f.fields[0].dataset);
      const result = await run(r, optionsQuery(r.dataset, f.fields[0].column, paramValues));
      const page = await call(r, "result.page", { result_id: result.id, offset: 0, limit: MAX_LIST });
      out[f.id] = { kind: "filter", options: page.rows.map((row) => row[0]) };
    } catch (e) {
      fail(f.id, e);
    }
  }

  return { widgets: out, at: Date.now() };
}
