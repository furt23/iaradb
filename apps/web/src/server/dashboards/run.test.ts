import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtractEntry } from "@/lib/dashboards/extracts";
import type { ChartWidget, Dataset, FilterWidget, NumberFormat, TableWidget, Widget } from "@/lib/dashboards/types";
import type { Ignore } from "@/lib/model/compile";
import type { Calendar, Measure, Model, Param, Relationship } from "@/lib/model/types";

import { datasetHash } from "./extractStore";
import { explainDatasets, HIDDEN_ERROR, renderDashboard, withSql, type RunDeps } from "./run";

// the model's parser and compiler have tests of their own: here they are stood in for, to see what a render asks of them
const modelMock = vi.hoisted(() => ({ check: vi.fn(), query: vi.fn() }));
vi.mock("@/lib/model/check", () => ({ checkModel: modelMock.check }));
vi.mock("@/lib/model/compile", () => ({ modelQuery: modelMock.query }));
// a calendar's rows are stood in for by a query that shows the rows of its sources
vi.mock("@/lib/model/calendar", () => ({
  calendarSql: (cal: Calendar, base: (dataset: string) => string) =>
    `SELECT "date" FROM (${cal.columns.map((c) => `SELECT "${c.column}" AS "date" FROM (${base(c.dataset)}) AS _s`).join(" UNION ")}) AS ${cal.name}`,
}));

const columns = [
  { name: "region", type: "string_view" },
  { name: "amount", type: "double" },
];
const sales: Dataset = { name: "sales", sql: "SELECT * FROM sales", params: {} };
/** a recipe dataset: the kernel compiles it to `SELECT * FROM <table>` */
const recipeOf = (name: string, table: string): Dataset => ({ name, sql: "", params: {}, recipe: { source: { table }, steps: [] } });
const chart: ChartWidget = { id: "chart001", kind: "chart", dataset: "sales", spec: { kind: "bar", x: "region", y: ["amount"], agg: "sum" } };
const table: TableWidget = { id: "table001", kind: "table", dataset: "sales" };
const region: FilterWidget = { id: "filter01", kind: "filter", control: "select", fields: [{ dataset: "sales", column: "region" }], value_type: "text" };

interface Call {
  method: string;
  params: Record<string, unknown>;
}

/** a kernel that answers `sql.run` with a table of `columns` (or what `onRun` says), and the rest with fixed data */
function fakeKernel(onRun?: (query: string) => unknown) {
  const calls: Call[] = [];
  let n = 0;
  const request = (async (method: string, params: Record<string, unknown>) => {
    calls.push({ method, params });
    switch (method) {
      case "sql.run": {
        if (onRun) {
          const answer = onRun(params.query as string);
          if (answer !== undefined) return answer;
        }
        return { type: "table", result: { id: `r${++n}`, columns, num_rows: 2, page: { offset: 0, total: 2, rows: [] } } };
      }
      case "result.chart":
        return { columns: ["region", "amount"], rows: [["EU", 3]], truncated: false };
      case "result.page":
        return { offset: 0, total: 2, rows: [["EU", 3], ["US", 4]] };
      case "wrangle.sql":
        return { sql: `SELECT * FROM ${(params.source as { table: string }).table}` };
      default:
        throw new Error(`unexpected ${method}`);
    }
  }) as RunDeps["request"];
  return { calls, request };
}

const deps = (request: RunDeps["request"], redact = false): RunDeps => ({ request, redact, source: "dashboard Sales" });
const render = (widgets: Widget[], values: object, d: RunDeps, datasets = [sales]) => renderDashboard({ datasets, widgets }, values as never, d);

afterEach(() => vi.restoreAllMocks());

describe("renderDashboard", () => {
  it("runs a dataset once for its widgets and draws a chart, a table and a filter", async () => {
    const k = fakeKernel();
    const r = await render([chart, table, region], {}, deps(k.request));
    expect(k.calls.filter((c) => c.method === "sql.run").map((c) => c.params.query)).toEqual([
      "SELECT * FROM (\nSELECT * FROM sales\n) AS _d",
      'SELECT DISTINCT "region" AS value FROM (\nSELECT * FROM sales\n) AS _d WHERE "region" IS NOT NULL ORDER BY 1 LIMIT 500',
    ]);
    expect(k.calls[0].params.source).toBe("dashboard Sales");
    expect(r.widgets.chart001).toEqual({ kind: "chart", data: { columns: ["region", "amount"], rows: [["EU", 3]], truncated: false }, columns });
    expect(k.calls.find((c) => c.method === "result.chart")?.params).toEqual({ result_id: "r1", spec: chart.spec });
    expect(r.widgets.table001).toEqual({ kind: "table", columns, rows: [["EU", 3], ["US", 4]], total: 2 });
    expect(k.calls.find((c) => c.method === "result.page")?.params).toEqual({ result_id: "r1", offset: 0, limit: 100 });
    expect(r.widgets.filter01).toEqual({ kind: "filter", options: ["EU", "US"] });
    expect(k.calls.filter((c) => c.method === "result.page")[1].params).toEqual({ result_id: "r2", offset: 0, limit: 500 });
    expect(r.at).toBeGreaterThan(0);
  });

  it("applies the filter values as parameters", async () => {
    const k = fakeKernel();
    await render([chart, region], { filter01: "EU" }, deps(k.request));
    const run = k.calls[0].params;
    expect(run.query).toContain('WHERE "region" = :_f0');
    expect(run.params).toEqual({ _f0: "EU" });
    expect(run.param_types).toEqual({ _f0: "text" });
  });

  describe("chart picks", () => {
    const byYear: ChartWidget = { id: "chart002", kind: "chart", dataset: "sales", spec: { kind: "line", x: "year", y: ["amount"], agg: "sum" } };
    const stores: Dataset = { name: "stores", sql: "SELECT * FROM stores", params: {} };
    const storeTable: TableWidget = { id: "table002", kind: "table", dataset: "stores" };
    const sent = (k: ReturnType<typeof fakeKernel>) => k.calls.filter((c) => c.method === "sql.run").map((c) => ({ query: c.params.query, params: c.params.params }));
    const resultOf = (k: ReturnType<typeof fakeKernel>, method: string) => k.calls.filter((c) => c.method === method).map((c) => c.params.result_id);
    const renderPicked = (widgets: Widget[], cross: { widget: string; value: string | number | boolean | null }[], d: RunDeps, datasets = [sales, stores]) =>
      renderDashboard({ datasets, widgets }, {}, d, cross);

    it("narrows the other charts and tables on the picked chart's dataset, not the chart itself nor other datasets", async () => {
      const k = fakeKernel();
      const r = await renderPicked([chart, byYear, table, storeTable], [{ widget: "chart001", value: "EU" }], deps(k.request));
      expect(sent(k)).toEqual([
        { query: "SELECT * FROM (\nSELECT * FROM sales\n) AS _d", params: undefined },
        { query: 'SELECT * FROM (\nSELECT * FROM sales\n) AS _d\nWHERE CAST("region" AS VARCHAR) = :_c0', params: { _c0: "EU" } },
        { query: "SELECT * FROM (\nSELECT * FROM stores\n) AS _d", params: undefined },
      ]);
      // the picked chart draws the unfiltered run; its sibling chart and the table share the narrowed one; the other dataset has its own
      expect(resultOf(k, "result.chart")).toEqual(["r1", "r2"]);
      expect(resultOf(k, "result.page")).toEqual(["r2", "r3"]);
      expect(Object.keys(r.widgets).sort()).toEqual(["chart001", "chart002", "table001", "table002"]);
    });

    it("applies the picks of several charts together, each chart left out of its own", async () => {
      const k = fakeKernel();
      await renderPicked([chart, byYear, table], [{ widget: "chart002", value: 2024 }, { widget: "chart001", value: "EU" }], deps(k.request));
      expect(sent(k)).toEqual([
        // a pick is named by its place among the picks (by chart id), whichever widget reads it
        { query: 'SELECT * FROM (\nSELECT * FROM sales\n) AS _d\nWHERE "year" = :_c1', params: { _c1: 2024 } },
        { query: 'SELECT * FROM (\nSELECT * FROM sales\n) AS _d\nWHERE CAST("region" AS VARCHAR) = :_c0', params: { _c0: "EU" } },
        { query: 'SELECT * FROM (\nSELECT * FROM sales\n) AS _d\nWHERE CAST("region" AS VARCHAR) = :_c0\n  AND "year" = :_c1', params: { _c0: "EU", _c1: 2024 } },
      ]);
    });

    it("keeps the filters' values and the allow list on the narrowed runs, and does not narrow what a filter lists", async () => {
      const k = fakeKernel();
      await renderDashboard({ datasets: [sales], widgets: [chart, byYear, region] }, { filter01: "US" }, { ...deps(k.request), allow: ["main"] }, [{ widget: "chart001", value: null }]);
      const runs = k.calls.filter((c) => c.method === "sql.run");
      expect(runs.map((c) => c.params.query)).toEqual([
        'SELECT * FROM (\nSELECT * FROM sales\n) AS _d\nWHERE "region" = :_f0',
        'SELECT * FROM (\nSELECT * FROM sales\n) AS _d\nWHERE "region" = :_f0\n  AND "region" IS NULL',
        'SELECT DISTINCT "region" AS value FROM (\nSELECT * FROM sales\n) AS _d WHERE "region" IS NOT NULL ORDER BY 1 LIMIT 500',
      ]);
      expect(runs.map((c) => c.params.allow)).toEqual([["main"], ["main"], ["main"]]);
      expect(runs[1].params.params).toEqual({ _f0: "US" });
    });

    it("fails only the widgets of a narrowed run that fails", async () => {
      const k = fakeKernel((q) => (q.includes("_c0") ? { type: "error", ename: "SqlError", evalue: "no column year", traceback: "" } : undefined));
      const r = await renderPicked([chart, byYear, table], [{ widget: "chart001", value: "EU" }], deps(k.request), [sales]);
      expect(r.widgets.chart001.kind).toBe("chart");
      expect(r.widgets.chart002).toEqual({ kind: "error", message: "SqlError: no column year" });
      expect(r.widgets.table001).toEqual({ kind: "error", message: "SqlError: no column year" });
    });

    it("refuses picks that are not valid without running anything", async () => {
      const k = fakeKernel();
      const histogram: ChartWidget = { ...chart, id: "hist0001", spec: { kind: "histogram", x: "amount", y: [], agg: "count" } };
      const ok = { widget: "chart001", value: "EU" };
      await expect(renderPicked([chart, table, region], [{ widget: "nope", value: "EU" }], deps(k.request))).rejects.toThrow(/not a chart/);
      await expect(renderPicked([chart, table, region], [{ widget: "table001", value: "EU" }], deps(k.request))).rejects.toThrow(/not a chart/);
      await expect(renderPicked([chart, histogram], [{ widget: "hist0001", value: 1 }], deps(k.request))).rejects.toThrow(/not a chart/);
      await expect(renderPicked([chart], [ok, ok], deps(k.request))).rejects.toThrow(/picked twice/);
      await expect(renderPicked([chart], Array.from({ length: 11 }, () => ok), deps(k.request))).rejects.toThrow(/at most 10/);
      await expect(renderPicked([chart], [{ widget: "chart001", value: { a: 1 } as never }], deps(k.request))).rejects.toThrow(/not a value/);
      expect(k.calls).toEqual([]);
    });
  });

  it("sends the tables the queries may read with each query, an empty list too, and nothing when unchecked", async () => {
    const k = fakeKernel();
    await render([chart, region], {}, { ...deps(k.request), allow: [] });
    expect(k.calls.filter((c) => c.method === "sql.run").map((c) => c.params.allow)).toEqual([[], []]);
    const unchecked = fakeKernel();
    await render([chart], {}, { ...deps(unchecked.request), allow: null });
    expect(unchecked.calls[0].params).not.toHaveProperty("allow");
  });

  it("shows only the columns a table asks for, in its order", async () => {
    const k = fakeKernel();
    const r = await render([{ ...table, columns: ["amount"] }], {}, deps(k.request));
    expect(r.widgets.table001).toEqual({ kind: "table", columns: [columns[1]], rows: [[3], [4]], total: 2 });
    const bad = await render([{ ...table, columns: ["nope"] }], {}, deps(k.request));
    expect(bad.widgets.table001).toEqual({ kind: "error", message: "the dataset has no column nope" });
  });

  it("fails every widget of a dataset whose query fails, and only those", async () => {
    const other: Dataset = { name: "stores", sql: "SELECT * FROM stores", params: {} };
    const k = fakeKernel((q) => (q.includes("sales") ? { type: "error", ename: "SqlError", evalue: "no table sales", traceback: "" } : undefined));
    const r = await render([chart, table, { ...table, id: "table002", dataset: "stores" }], {}, deps(k.request), [sales, other]);
    expect(r.widgets.chart001).toEqual({ kind: "error", message: "SqlError: no table sales" });
    expect(r.widgets.table001).toEqual({ kind: "error", message: "SqlError: no table sales" });
    expect(r.widgets.table002.kind).toBe("table");
  });

  it("fails the widgets of a dataset when the kernel throws or a widget names a missing dataset", async () => {
    const request = (async () => {
      throw new Error("the kernel is gone");
    }) as unknown as RunDeps["request"];
    const r = await render([chart, { ...table, dataset: "ghost" }], {}, deps(request));
    expect(r.widgets.chart001).toEqual({ kind: "error", message: "the kernel is gone" });
    expect(r.widgets.table001).toEqual({ kind: "error", message: "there is no dataset ghost" });
  });

  it("fails only the chart whose aggregation fails", async () => {
    const k = fakeKernel();
    const request = (async (method: string, params: never) => {
      if (method === "result.chart") throw new Error("bad column");
      return (k.request as (m: string, p: unknown) => Promise<unknown>)(method, params);
    }) as unknown as RunDeps["request"];
    const r = await render([chart, table], {}, deps(request));
    expect(r.widgets.chart001).toEqual({ kind: "error", message: "bad column" });
    expect(r.widgets.table001.kind).toBe("table");
  });

  it("says which placeholders need a value, without running the dataset", async () => {
    const needs: Dataset = { name: "sales", sql: "SELECT * FROM sales WHERE year = :year", params: {} };
    const k = fakeKernel();
    const r = await render([chart], {}, deps(k.request), [needs]);
    expect(r.widgets.chart001).toEqual({ kind: "error", message: "needs a value for :year" });
    expect(k.calls).toEqual([]);
    const year: FilterWidget = { id: "param001", kind: "filter", control: "text", param: "year" };
    const ok = await render([chart, year], { param001: "2024" }, deps(k.request), [needs]);
    expect(ok.widgets.chart001.kind).toBe("chart");
    expect(k.calls[0].params.params).toEqual({ year: "2024" });
    expect(ok.widgets.param001).toBeUndefined();
  });

  it("gives viewers a plain error and logs the real one with the widget id", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const k = fakeKernel(() => ({ type: "error", ename: "SqlError", evalue: "no table secret_sales", traceback: "" }));
    const r = await render([chart], {}, deps(k.request, true));
    expect(r.widgets.chart001).toEqual({ kind: "error", message: HIDDEN_ERROR });
    expect(log).toHaveBeenCalledWith("dashboard widget chart001: SqlError: no table secret_sales");
  });

  it("refuses values of widgets that are not filters, and values that are not valid", async () => {
    const k = fakeKernel();
    await expect(render([chart, region], { chart001: "x" }, deps(k.request))).rejects.toThrow(/not a filter/);
    await expect(render([chart, region], { nope: "x" }, deps(k.request))).rejects.toThrow(/not a filter/);
    await expect(render([chart, region], { filter01: ["a"] }, deps(k.request))).rejects.toThrow(/expected/);
    await expect(render([chart, region], [] as never, deps(k.request))).rejects.toThrow(/an object/);
    expect(k.calls).toEqual([]);
  });

  it("does not take a dataset that holds two queries, nor run it", async () => {
    const k = fakeKernel();
    const r = await render([chart], {}, deps(k.request), [{ ...sales, sql: "SELECT 1; DROP TABLE sales" }]);
    expect(r.widgets.chart001).toEqual({ kind: "error", message: "a dataset holds one query" });
    expect(k.calls).toEqual([]);
  });

  it("compiles a recipe dataset once for all its widgets and filters, then runs it like a SQL one", async () => {
    const k = fakeKernel();
    const r = await render([chart, table, region], {}, deps(k.request), [recipeOf("sales", "main.sales")]);
    expect(k.calls.filter((c) => c.method === "wrangle.sql").map((c) => c.params)).toEqual([{ source: { table: "main.sales" }, steps: [] }]);
    expect(k.calls.filter((c) => c.method === "sql.run").map((c) => c.params.query)).toEqual([
      "SELECT * FROM (\nSELECT * FROM main.sales\n) AS _d",
      'SELECT DISTINCT "region" AS value FROM (\nSELECT * FROM main.sales\n) AS _d WHERE "region" IS NOT NULL ORDER BY 1 LIMIT 500',
    ]);
    expect([r.widgets.chart001.kind, r.widgets.table001.kind, r.widgets.filter01.kind]).toEqual(["chart", "table", "filter"]);
  });

  it("fails only the widgets and filters of a recipe that does not compile, compiling it once", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const k = fakeKernel();
    let compiles = 0;
    const request = (async (method: string, params: { source?: { table: string } }) => {
      if (method === "wrangle.sql" && params.source?.table === "nope") {
        compiles++;
        throw new Error("no table nope");
      }
      return (k.request as (m: string, p: unknown) => Promise<unknown>)(method, params);
    }) as unknown as RunDeps["request"];
    const widgets = [chart, { ...table, id: "table002", dataset: "stores" }, { ...region, id: "filter02", fields: [{ dataset: "stores", column: "region" }] }];
    const datasets = [sales, recipeOf("stores", "nope")];
    const r = await render(widgets, {}, deps(request), datasets);
    expect(r.widgets.chart001.kind).toBe("chart");
    expect(r.widgets.table002).toEqual({ kind: "error", message: "no table nope" });
    expect(r.widgets.filter02).toEqual({ kind: "error", message: "no table nope" });
    expect(compiles).toBe(1);
    const viewer = await render(widgets, {}, deps(request, true), datasets);
    expect(viewer.widgets.table002).toEqual({ kind: "error", message: HIDDEN_ERROR });
    expect(log).toHaveBeenCalledWith("dashboard widget table002: no table nope");
  });
});

