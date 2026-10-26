import { describe, expect, it } from "vitest";

import { canPick, checkPicks, datasetQuery, filterValueProblem, optionsQuery, paramValuesOf, pickableIds, quoteIdent } from "./query";
import type { ChartWidget, Dataset, FilterWidget, Widget } from "./types";

const sales: Dataset = { name: "sales", sql: "SELECT * FROM sales;", params: {} };

function filter(f: Partial<FilterWidget>): FilterWidget {
  return { id: "f1", kind: "filter", control: "select", fields: [{ dataset: "sales", column: "region" }], value_type: "text", ...f };
}

/** the query, or a failure of the test */
function run(dataset: Dataset, filters: FilterWidget[], values: Record<string, never> | object = {}, paramValues = {}) {
  const q = datasetQuery(dataset, filters, values as never, paramValues);
  if ("missing" in q) throw new Error(`missing ${q.missing.join(", ")}`);
  return q;
}

describe("datasetQuery: the dataset", () => {
  it("wraps one statement as a subquery and strips its `;`", () => {
    expect(run(sales, [])).toEqual({ query: "SELECT * FROM (\nSELECT * FROM sales\n) AS _d", params: {} });
  });

  it("puts a trailing comment on a line of its own so it cannot swallow the `)`", () => {
    const q = run({ ...sales, sql: "SELECT 1 -- the one" }, []);
    expect(q.query).toBe("SELECT * FROM (\nSELECT 1 -- the one\n) AS _d");
  });

  it("holds exactly one query", () => {
    expect(() => run({ ...sales, sql: "SELECT 1; DELETE FROM sales" }, [])).toThrow("a dataset holds one query");
    expect(() => run({ ...sales, sql: "-- nothing" }, [])).toThrow("a dataset holds one query");
    expect(() => run({ ...sales, sql: "" }, [])).toThrow("a dataset holds one query");
  });

  it("keeps a `;` inside a string", () => {
    expect(run({ ...sales, sql: "SELECT 'a;b' AS x" }, []).query).toContain("'a;b'");
  });

  it("resolves its own placeholders: the viewer's value, else the default, else it is missing", () => {
    const d: Dataset = { name: "sales", sql: "SELECT * FROM sales WHERE year = :year", params: { year: { type: "number", default: 2024 } } };
    expect(run(d, []).params).toEqual({ params: { year: 2024 }, param_types: { year: "number" } });
    expect(run(d, [], {}, { year: "2023" }).params).toEqual({ params: { year: 2023 }, param_types: { year: "number" } });
    const bare: Dataset = { name: "sales", sql: "SELECT * FROM sales WHERE year = :year", params: {} };
    expect(datasetQuery(bare, [], {}, {})).toEqual({ missing: ["year"] });
  });

  it("reserves the names of the filters' parameters", () => {
    expect(() => run({ ...sales, sql: "SELECT :_f0" }, [])).toThrow(/reserved/);
  });
});

