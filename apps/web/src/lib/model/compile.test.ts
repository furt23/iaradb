import { describe, expect, it } from "vitest";

import { checkModel } from "./check";
import { modelQuery, type GroupField, type ModelQuery } from "./compile";

const SCHEMA = {
  orders: ["a", "b", "day", "status", "customer_id", "product_id"],
  customers: ["id", "region", "city_id"],
  cities: ["id", "state"],
  products: ["id", "category"],
  goals: ["product_id", "amount"],
};
const { model, diagnostics } = checkModel(
  [
    "relate(orders.customer_id, customers.id)",
    "relate(orders.product_id, products.id)",
    "relate(customers.city_id, cities.id)",
    "relate(goals.product_id, products.id)",
    "revenue = sum(orders.a)",
    "n = count_rows(orders)",
    "margin = (sum(orders.a) - sum(orders.b)) / sum(orders.a)",
    "target = sum(goals.amount)",
    "attainment = sum(orders.a) / sum(goals.amount)",
    "people = count_distinct(customers.id)",
    "avg_ticket = revenue / n",
  ].join("\n"),
  SCHEMA,
);

const field = (dataset: string, column: string, as = column): GroupField => ({ dataset, column, as });
const ask = (over: Partial<ModelQuery>) =>
  modelQuery(model, { source: (d) => `SELECT * FROM ${d}`, x: null, group: null, measures: ["revenue"], order: "x", limit: 100, ...over });
const sqlOf = (over: Partial<ModelQuery>) => ask(over).sql;

/** the engine compares texts so that it can hash the join: an empty key equals an empty key */
const same = (a: string, b: string) =>
  `CASE WHEN ${a} IS NULL THEN 'n' ELSE 'v' || CAST(${a} AS VARCHAR) END = CASE WHEN ${b} IS NULL THEN 'n' ELSE 'v' || CAST(${b} AS VARCHAR) END`;

const ORDERS = "(SELECT * FROM orders) AS _f";
const GOALS = "(SELECT * FROM goals) AS _f";

describe("the test model", () => {
  it("checks", () => {
    expect(diagnostics).toEqual([]);
    expect(model.relationships).toHaveLength(4);
    expect(model.measures).toHaveLength(7);
  });
});

describe("one fact", () => {
  it("groups by its own columns, x then the series", () => {
    expect(sqlOf({ x: field("orders", "day"), group: field("orders", "status") })).toBe(
      'SELECT _q0."__k0" AS "day", _q0."__k1" AS "status", _q0."__a0" AS "revenue" ' +
        `FROM (SELECT "__k0", "__k1", SUM("a") AS "__a0" FROM (SELECT _f.*, _f."day" AS "__k0", _f."status" AS "__k1" FROM ${ORDERS}) AS _m GROUP BY "__k0", "__k1") AS _q0 ` +
        'ORDER BY _q0."__k0", _q0."__k1" LIMIT 100',
    );
  });

  it("groups by x alone, named as asked", () => {
    expect(sqlOf({ x: field("orders", "day", "Day") })).toBe(
      'SELECT _q0."__k0" AS "Day", _q0."__a0" AS "revenue" ' +
        `FROM (SELECT "__k0", SUM("a") AS "__a0" FROM (SELECT _f.*, _f."day" AS "__k0" FROM ${ORDERS}) AS _m GROUP BY "__k0") AS _q0 ORDER BY _q0."__k0" LIMIT 100`,
    );
  });

  it("groups by the series alone when there is no x", () => {
    expect(sqlOf({ group: field("orders", "status") })).toContain('SELECT _q0."__k0" AS "status", _q0."__a0" AS "revenue"');
  });

  it("is one row without x or series: no GROUP BY and no ORDER BY, whatever the order", () => {
    const counter =
      'SELECT _q0."__a0" AS "revenue" ' + `FROM (SELECT SUM("a") AS "__a0" FROM (SELECT _f.* FROM ${ORDERS}) AS _m) AS _q0 LIMIT 1`;
    expect(sqlOf({ limit: 1 })).toBe(counter);
    expect(sqlOf({ order: "value", limit: 1 })).toBe(counter);
  });

  it("orders by the first measure, largest first, empty values last", () => {
    const sql = sqlOf({ x: field("orders", "day"), order: "value", limit: 10, measures: ["n", "revenue"] });
    expect(sql).toContain('SELECT "__k0", COUNT(*) AS "__a0", SUM("a") AS "__a1" FROM');
    expect(sql).toContain('_q0."__a0" AS "n", _q0."__a1" AS "revenue"');
    expect(sql).toMatch(/ORDER BY "n" DESC NULLS LAST LIMIT 10$/);
  });

  it("computes the measures of one fact in one pass, an aggregation used twice once", () => {
    const sql = sqlOf({ x: field("orders", "day"), measures: ["margin", "revenue", "avg_ticket"] });
    expect(sql).toContain('SELECT "__k0", SUM("a") AS "__a0", SUM("b") AS "__a1", COUNT(*) AS "__a2" FROM');
    expect(sql).toContain(
      '(CAST(((_q0."__a0" - _q0."__a1")) AS DOUBLE) / (_q0."__a0")) AS "margin", _q0."__a0" AS "revenue", ' +
        '(CAST(((_q0."__a0")) AS DOUBLE) / ((_q0."__a2"))) AS "avg_ticket" FROM (SELECT',
    );
  });

  it("selects the measures in the order asked", () => {
    expect(sqlOf({ measures: ["n", "revenue"] })).toContain('_q0."__a0" AS "n", _q0."__a1" AS "revenue"');
    expect(sqlOf({ measures: ["revenue", "n"] })).toContain('_q0."__a0" AS "revenue", _q0."__a1" AS "n"');
  });
});