describe("extracts", () => {
  /** the manifest entry of a dataset built from its current definition */
  const entryOf = (d: Dataset, over: Partial<ExtractEntry> = {}): ExtractEntry => ({
    version: "20261028T231500Z-a1b2",
    rows: 2,
    bytes: 100,
    columns,
    sources: ["main.public.sales"],
    hash: datasetHash(d),
    refreshed_at: 1,
    ...over,
  });
  const withExtracts = (k: ReturnType<typeof fakeKernel>, serving: ReturnType<typeof fakeKernel>, entries: Record<string, ExtractEntry>, allow: string[] | null = null): RunDeps => ({
    ...deps(k.request),
    allow,
    extracts: { manifest: { datasets: entries }, serve: serving.request as never, url: (name, v) => `s3://bucket/_iara/extracts/d1/${name}/${v}.parquet` },
  });
  const READ = "SELECT * FROM read_parquet('s3://bucket/_iara/extracts/d1/sales/20261028T231500Z-a1b2.parquet')";
  const queries = (k: ReturnType<typeof fakeKernel>) => k.calls.filter((c) => c.method === "sql.run").map((c) => c.params.query);

  it("reads a fresh extract on the serving kernel, with no allow list, for the queries, the charts, the table and the filter options; the dashboard's kernel runs nothing", async () => {
    const live = fakeKernel();
    const serving = fakeKernel();
    const r = await render([chart, table, region], { filter01: "EU" }, withExtracts(live, serving, { sales: entryOf(sales) }, ["main"]), [sales]);
    expect(live.calls).toEqual([]);
    expect(queries(serving)).toEqual([
      `SELECT * FROM (\n${READ}\n) AS _d\nWHERE "region" = :_f0`,
      `SELECT DISTINCT "region" AS value FROM (\n${READ}\n) AS _d WHERE "region" IS NOT NULL ORDER BY 1 LIMIT 500`,
    ]);
    // field filters still travel as parameters, and nothing asks the serving kernel to check grants
    expect(serving.calls[0].params.params).toEqual({ _f0: "EU" });
    expect(serving.calls.filter((c) => c.method === "sql.run").every((c) => !("allow" in c.params))).toBe(true);
    expect(serving.calls.map((c) => c.method).sort()).toEqual(["result.chart", "result.page", "result.page", "sql.run", "sql.run"]);
    expect([r.widgets.chart001.kind, r.widgets.table001.kind, r.widgets.filter01.kind]).toEqual(["chart", "table", "filter"]);
  });

  it("narrows an extract by chart picks like a live dataset", async () => {
    const serving = fakeKernel();
    await renderDashboard({ datasets: [sales], widgets: [chart, table] }, {}, withExtracts(fakeKernel(), serving, { sales: entryOf(sales) }), [{ widget: "chart001", value: "EU" }]);
    // the picked chart draws the whole extract, the table the narrowed one
    expect(queries(serving)).toEqual([`SELECT * FROM (\n${READ}\n) AS _d`, `SELECT * FROM (\n${READ}\n) AS _d\nWHERE CAST("region" AS VARCHAR) = :_c0`]);
  });

  it("doubles the single quotes of the extract's URL", async () => {
    const serving = fakeKernel();
    const d = withExtracts(fakeKernel(), serving, { sales: entryOf(sales) });
    d.extracts!.url = () => "/data/it's/sales.parquet";
    await render([table], {}, d);
    expect(queries(serving)).toEqual(["SELECT * FROM (\nSELECT * FROM read_parquet('/data/it''s/sales.parquet')\n) AS _d"]);
  });

  it("runs live a dataset whose extract was built from another definition, or has none", async () => {
    const stale = fakeKernel();
    const serving = fakeKernel();
    await render([chart], {}, withExtracts(stale, serving, { sales: entryOf(sales, { hash: "old" }) }, ["main"]));
    expect(queries(stale)).toEqual(["SELECT * FROM (\nSELECT * FROM sales\n) AS _d"]);
    expect(stale.calls[0].params.allow).toEqual(["main"]);
    const none = fakeKernel();
    await render([chart], {}, { ...deps(none.request), extracts: { manifest: null, serve: serving.request as never, url: () => "" } });
    expect(queries(none)).toHaveLength(1);
    expect(serving.calls).toEqual([]);
  });

  it("runs live a dataset set to live and one with params, even with a fresh extract", async () => {
    const pinned: Dataset = { ...sales, mode: "live" };
    const withParam: Dataset = { name: "sales", sql: "SELECT * FROM sales WHERE year = :year", params: { year: { type: "number", default: 2024 } } };
    for (const d of [pinned, withParam]) {
      const live = fakeKernel();
      const serving = fakeKernel();
      await render([chart], {}, withExtracts(live, serving, { sales: entryOf(d) }), [d]);
      expect(live.calls.map((c) => c.method)).toEqual(["sql.run", "result.chart"]);
      expect(serving.calls).toEqual([]);
    }
  });

  it("reads a fresh extract of a recipe without compiling it, and compiles it on the dashboard's kernel when it goes live", async () => {
    const recipe = recipeOf("sales", "main.sales");
    const live = fakeKernel();
    const serving = fakeKernel();
    await render([chart], {}, withExtracts(live, serving, { sales: entryOf(recipe) }), [recipe]);
    expect(live.calls).toEqual([]);
    expect(queries(serving)).toEqual([`SELECT * FROM (\n${READ}\n) AS _d`]);
    const stale = fakeKernel();
    await render([chart], {}, withExtracts(stale, fakeKernel(), {}), [recipe]);
    expect(stale.calls.map((c) => c.method)).toEqual(["wrangle.sql", "sql.run", "result.chart"]);
  });

  it("fails the widgets of a dataset whose extract read a table the viewer may not, and not the others", async () => {
    const other: Dataset = { name: "stores", sql: "SELECT * FROM stores", params: {} };
    const live = fakeKernel();
    const serving = fakeKernel();
    const entries = { sales: entryOf(sales, { sources: ["main.public.sales", "main.secret.pay"] }), stores: entryOf(other, { sources: ["main.public.stores"] }) };
    const r = await render([chart, table, region, { ...table, id: "table002", dataset: "stores" }], {}, withExtracts(live, serving, entries, ["main.public"]), [sales, other]);
    const lost = { kind: "error", message: "no read grant on table main.secret.pay" };
    expect(r.widgets.chart001).toEqual(lost);
    expect(r.widgets.table001).toEqual(lost);
    expect(r.widgets.filter01).toEqual(lost);
    expect(r.widgets.table002.kind).toBe("table");
    expect(serving.calls.filter((c) => c.method === "sql.run")).toHaveLength(1);
    // unchecked reads everything
    const all = await render([chart], {}, withExtracts(live, fakeKernel(), entries, null));
    expect(all.widgets.chart001.kind).toBe("chart");
    // a viewer sees the plain error and the log has the real one
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const viewer = await render([chart], {}, { ...withExtracts(live, serving, entries, ["main.public"]), redact: true });
    expect(viewer.widgets.chart001).toEqual({ kind: "error", message: HIDDEN_ERROR });
    expect(log).toHaveBeenCalledWith("dashboard widget chart001: no read grant on table main.secret.pay");
  });

  it("runs everything live without an extracts dependency", async () => {
    const live = fakeKernel();
    await render([chart, region], {}, deps(live.request));
    expect(queries(live)).toHaveLength(2);
    expect(live.calls.map((c) => c.method)).toEqual(["sql.run", "result.chart", "sql.run", "result.page"]);
  });
});

