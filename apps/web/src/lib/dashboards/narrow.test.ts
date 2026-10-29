import { describe, expect, it, vi } from "vitest";

import type { Ignore } from "@/lib/model/compile";
import type { Calendar, Relationship } from "@/lib/model/types";

import { groupField, narrower, type Form, type PickOn } from "./narrow";
import type { Dataset, FilterWidget } from "./types";

// the calendar's SQL has tests of its own: here it is stood in for by one that shows the rows it is given, to see what the narrowing asks of it
vi.mock("@/lib/model/calendar", () => ({
  calendarSql: (cal: Calendar, base: (dataset: string) => string) =>
    `SELECT "date" FROM (${cal.columns.map((c) => `SELECT "${c.column}" AS "date" FROM (${base(c.dataset)}) AS _s`).join(" UNION ")}) AS ${cal.name}`,
}));

const span = { from: 0, to: 0, line: 1, col: 1 };
/** `rel("sales.customer_id", "customers.id")`: the "many" side first, as `relate` takes it */
const rel = (many: string, one: string, cast?: "date"): Relationship => {
  const [md, mc] = many.split(".");
  const [od, oc] = one.split(".");
  return { many: { dataset: md, column: mc }, one: { dataset: od, column: oc }, span, ...(cast && { cast }) };
};
const dataset = (name: string, over: Partial<Dataset> = {}): Dataset => ({ name, sql: `SELECT * FROM ${name}`, params: {}, ...over });
const all = ["sales", "customers", "products", "categories", "returns"].map((n) => dataset(n));

// sales and returns are facts; sales -> customers, sales -> products -> categories, returns -> customers
const rels = [rel("sales.customer_id", "customers.id"), rel("sales.product_id", "products.id"), rel("products.category_id", "categories.id"), rel("returns.customer_id", "customers.id")];

const filterOn = (id: string, dataset: string, column: string): FilterWidget => ({ id, kind: "filter", control: "select", fields: [{ dataset, column }], value_type: "text" });
const pick = (id: number, dataset: string, column: string, value: PickOn["value"] = "x"): PickOn => ({ id, dataset, column, value });

function setup(over: { rels?: Relationship[]; calendars?: Calendar[]; filters?: FilterWidget[]; values?: object; paramValues?: Record<string, string>; datasets?: Dataset[] } = {}) {
  const datasets = over.datasets ?? all;
  const asked: [string, Form][] = [];
  const n = narrower({
    rels: over.rels ?? rels,
    calendars: over.calendars ?? [],
    filters: over.filters ?? [],
    values: (over.values ?? {}) as never,
    paramValues: over.paramValues ?? {},
    datasetOf: (name, form) => {
      asked.push([name, form]);
      const d = datasets.find((x) => x.name === name)!;
      return form === "live" ? d : { ...d, sql: `SELECT * FROM read_parquet('${name}.parquet')` };
    },
  });
  /** the narrowed query of a dataset */
  const query = (name: string, picks: PickOn[] = [], form: Form = "live", ignore?: Ignore) => {
    const q = n.query(n.plan(name, picks, ignore), form);
    if ("missing" in q) throw new Error(`missing ${q.missing.join(", ")}`);
    return q;
  };
  return { n, query, asked };
}

describe("groupField", () => {
  const names = ["sales", "customers"];
  it("takes dataset.column as that dataset's column, named as written", () => {
    expect(groupField("sales", "customers.region", names)).toEqual({ dataset: "customers", column: "region", as: "customers.region" });
    expect(groupField("sales", "sales.year", names)).toEqual({ dataset: "sales", column: "year", as: "sales.year" });
  });

  it("takes anything else as a column of the widget's own dataset", () => {
    expect(groupField("sales", "region", names)).toEqual({ dataset: "sales", column: "region", as: "region" });
    expect(groupField("sales", "ghost.region", names)).toEqual({ dataset: "sales", column: "ghost.region", as: "ghost.region" });
    expect(groupField("sales", ".region", names)).toEqual({ dataset: "sales", column: ".region", as: ".region" });
    expect(groupField("sales", "customers.a.b", names)).toMatchObject({ dataset: "customers", column: "a.b" });
  });
});