describe("a dimension's column", () => {
  it("joins the dimension many→one and groups by its column", () => {
    expect(sqlOf({ x: field("products", "category", "cat") })).toBe(
      'SELECT _q0."__k0" AS "cat", _q0."__a0" AS "revenue" ' +
        `FROM (SELECT "__k0", SUM("a") AS "__a0" FROM (SELECT _f.*, _j0."category" AS "__k0" FROM ${ORDERS} ` +
        'LEFT JOIN (SELECT * FROM products) AS _j0 ON _f."product_id" = _j0."id") AS _m GROUP BY "__k0") AS _q0 ORDER BY _q0."__k0" LIMIT 100',
    );
  });

  it("follows a snowflake, one join per step", () => {
    expect(sqlOf({ x: field("cities", "state") })).toBe(
      'SELECT _q0."__k0" AS "state", _q0."__a0" AS "revenue" ' +
        `FROM (SELECT "__k0", SUM("a") AS "__a0" FROM (SELECT _f.*, _j1."state" AS "__k0" FROM ${ORDERS} ` +
        'LEFT JOIN (SELECT * FROM customers) AS _j0 ON _f."customer_id" = _j0."id" ' +
        'LEFT JOIN (SELECT * FROM cities) AS _j1 ON _j0."city_id" = _j1."id") AS _m GROUP BY "__k0") AS _q0 ORDER BY _q0."__k0" LIMIT 100',
    );
  });

  it("joins the steps two columns have in common once", () => {
    const sql = sqlOf({ x: field("customers", "region"), group: field("cities", "state") });
    expect(sql.match(/LEFT JOIN \(SELECT \* FROM customers\)/g)).toHaveLength(1);
    expect(sql).toContain('_j0."region" AS "__k0", _j1."state" AS "__k1"');
    expect(sql).toContain('LEFT JOIN (SELECT * FROM cities) AS _j1 ON _j0."city_id" = _j1."id"');
  });

  it("groups by a column of the dataset the measure itself aggregates, however it is reached", () => {
    // `people` aggregates customers: the column is its own, no join
    const sql = sqlOf({ x: field("customers", "region"), measures: ["people"] });
    expect(sql).toContain(`FROM (SELECT _f.*, _f."region" AS "__k0" FROM (SELECT * FROM customers) AS _f) AS _m`);
    expect(sql).not.toContain("JOIN");
  });

  it("keeps rows whose key finds no match: the join is a LEFT JOIN, so they group under an empty value", () => {
    expect(sqlOf({ x: field("products", "category") })).toContain("LEFT JOIN");
    expect(sqlOf({ x: field("products", "category") })).not.toContain(" INNER ");
  });
});

