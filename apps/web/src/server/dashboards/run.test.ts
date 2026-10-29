import { afterEach, describe, expect, it, vi } from "vitest";

import type { ExtractEntry } from "@/lib/dashboards/extracts";
import type { ChartWidget, Dataset, FilterWidget, TableWidget, Widget } from "@/lib/dashboards/types";

import { datasetHash } from "./extractStore";
import { explainDatasets, HIDDEN_ERROR, renderDashboard, withSql, type RunDeps } from "./run";

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
        { query: 'SELECT * FROM (\nSELECT * FROM sales\n) AS _d\nWHERE "year" = :_c0', params: { _c0: 2024 } },
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