describe("datasetQuery: field filters", () => {
  it("narrows by a select, with the value as a parameter", () => {
    const q = run(sales, [filter({})], { f1: "EU'; DROP TABLE sales; --" });
    expect(q.query).toBe('SELECT * FROM (\nSELECT * FROM sales\n) AS _d\nWHERE "region" = :_f0');
    expect(q.params).toEqual({ params: { _f0: "EU'; DROP TABLE sales; --" }, param_types: { _f0: "text" } });
    expect(q.query).not.toContain("DROP");
  });

  it("quotes a column, doubling the quotes in its name", () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    const q = run(sales, [filter({ fields: [{ dataset: "sales", column: 'a"; DROP TABLE x; --' }] })], { f1: "x" });
    expect(q.query).toContain('"a""; DROP TABLE x; --" = :_f0');
  });

  it("types a number filter's values", () => {
    const q = run(sales, [filter({ value_type: "number" })], { f1: "5" });
    expect(q.params).toEqual({ params: { _f0: 5 }, param_types: { _f0: "number" } });
  });

  it("filters by several values with one parameter each", () => {
    const f = filter({ control: "multi" });
    const two = run(sales, [f], { f1: ["EU", "US"] });
    expect(two.query).toContain('"region" IN (:_f0_0, :_f0_1)');
    expect(two.params).toEqual({ params: { _f0_0: "EU", _f0_1: "US" }, param_types: { _f0_0: "text", _f0_1: "text" } });
    const none = run(sales, [f], { f1: [] });
    expect(none).toEqual({ query: "SELECT * FROM (\nSELECT * FROM sales\n) AS _d", params: {} });
  });

  it("filters by a date range, either side alone or both, casting the column to a date", () => {
    const f = filter({ control: "date_range", value_type: "date", fields: [{ dataset: "sales", column: "ts" }] });
    const both = run(sales, [f], { f1: { from: "2024-01-01", to: "2024-01-31" } });
    expect(both.query).toContain('WHERE CAST("ts" AS DATE) >= :_f0_from\n  AND CAST("ts" AS DATE) <= :_f0_to');
    expect(both.params).toEqual({
      params: { _f0_from: "2024-01-01", _f0_to: "2024-01-31" },
      param_types: { _f0_from: "date", _f0_to: "date" },
    });
    const from = run(sales, [f], { f1: { from: "2024-01-01" } });
    expect(from.query).toContain('CAST("ts" AS DATE) >= :_f0_from');
    expect(from.query).not.toContain("<=");
    expect(from.params).toEqual({ params: { _f0_from: "2024-01-01" }, param_types: { _f0_from: "date" } });
    const to = run(sales, [f], { f1: { to: "2024-01-31" } });
    expect(to.query).not.toContain(">=");
    expect(run(sales, [f], { f1: {} }).query).not.toContain("WHERE");
  });

  it("searches text case-insensitively without LIKE, so `%` and `_` are plain characters", () => {
    const q = run(sales, [filter({ control: "text" })], { f1: "50%_off" });
    expect(q.query).toContain('WHERE strpos(lower(CAST("region" AS VARCHAR)), lower(:_f0)) > 0');
    expect(q.query).not.toContain("LIKE");
    expect(q.params).toEqual({ params: { _f0: "50%_off" }, param_types: { _f0: "text" } });
  });

  it("leaves out filters without a value and filters of other datasets, and numbers the ones it uses", () => {
    const other = filter({ id: "f2", fields: [{ dataset: "stores", column: "city" }] });
    const empty = filter({ id: "f3" });
    const used = filter({ id: "f4", control: "text", fields: [{ dataset: "sales", column: "name" }] });
    const q = run(sales, [other, empty, used], { f2: "Rome", f3: "", f4: "ab" });
    expect(q.query).toBe('SELECT * FROM (\nSELECT * FROM sales\n) AS _d\nWHERE strpos(lower(CAST("name" AS VARCHAR)), lower(:_f1)) > 0');
    expect(q.params).toEqual({ params: { _f1: "ab" }, param_types: { _f1: "text" } });
  });

  it("joins the conditions with AND and keeps the dataset's own parameters", () => {
    const d: Dataset = { name: "sales", sql: "SELECT * FROM sales WHERE year = :year", params: { year: { type: "number" } } };
    const q = run(d, [filter({}), filter({ id: "f2", control: "text", fields: [{ dataset: "sales", column: "name" }] })], { f1: "EU", f2: "x" }, { year: "2024" });
    expect(q.query).toContain('WHERE "region" = :_f0\n  AND strpos');
    expect(q.params).toEqual({
      params: { year: 2024, _f0: "EU", _f1: "x" },
      param_types: { year: "number", _f0: "text", _f1: "text" },
    });
  });

  it("never puts a value in the SQL text", () => {
    const filters = [
      filter({}),
      filter({ id: "f2", control: "multi" }),
      filter({ id: "f3", control: "text" }),
      filter({ id: "f4", control: "date_range", value_type: "date" }),
    ];
    const values = { f1: "SECRET1", f2: ["SECRET2", "SECRET3"], f3: "SECRET4", f4: { from: "2024-02-03", to: "2024-02-04" } };
    const q = run(sales, filters, values);
    expect(q.query).not.toMatch(/SECRET|2024/);
  });

  it("refuses a value that is not valid for its filter", () => {
    expect(() => run(sales, [filter({ title: "Region" })], { f1: ["a"] })).toThrow(/Region: expected/);
  });
});