describe("a filter on a dimension", () => {
  it("narrows the fact through a semi-join on the relationship's columns", () => {
    const { query } = setup({ filters: [filterOn("f1", "customers", "region")], values: { f1: "EU" } });
    expect(query("sales")).toEqual({
      query:
        'SELECT * FROM (\nSELECT * FROM sales\n) AS _d\nWHERE "customer_id" IN (SELECT "id" FROM (\nSELECT * FROM (\nSELECT * FROM customers\n) AS _d\nWHERE "region" = :_f0\n) AS _n0)',
      params: { params: { _f0: "EU" }, param_types: { _f0: "text" } },
    });
  });

  it("narrows every fact that points at it", () => {
    const { query } = setup({ filters: [filterOn("f1", "customers", "region")], values: { f1: "EU" } });
    expect(query("returns").query).toBe(query("sales").query.replace("sales", "returns"));
  });

  it("narrows through two levels, one subquery inside the other", () => {
    const { query } = setup({ filters: [filterOn("f1", "categories", "name")], values: { f1: "Toys" } });
    expect(query("sales")).toEqual({
      query:
        'SELECT * FROM (\nSELECT * FROM sales\n) AS _d\nWHERE "product_id" IN (SELECT "id" FROM (\nSELECT * FROM (\nSELECT * FROM products\n) AS _d\n' +
        'WHERE "category_id" IN (SELECT "id" FROM (\nSELECT * FROM (\nSELECT * FROM categories\n) AS _d\nWHERE "name" = :_f0\n) AS _n0)\n) AS _n1)',
      params: { params: { _f0: "Toys" }, param_types: { _f0: "text" } },
    });
    // the middle of the chain is narrowed too
    expect(query("products").query).toContain('WHERE "category_id" IN (SELECT "id" FROM');
  });

  it("narrows the dimension itself with a plain condition", () => {
    const { query } = setup({ filters: [filterOn("f1", "customers", "region")], values: { f1: "EU" } });
    expect(query("customers").query).toBe('SELECT * FROM (\nSELECT * FROM customers\n) AS _d\nWHERE "region" = :_f0');
  });

  it("combines with the fact's own filters, each dimension on its own subquery", () => {
    const { query } = setup({
      filters: [filterOn("f1", "customers", "region"), filterOn("f2", "sales", "channel"), filterOn("f3", "categories", "name")],
      values: { f1: "EU", f2: "web", f3: "Toys" },
    });
    const q = query("sales");
    expect(q.query).toContain('WHERE "channel" = :_f1\n  AND "customer_id" IN (SELECT "id" FROM (');
    expect(q.query).toContain('AS _n0)\n  AND "product_id" IN (SELECT "id" FROM (');
    expect(q.query).toContain('AS _n1)');
    // one name per filter, whichever dataset reads it
    expect(q.params).toEqual({ params: { _f0: "EU", _f1: "web", _f2: "Toys" }, param_types: { _f0: "text", _f1: "text", _f2: "text" } });
  });
});

describe("a filter on a fact", () => {
  it("does not narrow its dimensions, nor a dimension it does not point at", () => {
    const { query, n } = setup({ filters: [filterOn("f1", "sales", "channel")], values: { f1: "web" } });
    expect(query("customers").query).toBe("SELECT * FROM (\nSELECT * FROM customers\n) AS _d");
    expect(query("categories").query).toBe("SELECT * FROM (\nSELECT * FROM categories\n) AS _d");
    expect(query("returns").query).toBe("SELECT * FROM (\nSELECT * FROM returns\n) AS _d");
    expect(n.reads(n.plan("customers", []))).toEqual(["customers"]);
    expect(query("sales").query).toBe('SELECT * FROM (\nSELECT * FROM sales\n) AS _d\nWHERE "channel" = :_f0');
  });
});