const span = { from: 0, to: 0, line: 1, col: 1 };
const measure = (name: string, over: Partial<Measure> = {}): Measure => ({ name, datasets: ["sales"], atoms: [{ dataset: "sales", sql: `SUM("${name}")`, agg: "sum" }], expr: [{ atom: 0 }], span, ...over });
const rel = (many: string, one: string, cast?: "date"): Relationship => {
  const [md, mc] = many.split(".");
  const [od, oc] = one.split(".");
  return { many: { dataset: md, column: mc }, one: { dataset: od, column: oc }, span, ...(cast && { cast }) };
};
const MODEL = "revenue = sum(sales.amount)";
const resultColumns = [
  { name: "region", type: "string_view" },
  { name: "revenue", type: "double" },
  { name: "margin", type: "double" },
];
const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => [`r${i}`, i, 0.5]);
const runs = (k: { calls: Call[] }) => k.calls.filter((c) => c.method === "sql.run");

/** what the compiler is asked for */
interface Ask {
  source(dataset: string, ignore?: Ignore): string;
  x: { dataset: string; column: string; as: string } | null;
  group: { dataset: string; column: string; as: string } | null;
  measures: string[];
  order: string;
  limit: number;
}

/**
 * The checker and the compiler stood in: the query names what was asked, and holds the source of each dataset the measures and the groupings are over (they join with `+`).
 * `ignore` says what a dataset is asked without (as a measure that changes the filter context does), `params` the parameters of the measures.
 */
function useCompiler(model: Model, notes: string[] = [], extra: { params?: Param[]; ignore?: (dataset: string) => Ignore | undefined } = {}) {
  modelMock.check.mockReset().mockReturnValue({ model, diagnostics: [] });
  modelMock.query.mockReset().mockImplementation((m: Model, q: Ask) => {
    const unknown = q.measures.find((n) => !m.measures.some((x) => x.name === n));
    if (unknown) throw new Error(`there is no measure ${unknown}`);
    const datasets = [...new Set([...q.measures.flatMap((n) => m.measures.find((x) => x.name === n)!.datasets), ...[q.x, q.group].flatMap((f) => (f ? [f.dataset] : []))])];
    return { sql: `MEASURES ${q.measures.join(",")} BY ${q.x?.as ?? null}/${q.group?.as ?? null} ${q.order} ${q.limit} FROM ${datasets.map((d) => q.source(d, extra.ignore?.(d))).join(" + ")}`, datasets, notes, params: extra.params ?? [] };
  });
}

/** a kernel where the compiler's queries (they start with MEASURES) answer `rows` under `cols`, and the others answer as `fakeKernel` does */
function measureKernel(rows: unknown[][] = rowsOf(2), cols = resultColumns, onRun?: (query: string) => unknown) {
  const k = fakeKernel((q) => {
    if (!q.startsWith("MEASURES")) return undefined;
    return onRun?.(q) ?? { type: "table", result: { id: "m1", columns: cols, num_rows: rows.length, page: { offset: 0, total: rows.length, rows: [] } } };
  });
  const request = (async (method: string, params: Record<string, unknown>) => {
    if (method !== "result.page" || params.result_id !== "m1") return (k.request as (m: string, p: unknown) => Promise<unknown>)(method, params);
    k.calls.push({ method, params });
    return { offset: 0, total: rows.length, rows: rows.slice(0, params.limit as number) };
  }) as RunDeps["request"];
  return { calls: k.calls, request };
}

