import "server-only";

import type { CellValue, KernelMethod, ParamsOf, QueryParams, ResultOf } from "@iara/protocol";

import type { ParamSpec } from "@/features/queries/queryHeader";
import { coerce, detectParams, mergeSpecs, shown, type ParamRaw } from "@/features/queries/queryParams";
import { freshEntry, uncovered, wantsExtract, type ExtractManifest } from "@/lib/dashboards/extracts";
import { groupField, narrower, type Form, type PickOn } from "@/lib/dashboards/narrow";
import { checkPicks, datasetQuery, filterValueProblem, MAX_LIST, mergeParams, paramValuesOf, type DatasetQuery } from "@/lib/dashboards/query";
import { checkModel } from "@/lib/model/check";
import { modelQuery } from "@/lib/model/compile";
import type { Model } from "@/lib/model/types";
import type { ChartWidget, CrossPicks, Dataset, FilterValues, FilterWidget, RenderResult, TableWidget, Widget, WidgetData } from "@/lib/dashboards/types";

import { datasetHash } from "./extractStore";

/** Rows a table widget shows. */
const TABLE_ROWS = 100;
/** The kinds a model's measures can draw, with the most points the kernel's chart sends for each (MAX_BARS and MAX_LINE in runtime/charts.py). */
const MEASURE_LIMITS: Record<string, number> = { bar: 100, pie: 100, counter: 100, line: 5000, area: 5000 };
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

/** Where a query runs: on the serving kernel, reading the extracts of every dataset it reads (`serve`), or live on the dashboard's kernel. */
interface Route {
  form: Form;
  serve?: NonNullable<RunDeps["extracts"]>["serve"];
}