describe("filterValueProblem", () => {
  const select = filter({});
  const multi = filter({ control: "multi" });
  const range = filter({ control: "date_range", value_type: "date" });
  const text = filter({ control: "text" });
  const num = filter({ value_type: "number" });
  const param = filter({ fields: undefined, value_type: undefined, param: "year" });

  it("takes values of the right shape", () => {
    expect(filterValueProblem(select, "EU")).toBeNull();
    expect(filterValueProblem(select, "")).toBeNull();
    expect(filterValueProblem(num, 5)).toBeNull();
    expect(filterValueProblem(num, "5.5")).toBeNull();
    expect(filterValueProblem(multi, ["a", "b"])).toBeNull();
    expect(filterValueProblem(multi, [])).toBeNull();
    expect(filterValueProblem(range, { from: "2024-02-29" })).toBeNull();
    expect(filterValueProblem(range, { from: "", to: "2024-03-01" })).toBeNull();
    expect(filterValueProblem(text, "abc")).toBeNull();
    expect(filterValueProblem(param, "2024")).toBeNull();
    expect(filterValueProblem(param, true)).toBeNull();
  });

  it("names what a value should be otherwise", () => {
    expect(filterValueProblem(num, "abc")).toMatch(/number/);
    expect(filterValueProblem(select, ["a"])).toMatch(/text/);
    expect(filterValueProblem(select, null as never)).toMatch(/text/);
    expect(filterValueProblem(multi, "a")).toMatch(/list/);
    expect(filterValueProblem(multi, Array.from({ length: 501 }, (_, i) => String(i)))).toMatch(/at most 500/);
    expect(filterValueProblem(range, "2024-01-01")).toMatch(/range/);
    expect(filterValueProblem(range, { from: "2024-13-01" })).toMatch(/YYYY-MM-DD/);
    expect(filterValueProblem(range, { to: "yesterday" })).toMatch(/YYYY-MM-DD/);
    expect(filterValueProblem(text, ["a"])).toMatch(/text/);
    expect(filterValueProblem(param, ["a"])).toMatch(/single/);
  });
});

describe("paramValuesOf", () => {
  it("gives the values of param filters by placeholder name, as inputs hold them", () => {
    const filters = [
      filter({ id: "p1", fields: undefined, value_type: undefined, param: "year" }),
      filter({ id: "p2", fields: undefined, value_type: undefined, param: "flag" }),
      filter({ id: "p3", fields: undefined, value_type: undefined, param: "city" }),
      filter({ id: "p4", fields: undefined, value_type: undefined, param: "empty" }),
      filter({ id: "f1" }),
    ];
    expect(paramValuesOf(filters, { p1: 2024, p2: false, p3: "Rome", p4: "", f1: "EU" })).toEqual({ year: "2024", flag: false, city: "Rome" });
  });
});

describe("optionsQuery", () => {
  it("lists a column's distinct values, wrapped like any dataset", () => {
    const q = optionsQuery({ ...sales, sql: "SELECT * FROM sales -- all" }, 'a"b', {});
    expect(q).toEqual({
      query: 'SELECT DISTINCT "a""b" AS value FROM (\nSELECT * FROM sales -- all\n) AS _d WHERE "a""b" IS NOT NULL ORDER BY 1 LIMIT 500',
      params: {},
    });
  });

  it("needs the dataset's own placeholders", () => {
    const d: Dataset = { name: "sales", sql: "SELECT * FROM sales WHERE year = :year", params: {} };
    expect(optionsQuery(d, "region", {})).toEqual({ missing: ["year"] });
    expect(optionsQuery(d, "region", { year: "x" })).toMatchObject({ params: { params: { year: "x" } } });
  });
});

