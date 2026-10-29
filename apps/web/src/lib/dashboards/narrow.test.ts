import { describe, expect, it } from "vitest";

import type { Relationship } from "@/lib/model/types";

import { groupField, narrower, type Form, type PickOn } from "./narrow";
import type { Dataset, FilterWidget } from "./types";

const span = { from: 0, to: 0, line: 1, col: 1 };
/** `rel("sales.customer_id", "customers.id")`: the "many" side first, as `relate` takes it */
const rel = (many: string, one: string): Relationship => {
  const [md, mc] = many.split(".");
  const [od, oc] = one.split(".");
  return { many: { dataset: md, column: mc }, one: { dataset: od, column: oc }, span };
};
const dataset = (name: string, over: Partial<Dataset> = {}): Dataset => ({ name, sql: `SELECT * FROM ${name}`, params: {}, ...over });
const all = ["sales", "customers", "products", "categories", "returns"].map((n) => dataset(n));

// sales and returns are facts; sales -> customers, sales -> products -> categories, returns -> customers
const rels = [rel("sales.customer_id", "customers.id"), rel("sales.product_id", "products.id"), rel("products.category_id", "categories.id"), rel("returns.customer_id", "customers.id")];

const filterOn = (id: string, dataset: string, column: string): FilterWidget => ({ id, kind: "filter", control: "select", fields: [{ dataset, column }], value_type: "text" });
const pick = (id: number, dataset: string, column: string, value: PickOn["value"] = "x"): PickOn => ({ id, dataset, column, value });

function setup(over: { rels?: Relationship[]; filters?: FilterWidget[]; values?: object; paramValues?: Record<string, string>; datasets?: Dataset[] } = {}) {
  const datasets = over.datasets ?? all;
  const asked: [string, Form][] = [];
  const n = narrower({
    rels: over.rels ?? rels,
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
  const query = (name: string, picks: PickOn[] = [], form: Form = "live") => {
    const q = n.query(n.plan(name, picks), form);
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