describe("a dimension that narrows nothing", () => {
  it("adds no subquery: an empty filter, or a filter on another dataset", () => {
    const { query, n } = setup({ filters: [filterOn("f1", "customers", "region")], values: { f1: "" } });
    expect(query("sales")).toEqual({ query: "SELECT * FROM (\nSELECT * FROM sales\n) AS _d", params: {} });
    expect(n.reads(n.plan("sales", []))).toEqual(["sales"]);
    const other = setup({ filters: [filterOn("f1", "returns", "kind")], values: { f1: "x" } });
    expect(other.query("sales").query).toBe("SELECT * FROM (\nSELECT * FROM sales\n) AS _d");
  });

  it("is the plain dataset query when the dashboard has no relationships", () => {
    const { query } = setup({ rels: [], filters: [filterOn("f1", "customers", "region")], values: { f1: "EU" } });
    expect(query("sales").query).toBe("SELECT * FROM (\nSELECT * FROM sales\n) AS _d");
    expect(query("customers").query).toContain('WHERE "region" = :_f0');
  });
});

describe("picks", () => {
  it("narrow the dataset they are on, and the facts that point at it", () => {
    const { query } = setup();
    const p = [pick(0, "customers", "region", "EU")];
    expect(query("customers", p)).toEqual({
      query: 'SELECT * FROM (\nSELECT * FROM customers\n) AS _d\nWHERE CAST("region" AS VARCHAR) = :_c0',
      params: { params: { _c0: "EU" }, param_types: { _c0: "text" } },
    });
    const sales = query("sales", p);
    expect(sales.query).toContain('WHERE "customer_id" IN (SELECT "id" FROM (\nSELECT * FROM (\nSELECT * FROM customers\n) AS _d\nWHERE CAST("region" AS VARCHAR) = :_c0\n) AS _n0)');
    expect(sales.params).toEqual({ params: { _c0: "EU" }, param_types: { _c0: "text" } });
  });

  it("do not narrow a dataset that cannot reach theirs", () => {
    const { query } = setup();
    const p = [pick(0, "sales", "channel", "web")];
    expect(query("customers", p).query).toBe("SELECT * FROM (\nSELECT * FROM customers\n) AS _d");
    expect(query("returns", p).query).toBe("SELECT * FROM (\nSELECT * FROM returns\n) AS _d");
    expect(query("sales", p).query).toContain('WHERE CAST("channel" AS VARCHAR) = :_c0');
  });

  it("have a name of their own, the same on every dataset and different from every other pick's", () => {
    const { query } = setup({ filters: [filterOn("f1", "customers", "region")], values: { f1: "EU" } });
    const p = [pick(0, "customers", "region", "N"), pick(1, "categories", "name", "Toys"), pick(2, "sales", "year", 2024)];
    const q = query("sales", p);
    expect(q.params).toEqual({
      params: { _c2: 2024, _f0: "EU", _c0: "N", _c1: "Toys" },
      param_types: { _c2: "number", _f0: "text", _c0: "text", _c1: "text" },
    });
    // the same pick is the same name when another dataset reads it
    expect((query("products", p).params as { params: object }).params).toEqual({ _c1: "Toys" });
    expect((query("customers", p).params as { params: object }).params).toEqual({ _f0: "EU", _c0: "N" });
  });

  it("share a plan by dataset and the picks that can narrow it", () => {
    const { n } = setup();
    const a = pick(0, "customers", "region");
    const b = pick(1, "categories", "name");
    expect(n.plan("sales", [a, b])).toBe(n.plan("sales", [a, b]));
    expect(n.plan("customers", [a, b])).toBe(n.plan("customers", [a]));
    expect(n.plan("sales", [a, b])).not.toBe(n.plan("sales", [a]));
  });

  it("are told apart by relevance for a dataset", () => {
    const { n } = setup();
    const ps = [pick(0, "customers", "region"), pick(1, "categories", "name"), pick(2, "sales", "year"), pick(3, "returns", "kind")];
    expect(n.relevant("sales", ps).map((p) => p.id)).toEqual([0, 1, 2]);
    expect(n.relevant("products", ps).map((p) => p.id)).toEqual([1]);
    expect(n.relevant("customers", ps).map((p) => p.id)).toEqual([0]);
    expect(n.relevant("returns", ps).map((p) => p.id)).toEqual([0, 3]);
  });
});