describe("measure charts", () => {
  const money: NumberFormat = { style: "currency", currency: "BRL", decimals: 2 };
  const percent: NumberFormat = { style: "percent", decimals: 1 };
  const model: Model = {
    relationships: [],
    measures: [measure("revenue", { format: money }), measure("margin", { format: percent }), measure("units"), measure("stores_count", { datasets: ["stores"] })],
    calendars: [],
    params: [],
  };
  const stores: Dataset = { name: "stores", sql: "SELECT * FROM stores", params: {} };
  const BASE = "SELECT * FROM (\nSELECT * FROM sales\n) AS _d";
  const byRegion: ChartWidget = { ...chart, id: "measure1", measures: ["revenue"], spec: { kind: "bar", x: "region", y: [], agg: "sum" } };
  const renderModel = (widgets: Widget[], d: RunDeps, datasets = [sales], cross: { widget: string; value: string | number | boolean | null }[] = []) =>
    renderDashboard({ datasets, widgets, model: MODEL }, {}, d, cross);
  const drawn = (r: { widgets: Record<string, unknown> }, id: string) => r.widgets[id] as { kind: string; data: { columns: string[]; rows: unknown[]; truncated: boolean } };

  beforeEach(() => useCompiler(model));

  it("sends the compiled query over the dataset's query, with its parameters, allow list and history note, and reads the points with result.page", async () => {
    const k = measureKernel();
    const year: FilterWidget = { id: "param001", kind: "filter", control: "text", param: "year" };
    const needs: Dataset = { name: "sales", sql: "SELECT * FROM sales WHERE year = :year", params: {} };
    const r = await renderDashboard({ datasets: [needs], widgets: [byRegion, year], model: MODEL }, { param001: "2024" }, { ...deps(k.request), allow: ["main"] });
    const base = "SELECT * FROM (\nSELECT * FROM sales WHERE year = :year\n) AS _d";
    // compiled twice: the first only learns which datasets are read, so that they can be routed together
    expect(modelMock.query).toHaveBeenCalledTimes(2);
    expect(modelMock.query).toHaveBeenLastCalledWith(model, { source: expect.any(Function), x: { dataset: "sales", column: "region", as: "region" }, group: null, measures: ["revenue"], order: "value", limit: 101 });
    expect(runs(k).map((c) => c.params)).toEqual([
      { query: `MEASURES revenue BY region/null value 101 FROM ${base}`, source: "dashboard Sales", params: { year: "2024" }, param_types: { year: "text" }, allow: ["main"] },
    ]);
    expect(k.calls.map((c) => c.method)).toEqual(["sql.run", "result.page"]);
    expect(k.calls[1].params).toEqual({ result_id: "m1", offset: 0, limit: 101 });
    expect(r.widgets.measure1.kind).toBe("chart");
  });

  it("asks for the points a chart of that kind shows, plus one: ordered by x for lines and areas, by value for bars, pies and counters, with no x for a counter", async () => {
    const asked = async (spec: ChartWidget["spec"], measures = ["revenue"]) => {
      modelMock.query.mockClear();
      await renderModel([{ ...byRegion, spec, measures }], deps(measureKernel().request));
      return modelMock.query.mock.calls.at(-1)![1];
    };
    const base: Pick<ChartWidget["spec"], "y" | "agg"> = { y: [], agg: "sum" };
    const on = (column: string, dataset = "sales") => ({ dataset, column, as: column });
    expect(await asked({ ...base, kind: "line", x: "day", group: "region" })).toMatchObject({ x: on("day"), group: on("region"), order: "x", limit: 5001 });
    expect(await asked({ ...base, kind: "area", x: "day" })).toMatchObject({ x: on("day"), group: null, order: "x", limit: 5001 });
    expect(await asked({ ...base, kind: "pie", x: "region" })).toMatchObject({ x: on("region"), order: "value", limit: 101 });
    expect(await asked({ ...base, kind: "counter", x: "" }, ["revenue", "margin"])).toMatchObject({ x: null, measures: ["revenue", "margin"], order: "value", limit: 101 });
  });

  it("takes a x or a group written dataset.column as that dataset's column, and any other text as a column of the chart's dataset", async () => {
    modelMock.query.mockClear();
    const spec: ChartWidget["spec"] = { kind: "line", x: "stores.city", group: "region", y: [], agg: "sum" };
    await renderModel([{ ...byRegion, spec }], deps(measureKernel().request), [sales, stores]);
    expect(modelMock.query.mock.calls.at(-1)![1]).toMatchObject({
      x: { dataset: "stores", column: "city", as: "stores.city" },
      group: { dataset: "sales", column: "region", as: "region" },
    });
    // a dataset the dashboard does not have is part of a column's name
    modelMock.query.mockClear();
    await renderModel([{ ...byRegion, spec: { ...spec, x: "ghost.city" } }], deps(measureKernel().request), [sales, stores]);
    expect(modelMock.query.mock.calls.at(-1)![1]).toMatchObject({ x: { dataset: "sales", column: "ghost.city", as: "ghost.city" } });
  });

  it("answers with the compiled result's columns and rows, and never asks the kernel to chart", async () => {
    const k = measureKernel(rowsOf(2));
    const r = await renderModel([byRegion], deps(k.request));
    expect(r.widgets.measure1).toEqual({
      kind: "chart",
      data: { columns: ["region", "revenue", "margin"], rows: rowsOf(2), truncated: false },
      columns: resultColumns,
      formats: { revenue: money },
    });
    expect(k.calls.some((c) => c.method === "result.chart")).toBe(false);
  });

  it("cuts the points at the kernel's limit for the kind and says it did, and not before", async () => {
    const exact = drawn(await renderModel([byRegion], deps(measureKernel(rowsOf(100)).request)), "measure1");
    expect(exact.data).toMatchObject({ rows: rowsOf(100), truncated: false });
    const bars = drawn(await renderModel([byRegion], deps(measureKernel(rowsOf(101)).request)), "measure1");
    expect(bars.data).toMatchObject({ rows: rowsOf(100), truncated: true });
    const line: ChartWidget = { ...byRegion, spec: { kind: "line", x: "day", y: [], agg: "sum" } };
    const k = measureKernel(rowsOf(5001));
    const lines = drawn(await renderModel([line], deps(k.request)), "measure1");
    expect(lines.data.truncated).toBe(true);
    expect(lines.data.rows).toHaveLength(5000);
    expect(k.calls.find((c) => c.method === "result.page")?.params).toMatchObject({ limit: 5001 });
  });

  it("gives the number formats of the measures drawn that have one, and none when none has", async () => {
    const both = await renderModel([{ ...byRegion, measures: ["revenue", "margin", "units"] }], deps(measureKernel().request));
    expect(both.widgets.measure1).toMatchObject({ formats: { revenue: money, margin: percent } });
    expect((both.widgets.measure1 as { formats: object }).formats).not.toHaveProperty("units");
    const plain = await renderModel([{ ...byRegion, measures: ["units"] }], deps(measureKernel().request));
    expect(plain.widgets.measure1).not.toHaveProperty("formats");
  });

  it.each([["inf"], ["-inf"], ["nan"], [Number.POSITIVE_INFINITY], [Number.NaN]])("fails the chart that draws a measure holding %s, as a division by zero", async (bad) => {
    const k = measureKernel([["EU", 1, 0.5], ["US", 2, bad]]);
    const r = await renderModel([{ ...byRegion, measures: ["revenue", "margin"] }, { ...byRegion, id: "measure2" }], deps(k.request));
    expect(r.widgets.measure1).toEqual({ kind: "error", message: "division by zero in margin" });
    // a chart of the same result that does not draw margin is not bothered by it
    expect(r.widgets.measure2.kind).toBe("chart");
  });

  it("takes nulls, finite numbers and decimals as written as text, and an 'inf' in a column that is not a float as a value", async () => {
    const decimal = { name: "revenue", type: "decimal128(15, 2)" };
    const ok = await renderModel([{ ...byRegion, measures: ["revenue", "margin"] }], deps(measureKernel([["EU", 1, null], ["US", "1.50", 0]], [resultColumns[0], decimal, resultColumns[2]]).request));
    expect(ok.widgets.measure1.kind).toBe("chart");
    const text = await renderModel([byRegion], deps(measureKernel([["inf", "nan", 1]], [resultColumns[0], { name: "revenue", type: "string_view" }, resultColumns[2]]).request));
    expect(text.widgets.measure1.kind).toBe("chart");
  });

  it("makes a compile error the widget's error and runs nothing for it, leaving the other widgets alone", async () => {
    const k = measureKernel();
    const ghost: ChartWidget = { ...byRegion, id: "measure2", measures: ["ghost"] };
    const r = await renderModel([ghost, byRegion, chart], deps(k.request));
    expect(r.widgets.measure2).toEqual({ kind: "error", message: "there is no measure ghost" });
    expect(r.widgets.measure1.kind).toBe("chart");
    expect(r.widgets.chart001.kind).toBe("chart");
    expect(runs(k).map((c) => String(c.params.query).split(" ")[0])).toEqual(["SELECT", "MEASURES"]);
    // a viewer reads the plain error
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const viewer = await renderModel([ghost], deps(measureKernel().request, true));
    expect(viewer.widgets.measure2).toEqual({ kind: "error", message: HIDDEN_ERROR });
    expect(log).toHaveBeenCalledWith("dashboard widget measure2: there is no measure ghost");
  });

  it("leaves it to the compiler which datasets a chart's measures and groupings read, and asks for the source of each", async () => {
    const k = measureKernel();
    const r = await renderModel([{ ...byRegion, measures: ["stores_count"] }], deps(k.request), [sales, stores]);
    // stores_count is over stores, the grouping by region over sales (the chart's own)
    expect(runs(k).map((c) => c.params.query)).toEqual([`MEASURES stores_count BY region/null value 101 FROM SELECT * FROM (\nSELECT * FROM stores\n) AS _d + ${BASE}`]);
    expect(r.widgets.measure1.kind).toBe("chart");
  });

  it.each(["scatter", "histogram"] as const)("refuses a %s chart, without running anything", async (kind) => {
    const k = measureKernel();
    const r = await renderModel([{ ...byRegion, spec: { kind, x: "amount", y: [], agg: "count" } }], deps(k.request));
    expect(r.widgets.measure1).toEqual({ kind: "error", message: "measures work with bar, line, area, pie and counter charts" });
    expect(k.calls).toEqual([]);
    expect(modelMock.query).not.toHaveBeenCalled();
  });

  it("fails the chart with what the kernel says when its query fails, and with the placeholders that need a value without running anything", async () => {
    const error = { type: "error", ename: "SqlError", evalue: "no column amount", traceback: "" };
    const bad = measureKernel(rowsOf(1), resultColumns, () => error);
    expect((await renderModel([byRegion], deps(bad.request))).widgets.measure1).toEqual({ kind: "error", message: "SqlError: no column amount" });
    const needs: Dataset = { name: "sales", sql: "SELECT * FROM sales WHERE year = :year", params: {} };
    const k = measureKernel();
    const r = await renderModel([byRegion], deps(k.request), [needs]);
    expect(r.widgets.measure1).toEqual({ kind: "error", message: "needs a value for :year" });
    expect(k.calls).toEqual([]);
  });

  it("skips the dataset's own run when only measure charts use it, and shares one among the widgets that draw its rows", async () => {
    const only = measureKernel();
    await renderModel([byRegion, { ...byRegion, id: "measure2", measures: ["margin"] }], deps(only.request));
    expect(runs(only).map((c) => c.params.query)).toEqual([
      `MEASURES revenue BY region/null value 101 FROM ${BASE}`,
      `MEASURES margin BY region/null value 101 FROM ${BASE}`,
    ]);
    const mixed = measureKernel();
    const r = await renderModel([byRegion, chart, table, { ...table, id: "table002", dataset: "stores" }], deps(mixed.request), [sales, stores]);
    // the chart and the table share one run of sales, stores has its own, and the measure chart has a query of its own after them
    expect(runs(mixed).map((c) => c.params.query)).toEqual([BASE, "SELECT * FROM (\nSELECT * FROM stores\n) AS _d", `MEASURES revenue BY region/null value 101 FROM ${BASE}`]);
    expect([r.widgets.measure1.kind, r.widgets.chart001.kind, r.widgets.table001.kind, r.widgets.table002.kind]).toEqual(["chart", "chart", "table", "table"]);
    // a base run that fails does not take the measure charts with it
    const failing = measureKernel(rowsOf(2), resultColumns, undefined);
    const request = (async (method: string, params: { query?: string }) =>
      method === "sql.run" && !params.query?.startsWith("MEASURES")
        ? { type: "error", ename: "SqlError", evalue: "no table sales", traceback: "" }
        : (failing.request as (m: string, p: unknown) => Promise<unknown>)(method, params)) as unknown as RunDeps["request"];
    const partial = await renderModel([byRegion, chart], deps(request));
    expect(partial.widgets.chart001).toEqual({ kind: "error", message: "SqlError: no table sales" });
    expect(partial.widgets.measure1.kind).toBe("chart");
  });

  it("narrows other charts by its x and is narrowed by their picks, like any chart", async () => {
    const picked = measureKernel();
    await renderModel([chart, byRegion], deps(picked.request), [sales], [{ widget: "measure1", value: "EU" }]);
    // the picked measure chart narrows the other chart and draws the whole dataset itself
    expect(runs(picked).map((c) => [c.params.query, c.params.params])).toEqual([
      [`${BASE}\nWHERE CAST("region" AS VARCHAR) = :_c0`, { _c0: "EU" }],
      [`MEASURES revenue BY region/null value 101 FROM ${BASE}`, undefined],
    ]);
    const narrowed = measureKernel();
    await renderModel([chart, byRegion], deps(narrowed.request), [sales], [{ widget: "chart001", value: "EU" }]);
    expect(runs(narrowed).map((c) => [c.params.query, c.params.params])).toEqual([
      [BASE, undefined],
      [`MEASURES revenue BY region/null value 101 FROM ${BASE}\nWHERE CAST("region" AS VARCHAR) = :_c0`, { _c0: "EU" }],
    ]);
  });

  describe("on an extract", () => {
    const entry: ExtractEntry = { version: "20261028T231500Z-a1b2", rows: 2, bytes: 100, columns, sources: ["main.public.sales"], hash: datasetHash(sales), refreshed_at: 1 };
    const withExtract = (live: { request: RunDeps["request"] }, serving: { request: RunDeps["request"] }, allow: string[] | null): RunDeps => ({
      ...deps(live.request),
      allow,
      extracts: { manifest: { datasets: { sales: entry } }, serve: serving.request as never, url: (name, v) => `s3://bucket/${name}/${v}.parquet` },
    });
    const READ = "SELECT * FROM (\nSELECT * FROM read_parquet('s3://bucket/sales/20261028T231500Z-a1b2.parquet')\n) AS _d";

    it("sends the compiled query to the serving kernel, over the extract, with no allow list, and leaves the dashboard's kernel alone", async () => {
      const live = fakeKernel();
      const serving = measureKernel();
      const r = await renderModel([byRegion], withExtract(live, serving, ["main"]));
      expect(live.calls).toEqual([]);
      expect(runs(serving).map((c) => c.params.query)).toEqual([`MEASURES revenue BY region/null value 101 FROM ${READ}`]);
      expect(runs(serving)[0].params).not.toHaveProperty("allow");
      expect(serving.calls.map((c) => c.method)).toEqual(["sql.run", "result.page"]);
      expect(r.widgets.measure1.kind).toBe("chart");
    });

    it("fails the chart when the viewer may not read what the extract was built from", async () => {
      const serving = measureKernel();
      const r = await renderModel([byRegion], withExtract(fakeKernel(), serving, ["main.secret"]));
      expect(r.widgets.measure1).toEqual({ kind: "error", message: "no read grant on table main.public.sales" });
      expect(serving.calls).toEqual([]);
    });
  });

  it("checks the model once per render, with the columns of the datasets unknown, whatever the widgets draw, and an empty one only for a chart that draws measures", async () => {
    await renderModel([byRegion, { ...byRegion, id: "measure2", measures: ["margin"] }], deps(measureKernel().request), [sales, stores]);
    expect(modelMock.check.mock.calls).toEqual([[MODEL, { sales: null, stores: null }]]);
    // the relationships narrow every widget, so a dashboard with a model checks it even for a table
    modelMock.check.mockClear();
    await renderModel([chart, table], deps(fakeKernel().request));
    expect(modelMock.check.mock.calls).toEqual([[MODEL, { sales: null }]]);
    // a dashboard without a model has nothing to check, until a chart draws measures
    modelMock.check.mockClear();
    await renderDashboard({ datasets: [sales], widgets: [chart, table] }, {}, deps(fakeKernel().request));
    expect(modelMock.check).not.toHaveBeenCalled();
    await renderDashboard({ datasets: [sales], widgets: [byRegion] }, {}, deps(measureKernel().request));
    expect(modelMock.check.mock.calls).toEqual([["", { sales: null }]]);
  });

  it("leaves a chart with an empty list of measures to the kernel", async () => {
    const k = measureKernel();
    const r = await renderModel([{ ...byRegion, measures: [], spec: { ...byRegion.spec, y: ["amount"] } }], deps(k.request));
    expect(k.calls.some((c) => c.method === "result.chart")).toBe(true);
    expect(r.widgets.measure1.kind).toBe("chart");
    expect(modelMock.query).not.toHaveBeenCalled();
  });
});