/** A pick of a chart, on the column it narrows. */
interface Picked extends PickOn {
  widget: string;
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

/** A chart that draws measures of the model instead of aggregating a column. */
function isMeasureChart(w: Widget): w is ChartWidget & { measures: string[] } {
  return w.kind === "chart" && !!w.measures?.length;
}

/** The query itself; throws when a placeholder has no value. */
function ready(q: DatasetQuery): Extract<DatasetQuery, { query: string }> {
  if ("missing" in q) throw new Error(`needs a value for ${q.missing.map((n) => `:${n}`).join(", ")}`);
  return q;
}

/** A float the kernel could not write as a JSON number: it sends NaN and the infinities as "nan", "inf" and "-inf" (json_value in runtime/results.py). */
function notFinite(v: CellValue, type: string): boolean {
  if (typeof v === "number") return !Number.isFinite(v);
  return typeof v === "string" && /^(double|float|halffloat)/.test(type) && /^-?(inf|nan)$/.test(v);
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
 * filter values (by filter id) and the chart picks (`cross`) given. Every
 * widget reads its dataset narrowed by the filters and the picks of the other
 * charts, on its dataset and on the datasets it points at through the model's
 * relationships (lib/dashboards/narrow.ts); widgets on one dataset with the
 * same picks share one run. A pick narrows the column its chart's x names, a
 * related dataset's or a calendar's for a measure chart with `dataset.column`.
 * Queries run one after another; one that fails fails its widgets only. A query
 * runs on the serving kernel when every dataset it reads (a calendar reads its
 * sources) has a fresh extract, and live on the dashboard's kernel otherwise. A
 * chart with `measures` draws them from `input.model` with a query of its own,
 * over the narrowed rows of each dataset it reads, some without the filters the
 * measure changes; the measures' parameters take the value of the filter that
 * sets them, else their default. A dataset only measure charts use is not run
 * as is.
 */
export async function renderDashboard(input: { datasets: Dataset[]; widgets: Widget[]; model?: string }, values: FilterValues, deps: RunDeps, cross: CrossPicks = []): Promise<RenderResult> {
  checkValues(input.widgets, values);
  checkPicks(input.widgets, cross);
  const filters = input.widgets.filter((w): w is FilterWidget => w.kind === "filter");
  const paramValues = paramValuesOf(filters, values);
  const out: Record<string, WidgetData> = {};
  const names = input.datasets.map((d) => d.name);

  const fail = (id: string, e: unknown) => {
    const message = e instanceof Error ? e.message : String(e);
    if (deps.redact) console.error(`dashboard widget ${id}: ${message}`);
    out[id] = { kind: "error", message: deps.redact ? HIDDEN_ERROR : message };
  };

  /** A request on the kernel the route names. */
  const call = <M extends ServeMethod>(r: Route, method: M, params: ParamsOf<M>): Promise<ResultOf<M>> => (r.serve ? r.serve(method, params) : deps.request(method, params));

  /** Runs a query; its result's id and columns. */
  async function run(r: Route, q: DatasetQuery) {
    const { query, params } = ready(q);
    const output = await call(r, "sql.run", { query, source: deps.source, ...params, ...(r.serve ? {} : allowParam(deps.allow)) });
    if (output.type === "error") throw new Error(`${output.ename}: ${output.evalue}`);
    if (output.type !== "table") throw new Error("the dataset did not return a table");
    return output.result;
  }

  /** A dataset with a fresh extract, as a read of it (its SQL is the read: nothing to compile); null: it has none, or is stale. */
  function extractOf(d: Dataset): Dataset | null {
    const { extracts } = deps;
    const entry = extracts && wantsExtract(d) ? freshEntry(extracts.manifest, d.name, datasetHash(d)) : null;
    if (!extracts || !entry) return null;
    const lost = uncovered(entry, deps.allow);
    if (lost) throw new Error(`no read grant on table ${lost}`);
    const url = extracts.url(d.name, entry.version).replaceAll("'", "''");
    return { name: d.name, sql: `SELECT * FROM read_parquet('${url}')`, params: {} };
  }

  // the datasets as queries read them, filled by `route`; a recipe is compiled at most once per render, by whichever query needs it first
  const forms: Record<Form, Map<string, Dataset>> = { extract: new Map(), live: new Map() };
  const compiled = new Map<string, Promise<Dataset>>();
  const datasetOf = (name: string, form: Form): Dataset => {
    const d = forms[form].get(name);
    if (!d) throw new Error(`dataset ${name} is not part of this query`);
    return d;
  };

  /**
   * Where a query that reads these datasets runs. All with a fresh extract:
   * the serving kernel, reading the extracts. Otherwise the whole query runs
   * live, since one query has one kernel to run on.
   */
  async function route(read: string[]): Promise<Route> {
    const found = read.map((name) => {
      const d = input.datasets.find((x) => x.name === name);
      if (!d) throw new Error(`there is no dataset ${name}`);
      return d;
    });
    const fresh = found.map(extractOf);
    const { extracts } = deps;
    if (extracts && fresh.every((d) => d)) {
      found.forEach((d, i) => forms.extract.set(d.name, fresh[i]!));
      return { form: "extract", serve: extracts.serve };
    }
    await Promise.all(
      found.map(async (d) => {
        if (!compiled.has(d.name)) compiled.set(d.name, withSql(d, deps.request));
        forms.live.set(d.name, await compiled.get(d.name)!);
      }),
    );
    return { form: "live" };
  }

  // the model is checked once, by whoever needs it first; the columns of the datasets are not known here, so the SQL itself fails on a bad one
  let checked: Model | undefined;
  const modelOf = (): Model => (checked ??= checkModel(input.model ?? "", Object.fromEntries(names.map((n) => [n, null]))).model);
  // a dashboard with a model has relationships and calendars to narrow through, whatever its widgets draw
  const modeled = input.model?.trim() ? modelOf() : undefined;
  const nar = narrower({ rels: modeled?.relationships ?? [], calendars: modeled?.calendars ?? [], filters, values, paramValues, datasetOf });
  // what `dataset.column` can name: a dataset of the dashboard, or a calendar of the model
  const groupNames = () => [...names, ...modelOf().calendars.map((c) => c.name)];

  // the pick of a chart narrows the column of its x; a measure chart's x may be a related dataset's or a calendar's `dataset.column`
  // ids in the order of the widgets' ids, so the parameters of the same pick are named the same however the viewer clicked
  const charts = new Map(input.widgets.flatMap((w) => (w.kind === "chart" ? [[w.id, w] as const] : [])));
  const picks: Picked[] = [...cross]
    .sort((a, b) => (a.widget < b.widget ? -1 : 1))
    .map((p, id) => {
      const c = charts.get(p.widget)!;
      const { dataset, column } = isMeasureChart(c) ? groupField(c.dataset, c.spec.x, groupNames()) : { dataset: c.dataset, column: c.spec.x };
      return { id, widget: p.widget, dataset, column, value: p.value };
    });
  /** the picks that narrow a widget: all but its own */
  const othersOf = (w: Widget) => picks.filter((p) => p.widget !== w.id);

  /** The data of a chart that draws measures: one query over the narrowed rows of each dataset the measures read, whose points the kernel's chart would send. */
  async function measureChart(w: ChartWidget & { measures: string[] }): Promise<WidgetData> {
    const { kind, x, group } = w.spec;
    const limit = MEASURE_LIMITS[kind];
    if (!limit) throw new Error("measures work with bar, line, area, pie and counter charts");
    const model = modelOf();
    const others = othersOf(w);
    const known = groupNames();
    const ask = {
      x: kind === "counter" ? null : groupField(w.dataset, x, known),
      group: group ? groupField(w.dataset, group, known) : null,
      measures: w.measures,
      order: kind === "line" || kind === "area" ? ("x" as const) : ("value" as const),
      limit: limit + 1,
    };
    // the first compile only learns which datasets are read (a measure can ask for a dataset without some filters): the query runs on one kernel, so every source must be read in the form that kernel takes
    const read: string[] = [];
    modelQuery(model, {
      ...ask,
      source: (d, ignore) => {
        read.push(...nar.reads(nar.plan(d, others, ignore)));
        return "SELECT 1";
      },
    });
    const r = await route([...new Set(read)]);
    let params: QueryParams = {};
    const { sql, notes, params: modelParams } = modelQuery(model, {
      ...ask,
      source: (d, ignore) => {
        const q = ready(nar.query(nar.plan(d, others, ignore), r.form));
        params = mergeParams(params, q.params);
        return q.query;
      },
    });
    // a measure's parameter takes the value of the filter that sets it, else its default; a name a dataset also binds must mean the same there
    for (const p of modelParams) {
      const type = typeof p.default === "number" ? "number" : "text";
      const raw = paramValues[p.name];
      const value = raw === undefined ? p.default : coerce({ type }, raw);
      if (value === undefined) throw new Error(`:${p.name} must be ${type === "number" ? "a number" : "text"}`);
      params = mergeParams(params, { params: { [p.name]: value }, param_types: { [p.name]: type } });
    }
    const drawn = w.measures.flatMap((name) => model.measures.filter((m) => m.name === name));
    const result = await run(r, { query: sql, params });
    const { rows } = await call(r, "result.page", { result_id: result.id, offset: 0, limit: limit + 1 });
    for (const name of w.measures) {
      const i = result.columns.findIndex((c) => c.name === name);
      if (i >= 0 && rows.some((row) => notFinite(row[i], result.columns[i].type))) throw new Error(`division by zero in ${name}`);
    }
    const formats = Object.fromEntries(drawn.flatMap((m) => (m.format ? [[m.name, m.format] as const] : [])));
    return {
      kind: "chart",
      data: { columns: result.columns.map((c) => c.name), rows: rows.slice(0, limit), truncated: rows.length > limit },
      columns: result.columns,
      ...(Object.keys(formats).length && { formats }),
      // what the author should know; a viewer is told nothing about the model
      ...(!deps.redact && notes.length && { notes }),
    };
  }

  // chart and table widgets by dataset and the picks that narrow it (a chart's own never does), in the order they first appear
  const groups = new Map<string, { name: string; picks: Picked[]; widgets: (ChartWidget | TableWidget)[] }>();
  for (const w of input.widgets) {
    if ((w.kind !== "chart" && w.kind !== "table") || isMeasureChart(w)) continue;
    const mine = nar.relevant(w.dataset, othersOf(w));
    const key = JSON.stringify([w.dataset, mine.map((p) => p.id)]);
    if (!groups.has(key)) groups.set(key, { name: w.dataset, picks: mine, widgets: [] });
    groups.get(key)!.widgets.push(w);
  }

  for (const { name, picks: mine, widgets } of groups.values()) {
    try {
      const plan = nar.plan(name, mine);
      const r = await route(nar.reads(plan));
      // the dataset runs once for the widgets that draw its rows
      const result = await run(r, nar.query(plan, r.form));
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

  // a measure chart runs a query of its own, so a dataset that only they use is not run as is
  for (const w of input.widgets.filter(isMeasureChart)) {
    try {
      out[w.id] = await measureChart(w);
    } catch (e) {
      fail(w.id, e);
    }
  }

  // a filter lists the values of the first column it narrows
  for (const f of filters) {
    if (!f.fields) continue;
    try {
      const { dataset, column } = f.fields[0];
      const r = await route(nar.sources(dataset));
      const result = await run(r, nar.options(dataset, column, r.form));
      const page = await call(r, "result.page", { result_id: result.id, offset: 0, limit: MAX_LIST });
      out[f.id] = { kind: "filter", options: page.rows.map((row) => row[0]) };
    } catch (e) {
      fail(f.id, e);
    }
  }

  return { widgets: out, at: Date.now() };
}