describe("reads", () => {
  it("lists the datasets a query reads, the dataset first, each once", () => {
    const { n } = setup({ filters: [filterOn("f1", "customers", "region"), filterOn("f2", "categories", "name")], values: { f1: "EU", f2: "Toys" } });
    expect(n.reads(n.plan("sales", []))).toEqual(["sales", "customers", "products", "categories"]);
    expect(n.reads(n.plan("returns", []))).toEqual(["returns", "customers"]);
    expect(n.reads(n.plan("products", []))).toEqual(["products", "categories"]);
    expect(n.reads(n.plan("customers", []))).toEqual(["customers"]);
  });
});

describe("the forms of the datasets", () => {
  it("reads each dataset of the query in the form asked, and keeps the queries of both", () => {
    const { query } = setup({ filters: [filterOn("f1", "customers", "region")], values: { f1: "EU" } });
    const live = query("sales", [], "live").query;
    const extract = query("sales", [], "extract").query;
    expect(live).toContain("SELECT * FROM sales\n");
    expect(live).toContain("SELECT * FROM customers\n");
    expect(extract).toContain("SELECT * FROM read_parquet('sales.parquet')\n");
    expect(extract).toContain("SELECT * FROM read_parquet('customers.parquet')\n");
    expect(extract).not.toContain("FROM sales");
  });

  it("builds a query once per form, however often it is asked", () => {
    const { n, asked } = setup({ filters: [filterOn("f1", "customers", "region")], values: { f1: "EU" } });
    const plan = n.plan("sales", []);
    const first = n.query(plan, "live");
    expect(n.query(plan, "live")).toBe(first);
    expect(n.query(n.plan("sales", []), "live")).toBe(first);
    expect(asked).toEqual([["customers", "live"], ["sales", "live"]]);
    n.query(plan, "extract");
    expect(asked.filter(([, form]) => form === "extract")).toHaveLength(2);
  });
});

describe("placeholders", () => {
  /** a dataset with the placeholder `:year` */
  const needs = (name: string, type: "number" | "text" = "number") => dataset(name, { sql: `SELECT * FROM ${name} WHERE year = :year`, params: { year: { type } } });
  const withYear = (types: Record<string, "number" | "text">) => all.map((d) => (d.name in types ? needs(d.name, types[d.name]) : d));
  const region = { filters: [filterOn("f1", "customers", "region")], values: { f1: "EU" } };

  it("says which are missing, in the dataset or in one that narrows it", () => {
    const { n } = setup({ ...region, datasets: withYear({ customers: "number" }) });
    expect(n.query(n.plan("sales", []), "live")).toEqual({ missing: ["year"] });
    expect(n.query(n.plan("customers", []), "live")).toEqual({ missing: ["year"] });
  });

  it("takes the viewer's value, bound once for the datasets that share the placeholder", () => {
    const { n } = setup({ ...region, paramValues: { year: "2024" }, datasets: withYear({ sales: "number", customers: "number" }) });
    const q = n.query(n.plan("sales", []), "live");
    expect("params" in q && q.params).toEqual({ params: { year: 2024, _f0: "EU" }, param_types: { year: "number", _f0: "text" } });
  });

  it("refuses a placeholder that means two things in one query", () => {
    const { n } = setup({ ...region, paramValues: { year: "2024" }, datasets: withYear({ sales: "text", customers: "number" }) });
    expect(() => n.query(n.plan("sales", []), "live")).toThrow(/:year is bound to two different values/);
  });
});