describe("datasetQuery: chart picks", () => {
  const narrow = (picks: { column: string; value: string | number | boolean | null }[], filters: FilterWidget[] = [], values: object = {}) => {
    const q = datasetQuery(sales, filters, values as never, {}, picks);
    if ("missing" in q) throw new Error("missing");
    return q;
  };

  it("narrows by a missing value without a parameter", () => {
    expect(narrow([{ column: "region", value: null }])).toEqual({ query: 'SELECT * FROM (\nSELECT * FROM sales\n) AS _d\nWHERE "region" IS NULL', params: {} });
  });

  it("compares a number and a boolean as they are, typed", () => {
    const n = narrow([{ column: "year", value: 2024 }]);
    expect(n.query).toContain('WHERE "year" = :_c0');
    expect(n.params).toEqual({ params: { _c0: 2024 }, param_types: { _c0: "number" } });
    const b = narrow([{ column: "paid", value: false }]);
    expect(b.query).toContain('WHERE "paid" = :_c0');
    expect(b.params).toEqual({ params: { _c0: false }, param_types: { _c0: "boolean" } });
  });

  it("compares a text, a date and a decimal as the column's text, which is how the kernel sends them", () => {
    for (const value of ["EU", "2024-03-05", "12.50"]) {
      const q = narrow([{ column: "x", value }]);
      expect(q.query).toContain('WHERE CAST("x" AS VARCHAR) = :_c0');
      expect(q.params).toEqual({ params: { _c0: value }, param_types: { _c0: "text" } });
    }
  });

  it("also tries the engine's spelling of a timestamp or a time: 3, 6 or 9 digits of fraction, Z for UTC", () => {
    const spellings = (value: string) => Object.values((narrow([{ column: "ts", value }]).params as { params: Record<string, string> }).params);
    expect(spellings("2024-03-05T13:30:00")).toEqual(["2024-03-05T13:30:00"]);
    expect(spellings("2024-03-05T13:30:00.123000")).toEqual(["2024-03-05T13:30:00.123000", "2024-03-05T13:30:00.123"]);
    expect(spellings("2024-03-06T00:00:00.500000")).toEqual(["2024-03-06T00:00:00.500000", "2024-03-06T00:00:00.500"]);
    expect(spellings("2024-03-05T13:30:00.001500")).toEqual(["2024-03-05T13:30:00.001500"]);
    expect(spellings("2024-03-05T13:30:00.123456789")).toEqual(["2024-03-05T13:30:00.123456789"]);
    expect(spellings("2024-03-05T13:30:00.500000+00:00")).toEqual(["2024-03-05T13:30:00.500000+00:00", "2024-03-05T13:30:00.500+00:00", "2024-03-05T13:30:00.500Z"]);
    expect(spellings("2024-03-05T13:30:01+02:00")).toEqual(["2024-03-05T13:30:01+02:00"]);
    expect(spellings("01:02:03.500000")).toEqual(["01:02:03.500000", "01:02:03.500"]);
    const q = narrow([{ column: "ts", value: "2024-03-05T13:30:00.123000" }]);
    expect(q.query).toContain('WHERE CAST("ts" AS VARCHAR) IN (:_c0, :_c0_1)');
    expect(q.params).toEqual({ params: { _c0: "2024-03-05T13:30:00.123000", _c0_1: "2024-03-05T13:30:00.123" }, param_types: { _c0: "text", _c0_1: "text" } });
  });

  it("numbers the picks, joins them with the filters by AND and keeps every value out of the SQL text", () => {
    const q = narrow(
      [
        { column: "region", value: "SECRET'; DROP TABLE sales; --" },
        { column: 'we"ird', value: 4242 },
      ],
      [filter({})],
      { f1: "FILTERED" },
    );
    expect(q.query).toBe('SELECT * FROM (\nSELECT * FROM sales\n) AS _d\nWHERE "region" = :_f0\n  AND CAST("region" AS VARCHAR) = :_c0\n  AND "we""ird" = :_c1');
    expect(q.query).not.toMatch(/SECRET|DROP|4242|FILTERED/);
    expect(q.params).toEqual({
      params: { _f0: "FILTERED", _c0: "SECRET'; DROP TABLE sales; --", _c1: 4242 },
      param_types: { _f0: "text", _c0: "text", _c1: "number" },
    });
  });

  it("is the plain dataset query without picks", () => {
    expect(narrow([])).toEqual({ query: "SELECT * FROM (\nSELECT * FROM sales\n) AS _d", params: {} });
  });

  it("reserves the names of the picks' parameters", () => {
    expect(() => run({ ...sales, sql: "SELECT :_c0" }, [])).toThrow(/reserved/);
    expect(() => run({ ...sales, sql: "SELECT :_c" }, [])).not.toThrow(/reserved/);
  });
});