describe("several facts", () => {
  it("groups each fact on its own and puts them side by side on the union of their keys", () => {
    const sql = sqlOf({ x: field("products", "category", "cat"), measures: ["revenue", "target"] });
    const join = 'LEFT JOIN (SELECT * FROM products) AS _j0 ON _f."product_id" = _j0."id"';
    expect(sql).toBe(
      `WITH _q0 AS (SELECT "__k0", SUM("a") AS "__a0" FROM (SELECT _f.*, _j0."category" AS "__k0" FROM ${ORDERS} ${join}) AS _m GROUP BY "__k0"), ` +
        `_q1 AS (SELECT "__k0", SUM("amount") AS "__a1" FROM (SELECT _f.*, _j0."category" AS "__k0" FROM ${GOALS} ${join}) AS _m GROUP BY "__k0") ` +
        'SELECT _k."__k0" AS "cat", _q0."__a0" AS "revenue", _q1."__a1" AS "target" ' +
        'FROM (SELECT "__k0" FROM _q0 UNION SELECT "__k0" FROM _q1) AS _k ' +
        `LEFT JOIN _q0 ON ${same('_k."__k0"', '_q0."__k0"')} LEFT JOIN _q1 ON ${same('_k."__k0"', '_q1."__k0"')} ` +
        'ORDER BY _k."__k0" LIMIT 100',
    );
  });

  it("compares empty keys as equal and by hash, never with a plain = or IS NOT DISTINCT FROM", () => {
    const sql = sqlOf({ x: field("products", "category"), measures: ["revenue", "target"] });
    expect(sql).not.toContain("DISTINCT FROM");
    expect(sql).not.toMatch(/_k\."__k0" = /);
    expect(sql).toContain("IS NULL THEN 'n' ELSE 'v' ||");
  });

  it("is one subquery per fact however many measures read it, and a measure over two facts reads both", () => {
    const sql = sqlOf({ x: field("products", "category"), measures: ["attainment", "revenue", "target"] });
    expect(sql.match(/ AS _q\d|_q\d AS \(/g)).toHaveLength(2);
    expect(sql).toContain('SELECT "__k0", SUM("a") AS "__a0" FROM');
    expect(sql).toContain('SELECT "__k0", SUM("amount") AS "__a1" FROM');
    expect(sql).toContain('(CAST((_q0."__a0") AS DOUBLE) / (_q1."__a1")) AS "attainment", _q0."__a0" AS "revenue", _q1."__a1" AS "target"');
  });

  it("orders the facts by first use and numbers the aggregations across them", () => {
    const sql = sqlOf({ x: field("products", "category"), measures: ["target", "revenue"] });
    expect(sql).toContain('_q0 AS (SELECT "__k0", SUM("amount") AS "__a0"');
    expect(sql).toContain('_q1 AS (SELECT "__k0", SUM("a") AS "__a1"');
    expect(sql).toContain('_q0."__a0" AS "target", _q1."__a1" AS "revenue"');
  });

  it("orders by a measure with the facts joined", () => {
    expect(sqlOf({ x: field("products", "category"), measures: ["revenue", "target"], order: "value", limit: 3 })).toMatch(
      / ORDER BY "revenue" DESC NULLS LAST LIMIT 3$/,
    );
  });
});

describe("a fact that does not reach a grouping column", () => {
  const repeat = ask({ x: field("customers", "region", "reg"), measures: ["revenue", "target"] });

  it("is left out of the grouping: its total is joined to every row, and the rows come from the fact that reaches it", () => {
    expect(repeat.sql).toBe(
      'WITH _q0 AS (SELECT "__k0", SUM("a") AS "__a0" FROM (SELECT _f.*, _j0."region" AS "__k0" FROM ' +
        `${ORDERS} LEFT JOIN (SELECT * FROM customers) AS _j0 ON _f."customer_id" = _j0."id") AS _m GROUP BY "__k0"), ` +
        `_q1 AS (SELECT SUM("amount") AS "__a1" FROM (SELECT _f.* FROM ${GOALS}) AS _m) ` +
        'SELECT _q0."__k0" AS "reg", _q0."__a0" AS "revenue", _q1."__a1" AS "target" FROM _q0 CROSS JOIN _q1 ORDER BY _q0."__k0" LIMIT 100',
    );
  });

  it("tells the author", () => {
    expect(repeat.notes).toEqual(["`target` does not reach customers.region: its total repeats"]);
  });

  it("joins on the columns it does reach", () => {
    const r = ask({ x: field("products", "category", "cat"), group: field("customers", "region", "reg"), measures: ["revenue", "target"] });
    expect(r.sql).toContain(`_q1 AS (SELECT "__k0", SUM("amount") AS "__a1" FROM (SELECT _f.*, _j0."category" AS "__k0" FROM ${GOALS}`);
    expect(r.sql).toContain(
      `FROM _q0 LEFT JOIN _q1 ON ${same('_q0."__k0"', '_q1."__k0"')} ORDER BY _q0."__k0", _q0."__k1" LIMIT 100`,
    );
    expect(r.notes).toEqual(["`target` does not reach customers.region: its total repeats"]);
  });

  it("is a note for each measure and column, and none when the measure reaches every column", () => {
    expect(ask({ x: field("products", "category"), measures: ["revenue", "target"] }).notes).toEqual([]);
    const r = ask({ x: field("customers", "region", "reg"), group: field("cities", "state"), measures: ["target", "revenue", "attainment"] });
    expect(r.notes).toEqual([
      "`target` does not reach customers.region: its total repeats",
      "`target` does not reach cities.state: its total repeats",
      "`attainment` does not reach customers.region: its total repeats",
      "`attainment` does not reach cities.state: its total repeats",
    ]);
  });

  it("takes the rows from the facts that reach most columns, with the other column empty when none reaches both", () => {
    const sql = sqlOf({ x: field("products", "category", "cat"), group: field("customers", "region", "reg"), measures: ["target", "people"] });
    expect(sql).toContain('FROM (SELECT "__k0", NULL AS "__k1" FROM _q0 UNION SELECT NULL AS "__k0", "__k1" FROM _q1) AS _k');
    expect(sql).toContain(`LEFT JOIN _q0 ON ${same('_k."__k0"', '_q0."__k0"')} LEFT JOIN _q1 ON ${same('_k."__k1"', '_q1."__k1"')}`);
  });

  it("is a note for the measure that reaches nothing it could join, without failing", () => {
    // revenue reaches products; people (customers) does not
    expect(ask({ x: field("products", "category"), measures: ["revenue", "people"] }).notes).toEqual([
      "`people` does not reach products.category: its total repeats",
    ]);
  });
});

describe("no grouping: a counter", () => {
  it("is one row, the facts side by side with a CROSS JOIN of one-row subqueries", () => {
    expect(sqlOf({ measures: ["revenue", "target", "attainment"], limit: 1 })).toBe(
      `WITH _q0 AS (SELECT SUM("a") AS "__a0" FROM (SELECT _f.* FROM ${ORDERS}) AS _m), ` +
        `_q1 AS (SELECT SUM("amount") AS "__a1" FROM (SELECT _f.* FROM ${GOALS}) AS _m) ` +
        'SELECT _q0."__a0" AS "revenue", _q1."__a1" AS "target", (CAST((_q0."__a0") AS DOUBLE) / (_q1."__a1")) AS "attainment" ' +
        "FROM _q0 CROSS JOIN _q1 LIMIT 1",
    );
  });

  it("has no notes", () => {
    expect(ask({ measures: ["revenue", "target"] }).notes).toEqual([]);
  });
});

describe("the result", () => {
  it("lists the datasets it reads: the facts, then the ones joined to reach a column", () => {
    expect(ask({ x: field("cities", "state"), measures: ["revenue"] }).datasets).toEqual(["orders", "customers", "cities"]);
    expect(ask({ x: field("products", "category"), measures: ["target", "revenue"] }).datasets).toEqual(["goals", "orders", "products"]);
    expect(ask({ measures: ["n"] }).datasets).toEqual(["orders"]);
  });

  it("asks for each dataset's text once, however often it is used", () => {
    const asked: string[] = [];
    modelQuery(model, {
      source: (d) => (asked.push(d), `SELECT * FROM ${d}`),
      x: field("products", "category"),
      group: null,
      measures: ["revenue", "target"],
      order: "x",
      limit: 10,
    });
    expect(asked.sort()).toEqual(["goals", "orders", "products"]);
  });

  it("uses the text of the dataset where it is used, filters and all", () => {
    const sql = ask({ source: (d) => `SELECT * FROM ${d} WHERE ${d === "orders" ? "a > 1" : "TRUE"}`, x: field("products", "category") }).sql;
    expect(sql).toContain('(SELECT * FROM orders WHERE a > 1) AS _f LEFT JOIN (SELECT * FROM products WHERE TRUE) AS _j0');
  });

  it("keeps the source on its own lines when it holds a line comment, so the parenthesis survives", () => {
    expect(sqlOf({ source: () => "SELECT * FROM t -- all" })).toContain("FROM (\nSELECT * FROM t -- all\n) AS _f");
    expect(sqlOf({ source: () => "SELECT 1" })).toContain("FROM (SELECT 1) AS _f");
    const sql = sqlOf({ source: (d) => `SELECT * FROM ${d} -- rows`, x: field("products", "category") });
    expect(sql).toContain("LEFT JOIN (\nSELECT * FROM products -- rows\n) AS _j0");
  });

  it("quotes the names, with quotes inside doubled", () => {
    const sql = sqlOf({ x: field("orders", 'we"ird', "two words"), measures: ["revenue"] });
    expect(sql).toContain('_q0."__k0" AS "two words"');
    expect(sql).toContain('_f."we""ird" AS "__k0"');
    expect(sqlOf({ x: field("orders", "day", 'a"b'), order: "value" })).toContain('AS "a""b"');
  });
});

describe("errors", () => {
  it("throws on no measures and on an unknown measure", () => {
    expect(() => ask({ measures: [] })).toThrow("no measures were asked for");
    expect(() => ask({ measures: ["revenue", "nope"] })).toThrow("unknown measure nope");
  });

  it("throws on a grouping column that no measure's dataset reaches", () => {
    expect(() => ask({ x: field("customers", "region"), measures: ["target"] })).toThrow("nothing in target reaches customers.region");
    expect(() => ask({ x: field("orders", "day"), group: field("cities", "state"), measures: ["target"] })).toThrow("nothing in target reaches orders.day");
    expect(() => ask({ x: field("products", "category"), group: field("nope", "x"), measures: ["revenue", "target"] })).toThrow(
      "nothing in revenue, target reaches nope.x",
    );
  });

  it("throws when the result would have two columns of one name", () => {
    expect(() => ask({ x: field("orders", "day", "revenue") })).toThrow("two columns named revenue");
    expect(() => ask({ x: field("orders", "day", "d"), group: field("orders", "status", "d") })).toThrow("two columns named d");
    expect(() => ask({ measures: ["revenue", "revenue"] })).toThrow("two columns named revenue");
  });

  it("throws on a limit that is not a positive whole number, since it goes into the text", () => {
    for (const limit of [0, -1, 1.5, NaN, Infinity]) expect(() => ask({ limit })).toThrow("limit");
    expect(() => ask({ limit: "1; DROP TABLE t" as unknown as number })).toThrow("limit");
  });

  it("does not call for the datasets' text before the question is checked", () => {
    let calls = 0;
    expect(() =>
      modelQuery(model, { source: () => (calls++, ""), x: field("customers", "region"), group: null, measures: ["target"], order: "x", limit: 1 }),
    ).toThrow();
    expect(calls).toBe(0);
  });
});