describe("ignore", () => {
  const eu = { filters: [filterOn("f1", "customers", "region")], values: { f1: "EU" } };
  /** `without(["customers"], [["sales", "year"]])`: a dataset and a column the query leaves its filters and picks off */
  const without = (datasets: string[] = [], columns: [string, string][] = []): Ignore => ({ datasets, columns: columns.map(([dataset, column]) => ({ dataset, column })) });
  const plainOf = (name: string) => `SELECT * FROM (\nSELECT * FROM ${name}\n) AS _d`;
  const viaCustomers = (inner: string) => `${plainOf("sales")}\nWHERE "customer_id" IN (SELECT "id" FROM (\n${inner}\n) AS _n0)`;

  it("takes the filters off an ignored dataset: the fact is not narrowed by it, and the dataset itself is read whole", () => {
    const { query, n } = setup(eu);
    expect(query("sales", [], "live", without(["customers"]))).toEqual({ query: plainOf("sales"), params: {} });
    expect(n.reads(n.plan("sales", [], without(["customers"])))).toEqual(["sales"]);
    expect(query("customers", [], "live", without(["customers"])).query).toBe(plainOf("customers"));
    // the others are as they were, and so is the fact without the ignore
    expect(query("returns", [], "live", without(["products"])).query).toContain('"customer_id" IN (SELECT "id" FROM');
    expect(query("sales", []).query).toContain('"customer_id" IN (SELECT "id" FROM');
  });

  it("does not pass through an ignored dataset: what it points at narrows nothing behind it", () => {
    const { query, n } = setup({ filters: [filterOn("f1", "customers", "region"), filterOn("f2", "categories", "name")], values: { f1: "EU", f2: "Toys" } });
    const customersOnly = { query: viaCustomers(`SELECT * FROM (\nSELECT * FROM customers\n) AS _d\nWHERE "region" = :_f0`), params: { params: { _f0: "EU" }, param_types: { _f0: "text" } } };
    // products is in the middle of the chain to categories; categories is the end of it: either way products narrows nothing
    expect(query("sales", [], "live", without(["products"]))).toEqual(customersOnly);
    expect(query("sales", [], "live", without(["categories"]))).toEqual(customersOnly);
    expect(n.reads(n.plan("sales", [], without(["products"])))).toEqual(["sales", "customers"]);
    // the ignored dataset's own filters are not applied, and its own chain is dropped, when it is the one asked
    expect(query("products", [], "live", without(["products"])).query).toBe(plainOf("products"));
    expect(query("products", [], "live", without(["categories"])).query).toBe(plainOf("products"));
  });

  it("takes everything off an ignored fact: its own filters and the dimensions it points at", () => {
    const { query } = setup({ filters: [filterOn("f1", "customers", "region"), filterOn("f2", "sales", "channel")], values: { f1: "EU", f2: "web" } });
    expect(query("sales").query).toContain('WHERE "channel" = :_f1\n  AND "customer_id" IN');
    expect(query("sales", [], "live", without(["sales"]))).toEqual({ query: plainOf("sales"), params: {} });
  });

  it("takes the picks off an ignored dataset or column, and keeps the others", () => {
    const { n, query } = setup();
    const ps = [pick(0, "customers", "region", "EU"), pick(1, "categories", "name", "Toys"), pick(2, "sales", "year", 2024)];
    expect(n.relevant("sales", ps, without(["customers"])).map((p) => p.id)).toEqual([1, 2]);
    // categories is behind products
    expect(n.relevant("sales", ps, without(["products"])).map((p) => p.id)).toEqual([0, 2]);
    expect(n.relevant("sales", ps, without([], [["sales", "year"]])).map((p) => p.id)).toEqual([0, 1]);
    expect(n.relevant("sales", ps).map((p) => p.id)).toEqual([0, 1, 2]);
    // a pick keeps its name whatever is left off
    const q = query("sales", ps, "live", without(["customers"], [["sales", "year"]]));
    expect(q.params).toEqual({ params: { _c1: "Toys" }, param_types: { _c1: "text" } });
    expect(q.query).not.toContain("_c0");
    expect(q.query).not.toContain("_c2");
  });

  it("takes the filters off an ignored column only: the dataset's other columns still narrow it, by the same names", () => {
    const { query } = setup({ filters: [filterOn("f1", "customers", "region"), filterOn("f2", "customers", "tier")], values: { f1: "EU", f2: "gold" } });
    const tier = { params: { _f1: "gold" }, param_types: { _f1: "text" } };
    const noRegion = without([], [["customers", "region"]]);
    expect(query("customers", [], "live", noRegion)).toEqual({ query: `${plainOf("customers")}\nWHERE "tier" = :_f1`, params: tier });
    // through the fact, too
    expect(query("sales", [], "live", noRegion)).toEqual({ query: viaCustomers(`${plainOf("customers")}\nWHERE "tier" = :_f1`), params: tier });
    // a column of another dataset of the same name is not the one
    expect(query("customers", [], "live", without([], [["products", "region"]])).query).toContain('WHERE "region" = :_f0\n  AND "tier" = :_f1');
    // both ignored: nothing narrows, and the fact has no semi-join
    expect(query("sales", [], "live", without([], [["customers", "region"], ["customers", "tier"]]))).toEqual({ query: plainOf("sales"), params: {} });
  });

  it("keeps a filter on several datasets for the ones that are not ignored", () => {
    const both: FilterWidget = { id: "f1", kind: "filter", control: "select", fields: [{ dataset: "customers", column: "region" }, { dataset: "sales", column: "region" }], value_type: "text" };
    const { query } = setup({ filters: [both], values: { f1: "EU" } });
    expect(query("sales", [], "live", without(["customers"])).query).toBe(`${plainOf("sales")}\nWHERE "region" = :_f0`);
    // an ignored fact is whole, its customers' filter with it; the customers keep theirs
    expect(query("sales", [], "live", without(["sales"])).query).toBe(plainOf("sales"));
    expect(query("customers", [], "live", without(["sales"])).query).toBe(`${plainOf("customers")}\nWHERE "region" = :_f0`);
  });

  it("shares a plan and a query by dataset, picks and ignore, whatever the order of the lists", () => {
    const { n } = setup(eu);
    const a = without(["customers", "products"], [["sales", "year"], ["sales", "channel"]]);
    const b = without(["products", "customers"], [["sales", "channel"], ["sales", "year"]]);
    expect(n.plan("sales", [], a)).toBe(n.plan("sales", [], b));
    expect(n.plan("sales", [], a)).not.toBe(n.plan("sales", []));
    expect(n.plan("sales", [], a)).not.toBe(n.plan("sales", [], without(["customers"])));
    expect(n.plan("sales", [])).toBe(n.plan("sales", [], without()));
    const first = n.query(n.plan("sales", [], a), "live");
    expect(n.query(n.plan("sales", [], b), "live")).toBe(first);
    expect(n.query(n.plan("sales", []), "live")).not.toBe(first);
  });
});