describe("charts with values of their own", () => {
  const sales: Dataset = { name: "sales", sql: "SELECT * FROM sales", params: {} };
  const value = { name: "Sum of amount", dataset: "sales", column: "amount", agg: "sum" as const };
  const byRegion: ChartWidget = { ...chart, id: "values01", values: [value], spec: { kind: "bar", x: "region", y: [], agg: "sum" } };
  const render = (w: Widget[], d: RunDeps) => renderDashboard({ datasets: [sales], widgets: w, model: MODEL }, {}, d);

  it("asks the model for the value, as a measure of its name, without the kernel's aggregation", async () => {
    const k = measureKernel();
    await render([byRegion], deps(k.request));
    const [asked, q] = modelMock.query.mock.calls.at(-1)!;
    expect(q.measures).toEqual(["Sum of amount"]);
    expect(asked.measures[0]).toMatchObject({ name: "Sum of amount", datasets: ["sales"], atoms: [{ sql: 'SUM("amount")', agg: "sum" }] });
    expect(k.calls.some((c) => c.method === "result.chart")).toBe(false);
  });

  it("draws measures first, then values", async () => {
    await render([{ ...byRegion, measures: ["revenue"] }], deps(measureKernel().request));
    expect(modelMock.query.mock.calls.at(-1)![1].measures).toEqual(["revenue", "Sum of amount"]);
  });

  it("orders as the chart says", async () => {
    await render([{ ...byRegion, sort: "x_desc" }], deps(measureKernel().request));
    expect(modelMock.query.mock.calls.at(-1)![1].order).toBe("x_desc");
  });

  it("reads more rows for a legend or a matrix", async () => {
    await render([{ ...byRegion, spec: { ...byRegion.spec, group: "year" } }], deps(measureKernel().request));
    expect(modelMock.query.mock.calls.at(-1)![1].limit).toBe(2501);
    await render([{ ...byRegion, style: { look: "matrix" } }], deps(measureKernel().request));
    expect(modelMock.query.mock.calls.at(-1)![1].limit).toBe(2501);
  });

  it("keeps the first categories for a top", async () => {
    const k = measureKernel([["a", 3], ["b", 2], ["c", 1]], [{ name: "region", type: "string" }, { name: "Sum of amount", type: "double" }]);
    const r = await render([{ ...byRegion, top: 2 }], deps(k.request));
    const shown = r.widgets.values01;
    expect(shown.kind === "chart" && shown.data.rows.map((row) => row[0])).toEqual(["a", "b"]);
  });

  it("runs nothing for a chart still missing its fields, and reports no failure", async () => {
    const k = measureKernel();
    const r = await render([{ ...byRegion, values: undefined }, { ...byRegion, id: "values02", spec: { ...byRegion.spec, x: "" } }], deps(k.request));
    expect(r.widgets).toEqual({});
    expect(k.calls).toEqual([]);
  });
});