describe("checkPicks", () => {
  const chart = (id: string, kind: ChartWidget["spec"]["kind"]): ChartWidget => ({ id, kind: "chart", dataset: "sales", spec: { kind, x: "region", y: [], agg: "count" } });
  const widgets: Widget[] = [chart("bar00001", "bar"), chart("pie00001", "pie"), chart("line0001", "line"), chart("area0001", "area"), chart("hist0001", "histogram"), chart("scat0001", "scatter"), chart("cnt00001", "counter"), filter({})];

  it("takes the picks of bar, line, area and pie charts, each once, and none", () => {
    expect(() => checkPicks(widgets, [])).not.toThrow();
    expect(() => checkPicks(widgets, [{ widget: "bar00001", value: "EU" }, { widget: "pie00001", value: null }, { widget: "line0001", value: 3 }, { widget: "area0001", value: true }])).not.toThrow();
    expect(() => checkPicks(widgets, [{ widget: "bar00001", value: "x".repeat(1000) }])).not.toThrow();
  });

  it("refuses a widget that is missing, is not a chart, or is a chart that does not cross-filter", () => {
    for (const widget of ["nope0000", "f1", "hist0001", "scat0001", "cnt00001"]) {
      expect(() => checkPicks(widgets, [{ widget, value: "EU" }])).toThrow(/not a chart of this dashboard that can filter/);
    }
    expect(() => checkPicks(widgets, [null as never])).toThrow(/not a chart/);
    expect(() => checkPicks(widgets, [{ widget: 5 as never, value: "EU" }])).toThrow(/not a chart/);
  });

  it("refuses a chart picked twice", () => {
    expect(() => checkPicks(widgets, [{ widget: "bar00001", value: "EU" }, { widget: "bar00001", value: "US" }])).toThrow(/picked twice/);
  });

  it("refuses more than ten picks, and picks that are not a plain value", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ widget: `bar${i}`, value: "EU" }));
    expect(() => checkPicks(widgets, many)).toThrow(/at most 10/);
    expect(() => checkPicks(widgets, {} as never)).toThrow(/at most 10/);
    for (const value of [["EU"], { a: 1 }, undefined, Number.NaN, Infinity, "x".repeat(1001)]) {
      expect(() => checkPicks(widgets, [{ widget: "bar00001", value: value as never }])).toThrow(/not a value/);
    }
  });
});

describe("canPick and pickableIds", () => {
  it("lists the charts with categories to click", () => {
    const spec = (kind: ChartWidget["spec"]["kind"]) => ({ kind, x: "region", y: [], agg: "count" as const });
    expect(["bar", "line", "area", "pie"].map((k) => canPick(spec(k as never)))).toEqual([true, true, true, true]);
    expect(["histogram", "scatter", "counter"].map((k) => canPick(spec(k as never)))).toEqual([false, false, false]);
    const widgets: Widget[] = [{ id: "a", kind: "chart", dataset: "sales", spec: spec("bar") }, { id: "b", kind: "chart", dataset: "sales", spec: spec("counter") }, { id: "t", kind: "table", dataset: "sales" }];
    expect([...pickableIds(widgets)]).toEqual(["a"]);
  });
});