describe("calendars", () => {
  // a calendar of the dates of sales and returns, which both point at it from a timestamp column
  const dates: Calendar = { name: "dates", columns: [{ dataset: "sales", column: "sold_at" }, { dataset: "returns", column: "returned_at" }], span };
  const related = [...rels, rel("sales.sold_at", "dates.date", "date"), rel("returns.returned_at", "dates.date", "date")];
  const calendarsOn = { rels: related, calendars: [dates] };
  const dateRange = (id = "f1", column = "date"): FilterWidget => ({ id, kind: "filter", control: "date_range", fields: [{ dataset: "dates", column }] });
  const january = { f1: { from: "2024-01-01", to: "2024-01-31" } };
  const plainOf = (sql: string) => `SELECT * FROM (\n${sql}\n) AS _d`;
  /** the calendar's rows as the stand-in builds them from the sources read as `read` says */
  const rowsFrom = (read: (name: string) => string) =>
    `SELECT "date" FROM (SELECT "sold_at" AS "date" FROM (${plainOf(read("sales"))}) AS _s UNION SELECT "returned_at" AS "date" FROM (${plainOf(read("returns"))}) AS _s) AS dates`;
  const live = rowsFrom((name) => `SELECT * FROM ${name}`);
  const extract = rowsFrom((name) => `SELECT * FROM read_parquet('${name}.parquet')`);
  const range = 'CAST("date" AS DATE) >= :_f0_from\n  AND CAST("date" AS DATE) <= :_f0_to';
  const dateParams = { params: { _f0_from: "2024-01-01", _f0_to: "2024-01-31" }, param_types: { _f0_from: "date", _f0_to: "date" } };

  it("builds a calendar's rows from the unfiltered rows of its sources, in the form asked", () => {
    const { query } = setup({ ...calendarsOn, filters: [filterOn("f1", "sales", "channel")], values: { f1: "web" } });
    // the filter on a fact narrows the fact, not the calendar made of its dates
    expect(query("dates")).toEqual({ query: plainOf(live), params: {} });
    expect(query("dates", [], "extract")).toEqual({ query: plainOf(extract), params: {} });
    expect(query("sales").query).toBe('SELECT * FROM (\nSELECT * FROM sales\n) AS _d\nWHERE "channel" = :_f0');
  });

  it("narrows the fact with a filter on the calendar: its date column compared as a DATE", () => {
    const { query } = setup({ ...calendarsOn, filters: [dateRange()], values: january });
    const inCalendar = `${plainOf(live)}\nWHERE ${range}`;
    // sales: customers and products come first among its relationships, the calendar is the third; returns: the second
    expect(query("sales")).toEqual({ query: `${plainOf("SELECT * FROM sales")}\nWHERE CAST("sold_at" AS DATE) IN (SELECT "date" FROM (\n${inCalendar}\n) AS _n2)`, params: dateParams });
    expect(query("returns")).toEqual({ query: `${plainOf("SELECT * FROM returns")}\nWHERE CAST("returned_at" AS DATE) IN (SELECT "date" FROM (\n${inCalendar}\n) AS _n1)`, params: dateParams });
    expect(query("dates")).toEqual({ query: `${plainOf(live)}\nWHERE ${range}`, params: dateParams });
    // the same through an extract
    expect(query("sales", [], "extract").query).toContain(`FROM (\n${plainOf(extract)}\nWHERE ${range}\n) AS _n2)`);
    // the other dimensions are not touched
    expect(query("customers").query).toBe(plainOf("SELECT * FROM customers"));
  });

  it("narrows with the other columns of the calendar, and with the picks on them", () => {
    const { query } = setup({ ...calendarsOn, filters: [filterOn("f1", "dates", "year")], values: { f1: "2024" } });
    expect(query("sales").query).toContain(`FROM (\n${plainOf(live)}\nWHERE "year" = :_f0\n) AS _n2)`);
    const picked = setup(calendarsOn);
    const q = picked.query("returns", [pick(0, "dates", "month", "2024-03-01")]);
    expect(q.query).toContain(`FROM (\n${plainOf(live)}\nWHERE CAST("month" AS VARCHAR) = :_c0\n) AS _n1)`);
    expect(q.params).toEqual({ params: { _c0: "2024-03-01" }, param_types: { _c0: "text" } });
    // a pick on a calendar reaches the facts that point at it, and no other dataset
    expect(picked.n.relevant("sales", [pick(0, "dates", "month")]).map((p) => p.id)).toEqual([0]);
    expect(picked.n.relevant("customers", [pick(0, "dates", "month")])).toEqual([]);
  });

  it("is a dataset that reads its sources: they are what a query that reads it asks the routing for", () => {
    const { n } = setup({ ...calendarsOn, filters: [dateRange()], values: january });
    expect(n.sources("dates")).toEqual(["sales", "returns"]);
    expect(n.sources("sales")).toEqual(["sales"]);
    expect(n.reads(n.plan("dates", []))).toEqual(["sales", "returns"]);
    expect(n.reads(n.plan("sales", []))).toEqual(["sales", "returns"]);
    expect(n.reads(n.plan("returns", []))).toEqual(["returns", "sales"]);
    // a fact that no filter reaches through the calendar does not read it
    const quiet = setup({ ...calendarsOn, filters: [filterOn("f1", "customers", "region")], values: { f1: "EU" } });
    expect(quiet.n.reads(quiet.n.plan("returns", []))).toEqual(["returns", "customers"]);
  });

  it("is left out of a query that ignores it: neither its filters nor its picks apply", () => {
    const { n, query } = setup({ ...calendarsOn, filters: [dateRange()], values: january });
    const ignore = { datasets: ["dates"], columns: [] };
    expect(query("sales", [], "live", ignore)).toEqual({ query: plainOf("SELECT * FROM sales"), params: {} });
    expect(n.reads(n.plan("sales", [], ignore))).toEqual(["sales"]);
    expect(query("dates", [], "live", ignore).query).toBe(plainOf(live));
    // only its date column
    const column = { datasets: [], columns: [{ dataset: "dates", column: "date" }] };
    expect(query("sales", [], "live", column).query).toBe(plainOf("SELECT * FROM sales"));
  });

  it("brings the placeholders of its sources along, and says which are missing", () => {
    const needs = all.map((d) => (d.name === "returns" ? dataset("returns", { sql: "SELECT * FROM returns WHERE year = :year", params: { year: { type: "number" } } }) : d));
    const { n, query } = setup({ ...calendarsOn, filters: [dateRange()], values: january, datasets: needs, paramValues: { year: "2024" } });
    expect(query("sales").params).toEqual({ params: { year: 2024, ...dateParams.params }, param_types: { year: "number", ...dateParams.param_types } });
    expect(query("dates").params).toEqual({ params: { year: 2024, ...dateParams.params }, param_types: { year: "number", ...dateParams.param_types } });
    expect(n.options("dates", "year", "live")).toMatchObject({ params: { params: { year: 2024 } } });
    const unset = setup({ ...calendarsOn, filters: [dateRange()], values: january, datasets: needs });
    expect(unset.n.query(unset.n.plan("sales", []), "live")).toEqual({ missing: ["year"] });
    expect(unset.n.options("dates", "year", "live")).toEqual({ missing: ["year"] });
  });

  it("lists the values of a column over its whole rows, as it does for a dataset", () => {
    const { n } = setup({ ...calendarsOn, filters: [dateRange()], values: january });
    expect(n.options("dates", "year", "live")).toEqual({ query: `SELECT DISTINCT "year" AS value FROM (\n${live}\n) AS _d WHERE "year" IS NOT NULL ORDER BY 1 LIMIT 500`, params: {} });
    expect(n.options("dates", "year", "extract")).toEqual({ query: `SELECT DISTINCT "year" AS value FROM (\n${extract}\n) AS _d WHERE "year" IS NOT NULL ORDER BY 1 LIMIT 500`, params: {} });
    expect(n.options("customers", "region", "live")).toEqual({ query: 'SELECT DISTINCT "region" AS value FROM (\nSELECT * FROM customers\n) AS _d WHERE "region" IS NOT NULL ORDER BY 1 LIMIT 500', params: {} });
  });
});