describe("filter propagation", () => {
  const set = (name: string, sql = `SELECT * FROM ${name}`): Dataset => ({ name, sql, params: {} });
  const [customers, products, categories, targets] = ["customers", "products", "categories", "targets"].map((n) => set(n));
  const all = [sales, customers, products, categories, targets];
  // sales and targets are facts; sales -> customers, sales -> products -> categories, targets -> products
  const shop: Model = {
    relationships: [rel("sales.customer_id", "customers.id"), rel("sales.product_id", "products.id"), rel("products.category_id", "categories.id"), rel("targets.product_id", "products.id")],
    measures: [measure("revenue"), measure("goal", { datasets: ["targets"] })],
    calendars: [],
    params: [],
  };
  const tableOn = (dataset: string): TableWidget => ({ id: `t_${dataset}`, kind: "table", dataset });
  const filterOn = (id: string, dataset: string, column: string): FilterWidget => ({ id, kind: "filter", control: "select", fields: [{ dataset, column }], value_type: "text" });
  const byCustomerRegion: ChartWidget = { id: "m_reg", kind: "chart", dataset: "sales", measures: ["revenue"], spec: { kind: "bar", x: "customers.region", y: [], agg: "sum" } };
  const byProduct: ChartWidget = { id: "m_prod", kind: "chart", dataset: "sales", measures: ["revenue"], spec: { kind: "bar", x: "products.name", y: [], agg: "sum" } };
  const renderShop = (widgets: Widget[], values: object, d: RunDeps, cross: { widget: string; value: string | number | boolean | null }[] = [], datasets = all) =>
    renderDashboard({ datasets, widgets, model: MODEL }, values as never, d, cross);

  /** a dataset's rows, and the same narrowed by `where` (the conditions, one per line) */
  const plain = (name: string) => `SELECT * FROM (\nSELECT * FROM ${name}\n) AS _d`;
  const narrowed = (name: string, ...where: string[]) => `${plain(name)}\nWHERE ${where.join("\n  AND ")}`;
  /** a condition on the relationship's columns, over another dataset's query (the n-th relationship of the dataset) */
  const within = (column: string, key: string, inner: string, n: number) => `"${column}" IN (SELECT "${key}" FROM (\n${inner}\n) AS _n${n})`;
  /** what the runs sent, without the filters' option lists */
  const sent = (k: { calls: Call[] }) =>
    runs(k)
      .filter((c) => !String(c.params.query).startsWith("SELECT DISTINCT"))
      .map((c) => ({ query: c.params.query, params: c.params.params }));

  beforeEach(() => useCompiler(shop));

  it("narrows a table on a fact through a semi-join, and the dimension itself with a plain condition, but not the filter's own options", async () => {
    const k = fakeKernel();
    const r = await renderShop([tableOn("sales"), tableOn("customers"), filterOn("f_reg", "customers", "region")], { f_reg: "EU" }, deps(k.request));
    expect(sent(k)).toEqual([
      { query: narrowed("sales", within("customer_id", "id", narrowed("customers", '"region" = :_f0'), 0)), params: { _f0: "EU" } },
      { query: narrowed("customers", '"region" = :_f0'), params: { _f0: "EU" } },
    ]);
    expect(runs(k)[2].params.query).toBe('SELECT DISTINCT "region" AS value FROM (\nSELECT * FROM customers\n) AS _d WHERE "region" IS NOT NULL ORDER BY 1 LIMIT 500');
    expect(runs(k)[0].params.param_types).toEqual({ _f0: "text" });
    expect([r.widgets.t_sales.kind, r.widgets.t_customers.kind]).toEqual(["table", "table"]);
  });

  it("narrows every kind of widget on the fact: a table and a chart share the run", async () => {
    const k = fakeKernel();
    const salesChart: ChartWidget = { ...chart, id: "c_sales" };
    await renderShop([tableOn("sales"), salesChart, filterOn("f_reg", "customers", "region")], { f_reg: "EU" }, deps(k.request));
    expect(sent(k)).toHaveLength(1);
    // the chart and the table read the one result (the filter's options are the other)
    expect(k.calls.filter((c) => c.method === "result.chart" || (c.method === "result.page" && c.params.limit === 100)).map((c) => c.params.result_id)).toEqual(["r1", "r1"]);
  });

  it("narrows through two levels (a snowflake), every fact that reaches the dimension, and the dimensions on the way", async () => {
    const k = fakeKernel();
    const widgets = [tableOn("sales"), tableOn("targets"), tableOn("products"), tableOn("customers"), filterOn("f_cat", "categories", "name")];
    await renderShop(widgets, { f_cat: "Toys" }, deps(k.request));
    const cat = narrowed("categories", '"name" = :_f0');
    const prod = narrowed("products", within("category_id", "id", cat, 0));
    expect(sent(k)).toEqual([
      { query: narrowed("sales", within("product_id", "id", prod, 1)), params: { _f0: "Toys" } },
      { query: narrowed("targets", within("product_id", "id", prod, 0)), params: { _f0: "Toys" } },
      { query: prod, params: { _f0: "Toys" } },
      // customers do not point at categories
      { query: plain("customers"), params: undefined },
    ]);
  });

  it("does not narrow a dimension by a filter on a fact, nor a fact by another", async () => {
    const k = fakeKernel();
    const widgets = [tableOn("sales"), tableOn("customers"), tableOn("products"), tableOn("targets"), filterOn("f_sales", "sales", "channel")];
    await renderShop(widgets, { f_sales: "web" }, deps(k.request));
    expect(sent(k)).toEqual([
      { query: narrowed("sales", '"channel" = :_f0'), params: { _f0: "web" } },
      { query: plain("customers"), params: undefined },
      { query: plain("products"), params: undefined },
      { query: plain("targets"), params: undefined },
    ]);
  });

  it("combines the filters of the fact and of its dimensions in one query, a name for each filter", async () => {
    const k = fakeKernel();
    const widgets = [tableOn("sales"), filterOn("f_reg", "customers", "region"), filterOn("f_chan", "sales", "channel"), filterOn("f_cat", "categories", "name")];
    await renderShop(widgets, { f_reg: "EU", f_chan: "web", f_cat: "Toys" }, deps(k.request));
    const prod = narrowed("products", within("category_id", "id", narrowed("categories", '"name" = :_f2'), 0));
    expect(sent(k)).toEqual([
      {
        query: narrowed("sales", '"channel" = :_f1', within("customer_id", "id", narrowed("customers", '"region" = :_f0'), 0), within("product_id", "id", prod, 1)),
        params: { _f0: "EU", _f1: "web", _f2: "Toys" },
      },
    ]);
  });

  it("narrows nothing from a dimension whose filters hold no value, and does not read it", async () => {
    const k = fakeKernel();
    await renderShop([tableOn("sales"), filterOn("f_reg", "customers", "region")], { f_reg: "" }, deps(k.request));
    expect(sent(k)).toEqual([{ query: plain("sales"), params: undefined }]);
  });

  it("makes no semi-join without relationships", async () => {
    useCompiler({ ...shop, relationships: [] });
    const k = fakeKernel();
    await renderShop([tableOn("sales"), filterOn("f_reg", "customers", "region")], { f_reg: "EU" }, deps(k.request));
    expect(sent(k)).toEqual([{ query: plain("sales"), params: undefined }]);
    // and a dashboard without a model has none to check
    modelMock.check.mockClear();
    const none = fakeKernel();
    await renderDashboard({ datasets: all, widgets: [tableOn("sales"), filterOn("f_reg", "customers", "region")] }, { f_reg: "EU" } as never, deps(none.request));
    expect(sent(none)).toEqual([{ query: plain("sales"), params: undefined }]);
    expect(modelMock.check).not.toHaveBeenCalled();
  });

  describe("picks", () => {
    const regionChart: ChartWidget = { ...chart, id: "c_region", dataset: "customers", spec: { kind: "bar", x: "region", y: ["n"], agg: "sum" } };
    const salesChart: ChartWidget = { ...chart, id: "c_sales" };

    it("of a measure chart grouped by a dimension's column narrow that dimension and the facts, not the chart itself", async () => {
      const k = measureKernel();
      const widgets = [tableOn("sales"), tableOn("customers"), tableOn("categories"), byCustomerRegion, byProduct];
      const r = await renderShop(widgets, {}, deps(k.request), [{ widget: "m_reg", value: "EU" }]);
      const eu = narrowed("customers", 'CAST("region" AS VARCHAR) = :_c0');
      const bySales = narrowed("sales", within("customer_id", "id", eu, 0));
      expect(sent(k)).toEqual([
        { query: bySales, params: { _c0: "EU" } },
        { query: eu, params: { _c0: "EU" } },
        // categories are not behind customers
        { query: plain("categories"), params: undefined },
        // the chart that was picked reads everything
        { query: `MEASURES revenue BY customers.region/null value 101 FROM ${plain("sales")} + ${plain("customers")}`, params: undefined },
        // the other measure chart is narrowed in sales, and reads products as they are
        { query: `MEASURES revenue BY products.name/null value 101 FROM ${bySales} + ${plain("products")}`, params: { _c0: "EU" } },
      ]);
      expect(Object.keys(r.widgets).sort()).toEqual(["m_prod", "m_reg", "t_categories", "t_customers", "t_sales"]);
    });

    it("of a chart on a dimension narrow the facts that point at it, and a fact's pick does not narrow its dimensions", async () => {
      const k = fakeKernel();
      await renderShop([tableOn("sales"), tableOn("customers"), regionChart, salesChart], {}, deps(k.request), [
        { widget: "c_region", value: "EU" },
        { widget: "c_sales", value: "US" },
      ]);
      // ids by chart id: c_region 0, c_sales 1
      const eu = narrowed("customers", 'CAST("region" AS VARCHAR) = :_c0');
      expect(sent(k)).toEqual([
        { query: narrowed("sales", 'CAST("region" AS VARCHAR) = :_c1', within("customer_id", "id", eu, 0)), params: { _c1: "US", _c0: "EU" } },
        { query: eu, params: { _c0: "EU" } },
        // the dimension's chart is not narrowed by itself, nor by the fact's pick
        { query: plain("customers"), params: undefined },
        // the fact's chart is narrowed by the dimension's pick only
        { query: narrowed("sales", within("customer_id", "id", eu, 0)), params: { _c0: "EU" } },
      ]);
    });

    it("have a name each, the same wherever it is read, so no name is bound to two values", async () => {
      const k = measureKernel();
      const byYear: ChartWidget = { ...chart, id: "a_year", spec: { kind: "bar", x: "year", y: ["amount"], agg: "sum" } };
      await renderShop([byYear, tableOn("sales"), tableOn("customers"), tableOn("products"), byCustomerRegion], {}, deps(k.request), [
        { widget: "a_year", value: 2024 },
        { widget: "m_reg", value: "EU" },
      ]);
      const bound = new Map<string, unknown>();
      for (const c of runs(k)) {
        for (const [name, v] of Object.entries((c.params.params ?? {}) as Record<string, unknown>)) {
          expect(bound.has(name) ? bound.get(name) : v).toEqual(v);
          bound.set(name, v);
        }
      }
      expect(Object.fromEntries(bound)).toEqual({ _c0: 2024, _c1: "EU" });
      // customers see the region pick only; products neither
      const customersRun = runs(k).find((c) => c.params.query === narrowed("customers", 'CAST("region" AS VARCHAR) = :_c1'));
      expect(customersRun?.params.params).toEqual({ _c1: "EU" });
      expect(runs(k).some((c) => c.params.query === plain("products"))).toBe(true);
    });

    it("let widgets on a dataset the picks cannot reach share one run", async () => {
      const k = fakeKernel();
      const r = await renderShop([tableOn("products"), { ...tableOn("products"), id: "t_products2" }, salesChart], {}, deps(k.request), [{ widget: "c_sales", value: "US" }]);
      expect(sent(k)).toEqual([{ query: plain("products"), params: undefined }, { query: plain("sales"), params: undefined }]);
      expect([r.widgets.t_products.kind, r.widgets.t_products2.kind]).toEqual(["table", "table"]);
    });
  });

  describe("measure charts", () => {
    const two: ChartWidget = { id: "m_two", kind: "chart", dataset: "sales", measures: ["revenue", "goal"], spec: { kind: "bar", x: "products.name", y: [], agg: "sum" } };

    it("with two facts ask for the source of each (and of the dimension), narrowed alike, and merge their parameters", async () => {
      const k = measureKernel();
      const r = await renderShop([two, filterOn("f_reg", "customers", "region"), filterOn("f_cat", "categories", "name")], { f_reg: "EU", f_cat: "Toys" }, deps(k.request));
      expect(r.widgets.m_two.kind).toBe("chart");
      const cat = narrowed("categories", '"name" = :_f1');
      const prod = narrowed("products", within("category_id", "id", cat, 0));
      expect(sent(k)).toEqual([
        {
          query: `MEASURES revenue,goal BY products.name/null value 101 FROM ${narrowed("sales", within("customer_id", "id", narrowed("customers", '"region" = :_f0'), 0), within("product_id", "id", prod, 1))} + ${narrowed("targets", within("product_id", "id", prod, 0))} + ${prod}`,
          // _f1 is read three times, as the same value
          params: { _f0: "EU", _f1: "Toys" },
        },
      ]);
      expect(runs(k)[0].params.param_types).toEqual({ _f0: "text", _f1: "text" });
    });

    it("fail when a dataset they read lacks the value of a placeholder, and not before they need it", async () => {
      const needs = set("customers", "SELECT * FROM customers WHERE year = :year");
      const k = measureKernel();
      const datasets = [sales, needs, products, categories, targets];
      const r = await renderShop([byCustomerRegion, byProduct, tableOn("categories")], {}, deps(k.request), [], datasets);
      expect(r.widgets.m_reg).toEqual({ kind: "error", message: "needs a value for :year" });
      expect(r.widgets.m_prod.kind).toBe("chart");
      expect(r.widgets.t_categories.kind).toBe("table");
    });

    it("tell the author what the compiler noted, and a viewer nothing", async () => {
      useCompiler(shop, ["goal repeats its total by customers.region"]);
      const editor = await renderShop([byCustomerRegion], {}, deps(measureKernel().request));
      expect(editor.widgets.m_reg).toMatchObject({ kind: "chart", notes: ["goal repeats its total by customers.region"] });
      const viewer = await renderShop([byCustomerRegion], {}, deps(measureKernel().request, true));
      expect(viewer.widgets.m_reg.kind).toBe("chart");
      expect(viewer.widgets.m_reg).not.toHaveProperty("notes");
      // no notes, no key
      useCompiler(shop, []);
      expect((await renderShop([byCustomerRegion], {}, deps(measureKernel().request))).widgets.m_reg).not.toHaveProperty("notes");
    });
  });

  describe("on extracts", () => {
    const entryFor = (d: Dataset, over: Partial<ExtractEntry> = {}): ExtractEntry => ({
      version: "20261028T231500Z-a1b2",
      rows: 2,
      bytes: 100,
      columns,
      sources: [`main.public.${d.name}`],
      hash: datasetHash(d),
      refreshed_at: 1,
      ...over,
    });
    /** extracts of `fresh` (a name in `over` changes its entry), none for the rest */
    const extractsOf = (live: { request: RunDeps["request"] }, serving: { request: RunDeps["request"] }, fresh: Dataset[], over: Record<string, Partial<ExtractEntry>> = {}, allow: string[] | null = ["main"]): RunDeps => ({
      ...deps(live.request),
      allow,
      extracts: { manifest: { datasets: Object.fromEntries(fresh.map((d) => [d.name, entryFor(d, over[d.name])])) }, serve: serving.request as never, url: (name, v) => `s3://bucket/${name}/${v}.parquet` },
    });
    const read = (name: string) => `SELECT * FROM (\nSELECT * FROM read_parquet('s3://bucket/${name}/20261028T231500Z-a1b2.parquet')\n) AS _d`;
    const f_reg = filterOn("f_reg", "customers", "region");

    it("run on the serving kernel when every dataset the query reads has a fresh extract, each read from its own", async () => {
      const live = fakeKernel();
      const serving = fakeKernel();
      await renderShop([tableOn("sales"), f_reg], { f_reg: "EU" }, extractsOf(live, serving, [sales, customers]));
      expect(live.calls).toEqual([]);
      const customersRead = `${read("customers")}\nWHERE "region" = :_f0`;
      expect(sent(serving)).toEqual([{ query: `${read("sales")}\nWHERE ${within("customer_id", "id", customersRead, 0)}`, params: { _f0: "EU" } }]);
      expect(serving.calls.filter((c) => c.method === "sql.run").every((c) => !("allow" in c.params))).toBe(true);
    });

    it("run the whole query live, every dataset from its own SQL, when one of them has no fresh extract", async () => {
      const live = fakeKernel();
      const serving = fakeKernel();
      // customers was built from another definition
      await renderShop([tableOn("sales"), f_reg], { f_reg: "EU" }, extractsOf(live, serving, [sales, customers], { customers: { hash: "old" } }));
      expect(serving.calls).toEqual([]);
      expect(sent(live)).toEqual([{ query: narrowed("sales", within("customer_id", "id", narrowed("customers", '"region" = :_f0'), 0)), params: { _f0: "EU" } }]);
      expect(runs(live).map((c) => c.params.allow)).toEqual([["main"], ["main"]]);
    });

    it("decide for each query on its own: what reads a stale dataset goes live, the rest to the serving kernel", async () => {
      const live = fakeKernel();
      const serving = fakeKernel();
      const d = extractsOf(live, serving, [sales, products, categories, targets], {});
      const r = await renderShop([tableOn("sales"), tableOn("products"), tableOn("customers"), f_reg], { f_reg: "EU" }, d);
      // sales reads customers (live), products reads itself (an extract), customers and the filter's options are live
      expect(sent(live).map((c) => String(c.query).includes("read_parquet"))).toEqual([false, false]);
      expect(sent(serving)).toEqual([{ query: read("products"), params: undefined }]);
      expect(runs(live)).toHaveLength(3);
      expect(Object.values(r.widgets).map((w) => w.kind).sort()).toEqual(["filter", "table", "table", "table"]);
    });

    it("send a measure chart to the serving kernel only when all the datasets it reads are fresh", async () => {
      const two: ChartWidget = { id: "m_two", kind: "chart", dataset: "sales", measures: ["revenue", "goal"], spec: { kind: "bar", x: "products.name", y: [], agg: "sum" } };
      const fresh = measureKernel();
      const liveOnly = fakeKernel();
      await renderShop([two], {}, extractsOf(liveOnly, fresh, [sales, targets, products]));
      expect(liveOnly.calls).toEqual([]);
      expect(runs(fresh).map((c) => c.params.query)).toEqual([`MEASURES revenue,goal BY products.name/null value 101 FROM ${read("sales")} + ${read("targets")} + ${read("products")}`]);
      // targets without an extract: one kernel runs all of it
      const live = measureKernel();
      const serving = fakeKernel();
      await renderShop([two], {}, extractsOf(live, serving, [sales, products]));
      expect(serving.calls).toEqual([]);
      expect(runs(live).map((c) => c.params.query)).toEqual([`MEASURES revenue,goal BY products.name/null value 101 FROM ${plain("sales")} + ${plain("targets")} + ${plain("products")}`]);
      expect(runs(live)[0].params.allow).toEqual(["main"]);
    });

    it("fail the query that reads a source the viewer may not, and only that one", async () => {
      const live = fakeKernel();
      const serving = fakeKernel();
      const d = extractsOf(live, serving, all, { customers: { sources: ["main.secret.customers"] } }, ["main.public"]);
      const r = await renderShop([tableOn("sales"), tableOn("categories"), f_reg], { f_reg: "EU" }, d);
      const lost = { kind: "error", message: "no read grant on table main.secret.customers" };
      expect(r.widgets.t_sales).toEqual(lost);
      expect(r.widgets.f_reg).toEqual(lost);
      expect(r.widgets.t_categories.kind).toBe("table");
      // a stale dataset in the query does not hide it
      const stale = await renderShop([tableOn("sales"), f_reg], { f_reg: "EU" }, extractsOf(fakeKernel(), serving, [customers, products], { customers: { sources: ["main.secret.customers"] } }, ["main.public"]));
      expect(stale.widgets.t_sales).toEqual(lost);
    });

    it("compile a recipe once for all the queries that read it", async () => {
      const recipe = recipeOf("products", "main.products");
      const live = fakeKernel();
      const datasets = [sales, customers, recipe, categories, targets];
      const r = await renderShop([tableOn("products"), tableOn("sales"), byProduct, filterOn("f_cat", "categories", "name")], { f_cat: "Toys" }, deps(live.request), [], datasets);
      expect(live.calls.filter((c) => c.method === "wrangle.sql")).toHaveLength(1);
      expect([r.widgets.t_products.kind, r.widgets.t_sales.kind]).toEqual(["table", "table"]);
    });
  });
  describe("calendars, what a measure asks for without, and parameters", () => {
    const dates: Calendar = { name: "dates", columns: [{ dataset: "sales", column: "sold_at" }, { dataset: "targets", column: "goal_date" }], span };
    const dated: Model = { ...shop, relationships: [...shop.relationships, rel("sales.sold_at", "dates.date", "date"), rel("targets.goal_date", "dates.date", "date")], calendars: [dates] };
    const byMonth: ChartWidget = { id: "m_month", kind: "chart", dataset: "sales", measures: ["revenue"], spec: { kind: "line", x: "dates.month", y: [], agg: "sum" } };
    const byChannel: ChartWidget = { id: "m_chan", kind: "chart", dataset: "sales", measures: ["revenue"], spec: { kind: "bar", x: "channel", y: [], agg: "sum" } };
    const dateFilter = (id: string, column: string): FilterWidget => ({ id, kind: "filter", control: "date_range", fields: [{ dataset: "dates", column }] });

    /** the calendar's rows as the stand-in builds them from its sources, read as `read` says; the narrowing wraps them as `SELECT * FROM (rows) AS _d` */
    const rowsFrom = (read: (name: string) => string) =>
      `SELECT "date" FROM (SELECT "sold_at" AS "date" FROM (${read("sales")}) AS _s UNION SELECT "goal_date" AS "date" FROM (${read("targets")}) AS _s) AS dates`;
    const rows = rowsFrom(plain);
    const calendar = `SELECT * FROM (\n${rows}\n) AS _d`;
    /** a condition on the sales' date column, over the calendar narrowed by `where` */
    const throughDates = (where: string) => `CAST("sold_at" AS DATE) IN (SELECT "date" FROM (\n${calendar}\nWHERE ${where}\n) AS _n2)`;
    const january = { f_date: { from: "2024-01-01", to: "2024-01-31" } };
    const inJanuary = 'CAST("date" AS DATE) >= :_f0_from\n  AND CAST("date" AS DATE) <= :_f0_to';
    const januaryParams = { _f0_from: "2024-01-01", _f0_to: "2024-01-31" };

    /** extracts of the datasets in `fresh`, each read from `s3://bucket/<name>/v1.parquet` */
    const extractsFor = (live: { request: RunDeps["request"] }, serving: { request: RunDeps["request"] }, fresh: Dataset[], allow: string[] | null = ["main"]): RunDeps => ({
      ...deps(live.request),
      allow,
      extracts: {
        manifest: {
          datasets: Object.fromEntries(
            fresh.map((d) => [d.name, { version: "v1", rows: 2, bytes: 100, columns, sources: [`main.public.${d.name}`], hash: datasetHash(d), refreshed_at: 1 } satisfies ExtractEntry]),
          ),
        },
        serve: serving.request as never,
        url: (name, v) => `s3://bucket/${name}/${v}.parquet`,
      },
    });

    describe("a calendar", () => {
      beforeEach(() => useCompiler(dated));

      it("is a dataset a chart can group by: its rows are the unfiltered rows of its sources, and the model is checked without it among the datasets", async () => {
        const k = measureKernel();
        const r = await renderShop([byMonth], {}, deps(k.request));
        expect(modelMock.query).toHaveBeenLastCalledWith(dated, expect.objectContaining({ x: { dataset: "dates", column: "month", as: "dates.month" }, group: null, order: "x" }));
        expect(sent(k)).toEqual([{ query: `MEASURES revenue BY dates.month/null x 5001 FROM ${plain("sales")} + ${calendar}`, params: undefined }]);
        expect(modelMock.check.mock.calls).toEqual([[MODEL, { sales: null, customers: null, products: null, categories: null, targets: null }]]);
        expect(r.widgets.m_month.kind).toBe("chart");
        // a text that is not a dataset or a calendar is a column of the chart's own dataset
        modelMock.query.mockClear();
        await renderShop([{ ...byMonth, spec: { ...byMonth.spec, x: "ghost.month" } }], {}, deps(measureKernel().request));
        expect(modelMock.query.mock.calls.at(-1)![1]).toMatchObject({ x: { dataset: "sales", column: "ghost.month" } });
      });

      it("narrows the facts that point at it with a filter on its columns: the date column compared as a DATE, in tables and measure charts", async () => {
        const k = measureKernel();
        await renderShop([tableOn("sales"), byMonth, dateFilter("f_date", "date")], january, deps(k.request));
        const bySales = narrowed("sales", throughDates(inJanuary));
        const inCalendar = `${calendar}\nWHERE ${inJanuary}`;
        expect(sent(k)).toEqual([
          { query: bySales, params: januaryParams },
          // the calendar is narrowed by its own filter too, and the facts through it
          { query: `MEASURES revenue BY dates.month/null x 5001 FROM ${bySales} + ${inCalendar}`, params: januaryParams },
        ]);
        expect(runs(k)[0].params.param_types).toEqual({ _f0_from: "date", _f0_to: "date" });
      });

      it("narrows the facts and the other charts with the pick on its column, and not the chart that was picked", async () => {
        const k = measureKernel();
        await renderShop([tableOn("sales"), byMonth], {}, deps(k.request), [{ widget: "m_month", value: "2024-03-01" }]);
        expect(sent(k)).toEqual([
          { query: narrowed("sales", throughDates('CAST("month" AS VARCHAR) = :_c0')), params: { _c0: "2024-03-01" } },
          { query: `MEASURES revenue BY dates.month/null x 5001 FROM ${plain("sales")} + ${calendar}`, params: undefined },
        ]);
      });

      it("lists the values of its column for a filter, over its whole rows", async () => {
        const k = fakeKernel();
        const year = dateFilter("f_year", "year");
        const r = await renderShop([year, tableOn("sales")], { f_year: { from: "2024-01-01" } }, deps(k.request));
        expect(runs(k).map((c) => c.params.query).at(-1)).toBe(`SELECT DISTINCT "year" AS value FROM (\n${rows}\n) AS _d WHERE "year" IS NOT NULL ORDER BY 1 LIMIT 500`);
        expect(r.widgets.f_year).toEqual({ kind: "filter", options: ["EU", "US"] });
        // a calendar the model does not have is not a dataset either
        const lost = await renderShop([{ ...year, fields: [{ dataset: "ghost", column: "year" }] }], {}, deps(fakeKernel().request));
        expect(lost.widgets.f_year).toEqual({ kind: "error", message: "there is no dataset ghost" });
      });

      it("reads its sources, so a query that reads it runs on the serving kernel only when all of them have a fresh extract", async () => {
        const parquet = (name: string) => `SELECT * FROM (\nSELECT * FROM read_parquet('s3://bucket/${name}/v1.parquet')\n) AS _d`;
        const fresh = measureKernel();
        const liveOnly = fakeKernel();
        const r = await renderShop([byMonth, dateFilter("f_date", "date")], january, extractsFor(liveOnly, fresh, [sales, targets]));
        expect(liveOnly.calls).toEqual([]);
        const inCalendar = `SELECT * FROM (\n${rowsFrom(parquet)}\n) AS _d\nWHERE ${inJanuary}`;
        const throughCalendar = `CAST("sold_at" AS DATE) IN (SELECT "date" FROM (\n${inCalendar}\n) AS _n2)`;
        expect(sent(fresh)).toEqual([{ query: `MEASURES revenue BY dates.month/null x 5001 FROM ${parquet("sales")}\nWHERE ${throughCalendar} + ${inCalendar}`, params: januaryParams }]);
        expect(runs(fresh)[0].params).not.toHaveProperty("allow");
        expect(r.widgets.m_month.kind).toBe("chart");

        // targets has no extract: the whole query is live
        const live = measureKernel();
        const serving = fakeKernel();
        await renderShop([byMonth, dateFilter("f_date", "date")], january, extractsFor(live, serving, [sales]));
        expect(serving.calls).toEqual([]);
        expect(sent(live)[0].query).toContain(plain("targets"));
        expect(sent(live)[0].query).not.toContain("read_parquet");
        expect(runs(live)[0].params.allow).toEqual(["main"]);

        // the options of a calendar column go the same way
        const options = fakeKernel();
        await renderShop([dateFilter("f_year", "year")], {}, extractsFor(fakeKernel(), options, [sales, targets]));
        expect(runs(options).map((c) => c.params.query)).toEqual([`SELECT DISTINCT "year" AS value FROM (\n${rowsFrom(parquet)}\n) AS _d WHERE "year" IS NOT NULL ORDER BY 1 LIMIT 500`]);
      });

      it("needs the viewer to read what its sources were built from", async () => {
        const r = await renderShop([byMonth, dateFilter("f_year", "year")], {}, extractsFor(measureKernel(), measureKernel(), [sales, targets], ["main.public.sales"]));
        const lost = { kind: "error", message: "no read grant on table main.public.targets" };
        expect(r.widgets.m_month).toEqual(lost);
        expect(r.widgets.f_year).toEqual(lost);
      });
    });

    describe("a measure that asks for a dataset without some filters", () => {
      const customersEU = { f_reg: "EU", f_tier: "gold" };
      const filters = [filterOn("f_reg", "customers", "region"), filterOn("f_tier", "customers", "tier")];
      const salesWithout = (ignore: Ignore) => useCompiler(shop, [], { ignore: (d) => (d === "sales" ? ignore : undefined) });

      it("reads the dataset whole of what the ignore names, and narrowed as usual otherwise", async () => {
        const asked = (k: { calls: Call[] }) => sent(k).map((c) => c.query);
        useCompiler(shop);
        const usual = measureKernel();
        await renderShop([byChannel, ...filters], customersEU, deps(usual.request));
        const customers = narrowed("customers", '"region" = :_f0', '"tier" = :_f1');
        expect(asked(usual)).toEqual([`MEASURES revenue BY channel/null value 101 FROM ${narrowed("sales", within("customer_id", "id", customers, 0))}`]);

        // the customers' filters do not apply to the sales this measure reads, and their parameters are not sent
        salesWithout({ datasets: ["customers"], columns: [] });
        const without = measureKernel();
        await renderShop([byChannel, ...filters], customersEU, deps(without.request));
        expect(sent(without)).toEqual([{ query: `MEASURES revenue BY channel/null value 101 FROM ${plain("sales")}`, params: undefined }]);
      });

      it("drops the filters on the columns it names only: the others still narrow, by the names they always have", async () => {
        salesWithout({ datasets: [], columns: [{ dataset: "customers", column: "region" }] });
        const k = measureKernel();
        await renderShop([byChannel, ...filters], customersEU, deps(k.request));
        expect(sent(k)).toEqual([
          { query: `MEASURES revenue BY channel/null value 101 FROM ${narrowed("sales", within("customer_id", "id", narrowed("customers", '"tier" = :_f1'), 0))}`, params: { _f1: "gold" } },
        ]);
      });

      it("takes the picks off too", async () => {
        salesWithout({ datasets: ["customers"], columns: [] });
        const k = measureKernel();
        const regionChart: ChartWidget = { id: "c_region", kind: "chart", dataset: "customers", spec: { kind: "bar", x: "region", y: ["n"], agg: "sum" } };
        await renderShop([byChannel, regionChart], {}, deps(k.request), [{ widget: "c_region", value: "EU" }]);
        expect(sent(k).find((c) => String(c.query).startsWith("MEASURES"))).toEqual({ query: `MEASURES revenue BY channel/null value 101 FROM ${plain("sales")}`, params: undefined });
      });

      it("is routed by what it reads: a dataset it leaves out does not need a fresh extract", async () => {
        // customers has no extract: the usual query reads it, and goes live; the one that leaves it out stays on the serving kernel
        useCompiler(shop);
        const usualLive = measureKernel();
        const usualServing = fakeKernel();
        await renderShop([byChannel, ...filters], customersEU, extractsFor(usualLive, usualServing, [sales]));
        expect(usualServing.calls).toEqual([]);
        expect(runs(usualLive).some((c) => String(c.params.query).startsWith("MEASURES"))).toBe(true);

        salesWithout({ datasets: ["customers"], columns: [] });
        const live = fakeKernel();
        const serving = measureKernel();
        const r = await renderShop([byChannel, ...filters], customersEU, extractsFor(live, serving, [sales]));
        expect(live.calls.filter((c) => c.method === "sql.run" && !String(c.params.query).startsWith("SELECT DISTINCT"))).toEqual([]);
        expect(runs(serving).map((c) => c.params.query)).toEqual([`MEASURES revenue BY channel/null value 101 FROM SELECT * FROM (\nSELECT * FROM read_parquet('s3://bucket/sales/v1.parquet')\n) AS _d`]);
        expect(r.widgets.m_chan.kind).toBe("chart");
      });
    });

    describe("the parameters of measures", () => {
      const discount: Param = { name: "discount", default: 0.1, span };
      const label: Param = { name: "label", default: "gross", span };
      const setDiscount: FilterWidget = { id: "p_disc", kind: "filter", control: "text", param: "discount" };
      const setLabel: FilterWidget = { id: "p_label", kind: "filter", control: "text", param: "label" };
      const bound = (k: { calls: Call[] }) => [runs(k)[0].params.params, runs(k)[0].params.param_types];

      beforeEach(() => useCompiler(shop, [], { params: [discount, label] }));

      it("take their default, a number for a number and text for text", async () => {
        const k = measureKernel();
        await renderShop([byChannel], {}, deps(k.request));
        expect(bound(k)).toEqual([{ discount: 0.1, label: "gross" }, { discount: "number", label: "text" }]);
      });

      it("take the value of the filter that sets them, and the default when it holds none", async () => {
        const k = measureKernel();
        await renderShop([byChannel, setDiscount, setLabel], { p_disc: "0.25", p_label: "net" }, deps(k.request));
        expect(bound(k)).toEqual([{ discount: 0.25, label: "net" }, { discount: "number", label: "text" }]);
        const empty = measureKernel();
        await renderShop([byChannel, setDiscount, setLabel], { p_disc: "", p_label: "" }, deps(empty.request));
        expect(bound(empty)).toEqual([{ discount: 0.1, label: "gross" }, { discount: "number", label: "text" }]);
      });

      it("join the parameters of the filters and of the datasets the query reads", async () => {
        const k = measureKernel();
        await renderShop([byChannel, filterOn("f_reg", "customers", "region"), setDiscount], { f_reg: "EU", p_disc: "0.25" }, deps(k.request));
        expect(runs(k)[0].params.params).toEqual({ _f0: "EU", discount: 0.25, label: "gross" });
      });

      it("fail the chart when the filter's value is not a number for a number, and run nothing", async () => {
        const k = measureKernel();
        const r = await renderShop([byChannel, setDiscount, tableOn("customers")], { p_disc: "a lot" }, deps(k.request));
        expect(r.widgets.m_chan).toEqual({ kind: "error", message: ":discount must be a number" });
        expect(r.widgets.t_customers.kind).toBe("table");
        expect(runs(k).some((c) => String(c.params.query).startsWith("MEASURES"))).toBe(false);
      });

      it("fail the chart when a dataset it reads binds the same name to another value or type, and not when it is the same", async () => {
        const reads = (spec: object) => [set("sales", "SELECT * FROM sales WHERE d = :discount"), customers, products, categories, targets].map((d) => (d.name === "sales" ? { ...d, params: { discount: spec } } : d)) as Dataset[];
        const k = measureKernel();
        // a text placeholder against a number
        const text = await renderShop([byChannel, setDiscount], { p_disc: "0.25" }, deps(k.request), [], reads({ type: "text" }));
        expect(text.widgets.m_chan).toEqual({ kind: "error", message: ":discount is bound to two different values in one query" });
        expect(k.calls).toEqual([]);
        // the same type, and the same value (the filter's, or both defaults)
        const same = measureKernel();
        const ok = await renderShop([byChannel, setDiscount], { p_disc: "0.25" }, deps(same.request), [], reads({ type: "number" }));
        expect(ok.widgets.m_chan.kind).toBe("chart");
        expect(runs(same)[0].params.params).toEqual({ discount: 0.25, label: "gross" });
        const defaults = measureKernel();
        expect((await renderShop([byChannel], {}, deps(defaults.request), [], reads({ type: "number", default: 0.1 }))).widgets.m_chan.kind).toBe("chart");
        // two defaults that differ
        const apart = await renderShop([byChannel], {}, deps(measureKernel().request), [], reads({ type: "number", default: 0.2 }));
        expect(apart.widgets.m_chan).toEqual({ kind: "error", message: ":discount is bound to two different values in one query" });
      });

      it("send nothing for a measure without parameters", async () => {
        useCompiler(shop);
        const k = measureKernel();
        await renderShop([byChannel], {}, deps(k.request));
        expect(runs(k)[0].params.params).toBeUndefined();
      });
    });
  });
});

describe("explainDatasets", () => {
  /** a kernel that plans what it is asked, or refuses every plan with `fail` */
  function explainKernel(fail?: string) {
    const calls: Call[] = [];
    const request = (async (method: string, params: Record<string, unknown>) => {
      calls.push({ method, params });
      if (method === "sql.explain" && fail) throw new Error(fail);
      if (method === "wrangle.sql") return { sql: `SELECT * FROM ${(params.source as { table: string }).table}` };
      return { plan: {}, text: "" };
    }) as RunDeps["request"];
    return { calls, request };
  }

  it("explains each dataset with neutral values for the placeholders without a usable default, and the allow list", async () => {
    const typed: Dataset = {
      name: "sales",
      sql: "SELECT * FROM sales WHERE n > :n AND d > :d AND b = :b AND s = :s AND t = :t AND keep = :keep",
      params: {
        n: { type: "number" },
        d: { type: "date" },
        b: { type: "boolean" },
        s: { type: "select", options: ["a", "b"] },
        t: { type: "text" },
        keep: { type: "text", default: "k" },
      },
    };
    const k = explainKernel();
    expect(await explainDatasets([typed, recipeOf("stores", "main.stores")], { request: k.request, allow: [] })).toEqual([]);
    expect(k.calls.filter((c) => c.method === "sql.explain").map((c) => c.params)).toEqual([
      {
        query: `SELECT * FROM (\n${typed.sql}\n) AS _d`,
        params: { n: 0, d: "2000-01-01", b: false, s: "a", t: "x", keep: "k" },
        param_types: { n: "number", d: "date", b: "boolean", s: "select", t: "text", keep: "text" },
        allow: [],
      },
      { query: "SELECT * FROM (\nSELECT * FROM main.stores\n) AS _d", allow: [] },
    ]);
    const unchecked = explainKernel();
    await explainDatasets([recipeOf("stores", "main.stores")], { request: unchecked.request, allow: null });
    expect(unchecked.calls.find((c) => c.method === "sql.explain")?.params).not.toHaveProperty("allow");
  });

  it("reports each dataset the kernel refuses with its message, and a dataset that is not one query without asking the kernel", async () => {
    const refused = explainKernel("no read grant on table main.secret.orders");
    expect(await explainDatasets([sales, recipeOf("stores", "main.stores")], { request: refused.request, allow: ["main.sales"] })).toEqual([
      "dataset sales: no read grant on table main.secret.orders",
      "dataset stores: no read grant on table main.secret.orders",
    ]);
    const k = explainKernel();
    expect(await explainDatasets([{ ...sales, sql: "SELECT 1; SELECT 2" }], { request: k.request, allow: [] })).toEqual(["dataset sales: a dataset holds one query"]);
    expect(k.calls.filter((c) => c.method === "sql.explain")).toEqual([]);
  });
});

describe("withSql", () => {
  it("compiles a recipe on the kernel, and leaves a SQL or a compiled dataset as it is", async () => {
    const k = fakeKernel();
    expect(await withSql(recipeOf("sales", "main.sales"), k.request)).toEqual({ ...recipeOf("sales", "main.sales"), sql: "SELECT * FROM main.sales" });
    const compiled = { ...recipeOf("sales", "main.sales"), sql: "SELECT 1" };
    expect(await withSql(compiled, k.request)).toBe(compiled);
    expect(await withSql(sales, k.request)).toBe(sales);
    expect(k.calls.map((c) => c.method)).toEqual(["wrangle.sql"]);
  });
});
