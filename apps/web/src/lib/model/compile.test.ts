import { describe, expect, it } from "vitest";

import { modelQuery, type GroupField, type Ignore, type ModelQuery } from "./compile";
import { atom, calendar, measure, model as modelOf, rel, sum } from "./testing";
import type { Atom, AtomContext } from "./types";

/** the model of the tests, as the checker would write it for the lines in the comments */
const A = sum("orders", "a");
const model = modelOf({
  relationships: [
    rel("orders.customer_id", "customers.id"),
    rel("orders.product_id", "products.id"),
    rel("customers.city_id", "cities.id"),
    rel("goals.product_id", "products.id"),
    rel("orders.day", "dates.date", "date"),
    rel("goals.day", "dates.date", "date"),
  ],
  calendars: [calendar("dates", "orders.day", "goals.day")],
  params: [
    { name: "factor", default: 2, span: { from: 0, to: 0, line: 1, col: 1 } },
    { name: "floor", default: 100, span: { from: 0, to: 0, line: 1, col: 1 } },
    { name: "unused", default: "x", span: { from: 0, to: 0, line: 1, col: 1 } },
  ],
  measures: [
    // revenue = sum(orders.a)
    measure("revenue", [A]),
    // n = count_rows(orders)
    measure("n", [atom("orders", "COUNT(*)", "count")]),
    // margin = (sum(orders.a) - sum(orders.b)) / sum(orders.a)
    measure("margin", [A, sum("orders", "b")], ["(CAST(((", { atom: 0 }, " - ", { atom: 1 }, ")) AS DOUBLE) / (", { atom: 0 }, "))"]),
    // target = sum(goals.amount)
    measure("target", [sum("goals", "amount")]),
    // attainment = sum(orders.a) / sum(goals.amount)
    measure("attainment", [A, sum("goals", "amount")], ["(CAST((", { atom: 0 }, ") AS DOUBLE) / (", { atom: 1 }, "))"]),
    // people = count_distinct(customers.id)
    measure("people", [atom("customers", 'COUNT(DISTINCT "id")', "count_distinct")]),
    // avg_ticket = revenue / n
    measure("avg_ticket", [A, atom("orders", "COUNT(*)", "count")], ["(CAST(((", { atom: 0 }, ")) AS DOUBLE) / ((", { atom: 1 }, ")))"]),
  ],
});

const field = (dataset: string, column: string, as = column): GroupField => ({ dataset, column, as });
const ask = (over: Partial<ModelQuery>) =>
  modelQuery(model, { source: (d) => `SELECT * FROM ${d}`, x: null, group: null, measures: ["revenue"], order: "x", limit: 100, ...over });
const sqlOf = (over: Partial<ModelQuery>) => ask(over).sql;

/** the engine compares texts so that it can hash the join: an empty key equals an empty key */
const same = (a: string, b: string) =>
  `CASE WHEN ${a} IS NULL THEN 'n' ELSE 'v' || CAST(${a} AS VARCHAR) END = CASE WHEN ${b} IS NULL THEN 'n' ELSE 'v' || CAST(${b} AS VARCHAR) END`;

const ORDERS = "(SELECT * FROM orders) AS _f";
const GOALS = "(SELECT * FROM goals) AS _f";


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

// --- filter context, time and windows, ranks, params ---

const ctx = (filters: AtomContext["filters"], removed: AtomContext["removed"] = []): AtomContext => ({ filters, removed });
const sumOf = (rest: Partial<Atom>) => [sum("orders", "a", rest)];
const ratio = ["(CAST((", { atom: 0 }, ") AS DOUBLE) / (", { atom: 1 }, "))"];
const noProducts = ctx([], [{ dataset: "products" }]);
const timed = modelOf({
  ...model,
  measures: [
    ...model.measures,
    // pct_total = revenue / calculate(revenue, all_(products))
    measure("pct_total", [A, sum("orders", "a", { context: noProducts })], ratio),
    // south = calculate(revenue, customers.region == 'S')
    measure("south", sumOf({ context: ctx([{ dataset: "customers", sql: `"region" = 'S'` }], [{ dataset: "customers", column: "region" }]) })),
    // paulista = calculate(revenue, cities.state == 'SP')
    measure("paulista", sumOf({ context: ctx([{ dataset: "cities", sql: `"state" = 'SP'` }], [{ dataset: "cities", column: "state" }]) })),
    // any_customer = calculate(revenue, all_(customers))
    measure("any_customer", sumOf({ context: ctx([], [{ dataset: "customers" }]) })),
    // big = calculate(sum(orders.a), orders.a >= 100)
    measure("big", sumOf({ context: ctx([{ dataset: "orders", sql: '"a" >= 100' }]) })),
    measure("above", sumOf({ context: ctx([{ dataset: "orders", sql: '"a" >= :floor' }]) })),
    measure("scaled", [A], [{ atom: 0 }, " * :factor"]),
    // prev_year = previous_year(revenue); prev_month = previous_period(revenue, "month"); prev_period = previous_period(revenue)
    measure("prev_year", sumOf({ window: { kind: "shift", unit: "year" } })),
    measure("prev_month", sumOf({ window: { kind: "shift", unit: "month" } })),
    measure("prev_period", sumOf({ window: { kind: "shift", unit: "grain" } })),
    // ytd = ytd(revenue); mtd = mtd(revenue)
    measure("ytd", sumOf({ window: { kind: "to_date", period: "year" } })),
    measure("mtd", sumOf({ window: { kind: "to_date", period: "month" } })),
    measure("target_ytd", [sum("goals", "amount", { window: { kind: "to_date", period: "year" } })]),
    measure("buyers_ytd", [atom("orders", 'COUNT(DISTINCT "customer_id")', "count_distinct", { window: { kind: "to_date", period: "year" } })]),
    // running = running_total(revenue); roll3 = rolling(revenue, 3, "month")
    measure("running", sumOf({ window: { kind: "running" } })),
    measure("roll3", sumOf({ window: { kind: "rolling", n: 3 } })),
    // the goals run along x, which they do not reach
    measure("mixed", [A, sum("goals", "amount", { window: { kind: "running" } })], ratio),
    // position = rank(revenue); share_rank = rank(revenue / calculate(revenue, all_(products)))
    measure("position", [A], [{ rank: [{ atom: 0 }] }]),
    measure("share_rank", [A, sum("orders", "a", { context: noProducts })], [{ rank: ratio }]),
  ],
});
const ask3 = (over: Partial<ModelQuery>) =>
  modelQuery(timed, { source: (d) => `SELECT * FROM ${d}`, x: null, group: null, measures: ["revenue"], order: "x", limit: 100, ...over });
const sqlOf3 = (over: Partial<ModelQuery>) => ask3(over).sql;
const CAT = field("products", "category", "cat");
const MONTH = field("dates", "month");
const BY_CAT = `LEFT JOIN (SELECT * FROM products) AS _j0 ON _f."product_id" = _j0."id"`;
const CAL = `LEFT JOIN (SELECT * FROM dates) AS _j0 ON CAST(_f."day" AS DATE) = _j0."date"`;
const byCat = (alias: string, rows = ORDERS) => `SELECT "__k0", SUM("a") AS "${alias}" FROM (SELECT _f.*, _j0."category" AS "__k0" FROM ${rows} ${BY_CAT}) AS _m GROUP BY "__k0"`;
const byMonth = (alias: string, key = '_j0."month"') => `SELECT "__k0", SUM("a") AS "${alias}" FROM (SELECT _f.*, ${key} AS "__k0" FROM ${ORDERS} ${CAL}) AS _m GROUP BY "__k0"`;
/** a fact that goes along x: the rows with no date are not on it */
const dated = (alias: string, key = '_j0."month"', column = "month") => byMonth(alias, key).replace(`${CAL})`, `${CAL} WHERE _j0."${column}" IS NOT NULL)`);
const byMonthCat = (alias: string, where = "") =>
  `SELECT "__k0", "__k1", SUM("a") AS "${alias}" FROM (SELECT _f.*, _j0."month" AS "__k0", _j1."category" AS "__k1" FROM ${ORDERS} ${CAL} LEFT JOIN (SELECT * FROM products) AS _j1 ON _f."product_id" = _j1."id"${where}) AS _m GROUP BY "__k0", "__k1"`;
const OVER_YEAR = `OVER (PARTITION BY CAST(DATE_TRUNC('year', "__k0") AS DATE) ORDER BY "__k0" ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)`;
const join = (i: number, k = 0) => ` LEFT JOIN _q${i} ON ${same(`_q0."__k${k}"`, `_q${i}."__k${k}"`)}`;

describe("calculate", () => {
  it("takes a total from the context without the grouping it removes: a share of the total", () => {
    const r = ask3({ x: CAT, measures: ["pct_total"] });
    expect(r.sql).toBe(
      `WITH _q0 AS (${byCat("__a0")}), _q1 AS (SELECT SUM("a") AS "__a1" FROM (SELECT _f.* FROM ${ORDERS}) AS _m) ` +
        'SELECT _q0."__k0" AS "cat", (CAST((_q0."__a0") AS DOUBLE) / (_q1."__a1")) AS "pct_total" FROM _q0 CROSS JOIN _q1 ORDER BY _q0."__k0" LIMIT 100',
    );
    // leaving the grouping out is what is meant: the author is told nothing
    expect(r.notes).toEqual([]);
  });

  it("asks the caller for the rows without the filters the context removes, each dataset once for each set", () => {
    const asked: [string, Ignore | undefined][] = [];
    modelQuery(timed, { source: (d, i) => (asked.push([d, i]), `SELECT * FROM ${d}`), x: CAT, group: null, measures: ["pct_total", "revenue"], order: "x", limit: 1 });
    expect(asked).toEqual([
      ["orders", undefined],
      ["orders", { datasets: ["products"], columns: [] }],
      ["products", undefined],
    ]);
  });

  it("narrows the rows by a filter on a dataset the fact reaches, with a semi-join, apart from the other measure's rows", () => {
    const r = ask3({ x: CAT, measures: ["revenue", "south"] });
    const rows = `(SELECT * FROM (SELECT * FROM orders) AS _x WHERE (_x."customer_id" IN (SELECT "id" FROM (SELECT * FROM customers) AS _s1 WHERE "region" = 'S'))) AS _f`;
    expect(r.sql).toBe(
      `WITH _q0 AS (${byCat("__a0")}), _q1 AS (${byCat("__a1", rows)}) ` +
        `SELECT _q0."__k0" AS "cat", _q0."__a0" AS "revenue", _q1."__a1" AS "south" FROM _q0${join(1)} ORDER BY _q0."__k0" LIMIT 100`,
    );
    expect(r.datasets).toEqual(["orders", "products", "customers"]);
  });

  it("follows a snowflake with a semi-join in a semi-join", () => {
    expect(sqlOf3({ measures: ["paulista"] })).toContain(
      `WHERE (_x."customer_id" IN (SELECT "id" FROM (SELECT * FROM customers) AS _s1 WHERE _s1."city_id" IN (SELECT "id" FROM (SELECT * FROM cities) AS _s2 WHERE "state" = 'SP'))))`,
    );
  });

  it("filters on a column of the fact's own dataset", () => {
    expect(sqlOf3({ measures: ["big"] })).toBe(
      'SELECT _q0."__a0" AS "big" FROM (SELECT SUM("a") AS "__a0" FROM (SELECT _f.* FROM (SELECT * FROM (SELECT * FROM orders) AS _x WHERE ("a" >= 100)) AS _f) AS _m) AS _q0 LIMIT 100',
    );
  });

  it("repeats its value on every row of a grouping column it removes, and tells the author nothing", () => {
    const r = ask3({ x: field("customers", "region", "reg"), measures: ["revenue", "south"] });
    expect(r.sql).toContain('_q1 AS (SELECT SUM("a") AS "__a1" FROM (SELECT _f.* FROM (SELECT * FROM (SELECT * FROM orders) AS _x WHERE');
    expect(r.sql).toContain("FROM _q0 CROSS JOIN _q1 ORDER BY");
    expect(r.notes).toEqual([]);
  });

  it("keeps a grouping column when only another column is removed, and leaves it out with its dataset or one on the way removed", () => {
    // paulista removes cities.state only
    expect(ask3({ x: field("customers", "region", "reg"), measures: ["revenue", "paulista"] }).sql).toContain(
      `_q1 AS (SELECT "__k0", SUM("a") AS "__a1" FROM (SELECT _f.*, _j0."region" AS "__k0"`,
    );
    expect(ask3({ x: field("cities", "state"), measures: ["revenue", "paulista"] }).sql).toContain('_q1 AS (SELECT SUM("a") AS "__a1" FROM');
    // any_customer removes customers, which the way from orders to cities passes through
    expect(ask3({ x: field("cities", "state"), measures: ["revenue", "any_customer"] }).sql).toContain('_q1 AS (SELECT SUM("a") AS "__a1" FROM');
    expect(ask3({ x: CAT, measures: ["revenue", "any_customer"] }).sql).toContain('_q1 AS (SELECT "__k0", SUM("a") AS "__a1" FROM');
  });

  it("is a note when a measure does not reach a column, whatever its context", () => {
    expect(ask3({ x: field("customers", "region", "reg"), measures: ["target", "south"] }).notes).toEqual(["`target` does not reach customers.region: its total repeats"]);
  });
});

describe("time", () => {
  it("compares with the same month a year earlier, filing its rows under the month they are compared to", () => {
    expect(sqlOf3({ x: MONTH, measures: ["revenue", "prev_year"] })).toBe(
      `WITH _q0 AS (${byMonth("__a0")}), _q1 AS (${dated("__a1", `(_j0."month" + INTERVAL '1' YEAR)`)}) ` +
        `SELECT _q0."__k0" AS "month", _q0."__a0" AS "revenue", _q1."__a1" AS "prev_year" FROM _q0${join(1)} ORDER BY _q0."__k0" LIMIT 100`,
    );
  });

  it("shifts by the unit asked or by the x axis's own, and a year's integer by 1", () => {
    expect(sqlOf3({ x: MONTH, measures: ["prev_month"] })).toContain(`(_j0."month" + INTERVAL '1' MONTH) AS "__k0"`);
    expect(sqlOf3({ x: MONTH, measures: ["prev_period"] })).toContain(`(_j0."month" + INTERVAL '1' MONTH) AS "__k0"`);
    expect(sqlOf3({ x: field("dates", "quarter"), measures: ["prev_period"] })).toContain(`(_j0."quarter" + INTERVAL '1' QUARTER) AS "__k0"`);
    expect(sqlOf3({ x: field("dates", "year"), measures: ["prev_year"] })).toContain('(_j0."year" + 1) AS "__k0"');
    expect(sqlOf3({ x: field("dates", "date"), measures: ["prev_year"] })).toContain(`(_j0."date" + INTERVAL '1' YEAR) AS "__k0"`);
  });

  it("reads past the date filters: the shift, the total to date and the rolling window ask for the calendar whole", () => {
    for (const measures of [["prev_year"], ["ytd"], ["roll3"]]) {
      const asked: [string, Ignore | undefined][] = [];
      modelQuery(timed, { source: (d, i) => (asked.push([d, i]), `SELECT * FROM ${d}`), x: MONTH, group: null, measures, order: "x", limit: 1 });
      expect(asked.filter(([, i]) => i)).toEqual([
        ["orders", { datasets: ["dates"], columns: [] }],
        ["dates", { datasets: ["dates"], columns: [] }],
      ]);
      // and the plain fact, which gives the rows, reads them
      expect(asked.filter(([, i]) => !i).map(([d]) => d)).toEqual(["orders", "dates"]);
    }
  });

  it("does not let a running total read past them", () => {
    const asked: Ignore[] = [];
    modelQuery(timed, { source: (d, i) => (i && asked.push(i), `SELECT * FROM ${d}`), x: MONTH, group: null, measures: ["running"], order: "x", limit: 1 });
    expect(asked).toEqual([]);
  });

  it("adds up the year to date by month: a window over the grouped months, from January", () => {
    expect(sqlOf3({ x: MONTH, measures: ["revenue", "ytd"] })).toBe(
      `WITH _q0 AS (${byMonth("__a0")}), ` +
        `_q1 AS (SELECT "__k0", SUM("__a1") ${OVER_YEAR} AS "__a1" FROM (${dated("__a1")}) AS _g) ` +
        `SELECT _q0."__k0" AS "month", _q0."__a0" AS "revenue", _q1."__a1" AS "ytd" FROM _q0${join(1)} ORDER BY _q0."__k0" LIMIT 100`,
    );
  });

  it("adds up the year to date by day, from the start of the day's year", () => {
    const key = '_j0."date"';
    expect(sqlOf3({ x: field("dates", "date"), measures: ["revenue", "ytd"] })).toBe(
      `WITH _q0 AS (${byMonth("__a0", key)}), ` +
        `_q1 AS (SELECT "__k0", SUM("__a1") ${OVER_YEAR} AS "__a1" FROM (${dated("__a1", key, "date")}) AS _g) ` +
        `SELECT _q0."__k0" AS "date", _q0."__a0" AS "revenue", _q1."__a1" AS "ytd" FROM _q0${join(1)} ORDER BY _q0."__k0" LIMIT 100`,
    );
  });

  it("adds up the month to date by day, partitioned by the month the day is in", () => {
    expect(sqlOf3({ x: field("dates", "date"), measures: ["mtd"] })).toContain(`PARTITION BY CAST(DATE_TRUNC('month', "__k0") AS DATE) ORDER BY "__k0" ROWS`);
  });

  it("adds up a month to date by month as the month itself", () => {
    expect(sqlOf3({ x: MONTH, measures: ["mtd"] })).toContain('OVER (PARTITION BY "__k0" ORDER BY "__k0" ROWS');
  });

  it("keeps a running total within each series, along x", () => {
    const over = 'OVER (PARTITION BY "__k1" ORDER BY "__k0" ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)';
    expect(sqlOf3({ x: MONTH, group: CAT, measures: ["revenue", "running"] })).toBe(
      `WITH _q0 AS (${byMonthCat("__a0")}), ` +
        `_q1 AS (SELECT "__k0", "__k1", SUM("__a1") ${over} AS "__a1" FROM (${byMonthCat("__a1", ' WHERE _j0."month" IS NOT NULL')}) AS _g) ` +
        'SELECT _q0."__k0" AS "month", _q0."__k1" AS "cat", _q0."__a0" AS "revenue", _q1."__a1" AS "running" ' +
        `FROM _q0 LEFT JOIN _q1 ON ${same('_q0."__k0"', '_q1."__k0"')} AND ${same('_q0."__k1"', '_q1."__k1"')} ORDER BY _q0."__k0", _q0."__k1" LIMIT 100`,
    );
  });

  it("rolls over the last n months as a RANGE over a month index, so that a month the data lacks still counts as a month", () => {
    const over = 'OVER (ORDER BY EXTRACT(YEAR FROM "__k0") * 12 + EXTRACT(MONTH FROM "__k0") RANGE BETWEEN 2 PRECEDING AND CURRENT ROW)';
    expect(sqlOf3({ x: MONTH, measures: ["revenue", "roll3"] })).toBe(
      `WITH _q0 AS (${byMonth("__a0")}), _q1 AS (SELECT "__k0", SUM("__a1") ${over} AS "__a1" FROM (${dated("__a1")}) AS _g) ` +
        `SELECT _q0."__k0" AS "month", _q0."__a0" AS "revenue", _q1."__a1" AS "roll3" FROM _q0${join(1)} ORDER BY _q0."__k0" LIMIT 100`,
    );
  });

  it("rolls over the last n rows when x is not on the calendar", () => {
    expect(sqlOf3({ x: CAT, measures: ["roll3"] })).toContain('OVER (ORDER BY "__k0" ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)');
  });

  it("puts the windows of two datasets side by side on their months", () => {
    const r = ask3({ x: MONTH, measures: ["ytd", "target_ytd"] });
    expect(r.datasets).toEqual(["orders", "goals", "dates"]);
    expect(r.sql).toContain('FROM (SELECT "__k0" FROM _q2 UNION SELECT "__k0" FROM _q3) AS _k');
  });
});

describe("the rows of the result", () => {
  it("come from the plain fact, not from a shifted or accumulated one that reads past the chart's filters", () => {
    for (const measures of [["prev_year", "revenue"], ["ytd", "revenue"]]) {
      const sql = sqlOf3({ x: MONTH, measures });
      expect(sql).toContain('SELECT _q1."__k0" AS "month"');
      expect(sql).toContain("FROM _q1 LEFT JOIN _q0 ON");
    }
  });

  it("come from the plain fact when the others have a changed context, so that a total repeats on every row", () => {
    const sql = sqlOf3({ x: CAT, measures: ["south", "revenue"] });
    expect(sql).toContain('SELECT _q1."__k0" AS "cat", _q0."__a0" AS "south", _q1."__a1" AS "revenue" FROM _q1 LEFT JOIN _q0 ON');
  });

  it("come from one more fact of the dataset when every measure has a context or a window: the same rows, no value", () => {
    expect(sqlOf3({ x: MONTH, measures: ["prev_year"] })).toBe(
      `WITH _q0 AS (${dated("__a0", `(_j0."month" + INTERVAL '1' YEAR)`)}), _q1 AS (SELECT "__k0" FROM (SELECT _f.*, _j0."month" AS "__k0" FROM ${ORDERS} ${CAL}) AS _m GROUP BY "__k0") ` +
        `SELECT _q1."__k0" AS "month", _q0."__a0" AS "prev_year" FROM _q1 LEFT JOIN _q0 ON ${same('_q1."__k0"', '_q0."__k0"')} ORDER BY _q1."__k0" LIMIT 100`,
    );
  });

  it("come from a changed context alone just as well: the categories of the orders, all of them", () => {
    const sql = sqlOf3({ x: CAT, measures: ["pct_total"] });
    expect(sql).toContain("FROM _q0 CROSS JOIN _q1");
    const south = sqlOf3({ x: CAT, measures: ["south"] });
    expect(south).toContain('SELECT _q1."__k0" AS "cat", _q0."__a0" AS "south" FROM _q1 LEFT JOIN _q0 ON');
  });

  it("come from the plain fact of each dataset, together: the months of the orders and of the goals", () => {
    const sql = sqlOf3({ x: MONTH, measures: ["prev_year", "target"] });
    expect(sql).toContain('FROM (SELECT "__k0" FROM _q1 UNION SELECT "__k0" FROM _q2) AS _k');
    expect(sql).toContain(`LEFT JOIN _q0 ON ${same('_k."__k0"', '_q0."__k0"')} LEFT JOIN _q1 ON ${same('_k."__k0"', '_q1."__k0"')}`);
    expect(sql).not.toContain("LEFT JOIN _q2");
  });

  it("need no extra fact without a grouping column: one row", () => {
    expect(sqlOf3({ measures: ["big"] })).not.toContain("WITH");
  });
});

describe("rank", () => {
  it("is RANK() over the chart's x values, largest first, empty values last", () => {
    expect(sqlOf3({ x: CAT, measures: ["revenue", "position"] })).toBe(
      `SELECT _q0."__k0" AS "cat", _q0."__a0" AS "revenue", RANK() OVER (ORDER BY (_q0."__a0") DESC NULLS LAST) AS "position" FROM (${byCat("__a0")}) AS _q0 ORDER BY _q0."__k0" LIMIT 100`,
    );
  });

  it("stands within each series when there is one", () => {
    const grouped =
      'SELECT "__k0", "__k1", SUM("a") AS "__a0" FROM (SELECT _f.*, _f."day" AS "__k0", _f."status" AS "__k1" FROM (SELECT * FROM orders) AS _f) AS _m GROUP BY "__k0", "__k1"';
    expect(sqlOf3({ x: field("orders", "day"), group: field("orders", "status"), measures: ["position"] })).toBe(
      'SELECT _q0."__k0" AS "day", _q0."__k1" AS "status", RANK() OVER (PARTITION BY _q0."__k1" ORDER BY (_q0."__a0") DESC NULLS LAST) AS "position" ' +
        `FROM (${grouped}) AS _q0 ORDER BY _q0."__k0", _q0."__k1" LIMIT 100`,
    );
  });

  it("partitions by the series' key of the rows when the facts are side by side", () => {
    const sql = sqlOf3({ x: MONTH, group: CAT, measures: ["position", "target"] });
    expect(sql).toContain('RANK() OVER (PARTITION BY _k."__k1" ORDER BY');
  });

  it("ranks a value made of several facts", () => {
    expect(sqlOf3({ x: CAT, measures: ["share_rank"] })).toContain(
      'RANK() OVER (ORDER BY ((CAST((_q0."__a0") AS DOUBLE) / (_q1."__a1"))) DESC NULLS LAST) AS "share_rank" FROM _q0 CROSS JOIN _q1',
    );
  });

  it("can be what the chart is ordered by", () => {
    expect(sqlOf3({ x: CAT, measures: ["position"], order: "value" })).toMatch(/ORDER BY "position" DESC NULLS LAST LIMIT 100$/);
  });
});

describe("params", () => {
  const names = (measures: string[]) => ask3({ measures }).params.map((p) => p.name);

  it("are the ones the SQL of the measures uses, in the order the model declares them", () => {
    expect(names(["scaled"])).toEqual(["factor"]);
    expect(names(["above"])).toEqual(["floor"]);
    expect(names(["scaled", "above"])).toEqual(["factor", "floor"]);
    expect(names(["above", "scaled"])).toEqual(["factor", "floor"]);
  });

  it("carry the default to bind", () => {
    expect(ask3({ measures: ["scaled"] }).params).toEqual([{ name: "factor", default: 2, span: { from: 0, to: 0, line: 1, col: 1 } }]);
  });

  it("are none for measures that use none, or for a name the source of a dataset holds", () => {
    expect(names(["revenue", "south"])).toEqual([]);
    expect(ask3({ measures: ["scaled"], source: () => "SELECT :unused AS x" }).params.map((p) => p.name)).toEqual(["factor"]);
  });

  it("are found in an aggregation and in the text around it, not in a cast or a time", () => {
    const m = modelOf({
      params: model.params,
      measures: [measure("k", [atom("orders", `SUM("a") FILTER (WHERE "t" > '10:30' AND "c"::INT > :floor)`, "sum")], [{ atom: 0 }, "::DOUBLE + :factor"])],
    });
    const r = modelQuery(m, { source: (d) => d, x: null, group: null, measures: ["k"], order: "x", limit: 1 });
    expect(r.params.map((p) => p.name)).toEqual(["factor", "floor"]);
  });

  it("are found inside a rank", () => {
    const m = modelOf({ relationships: model.relationships, params: model.params, measures: [measure("k", [A], [{ rank: [{ atom: 0 }, " * :factor"] }])] });
    const r = modelQuery(m, { source: (d) => d, x: CAT, group: null, measures: ["k"], order: "x", limit: 1 });
    expect(r.params.map((p) => p.name)).toEqual(["factor"]);
  });
});

describe("window errors", () => {
  const fails = (over: Partial<ModelQuery>, message: string) => expect(() => ask3(over)).toThrow(message);

  it("need the chart's x axis", () => {
    for (const m of ["prev_year", "ytd", "running", "roll3"]) fails({ measures: [m] }, `${m} needs the chart's x axis`);
    fails({ group: CAT, measures: ["ytd"] }, "ytd needs the chart's x axis");
  });

  it("need the x axis on a calendar column for a shift and a total to date", () => {
    fails({ x: CAT, measures: ["prev_year"] }, "prev_year needs the x axis on a calendar column, e.g. dates.month");
    fails({ x: field("orders", "day"), measures: ["ytd"] }, "ytd needs the x axis on a calendar column, e.g. dates.month");
  });

  it("do not run along the month of the year or the day of the week", () => {
    fails({ x: field("dates", "month_of_year"), measures: ["prev_year"] }, "prev_year needs the x axis on a date, week, month, quarter or year of dates, not month_of_year");
    fails({ x: field("dates", "day_of_week"), measures: ["roll3"] }, "roll3 needs the x axis on a date, week, month, quarter or year of dates, not day_of_week");
  });

  it("cannot shift by a unit finer than the x axis, or add up from a period finer than it", () => {
    fails({ x: field("dates", "year"), measures: ["prev_month"] }, "prev_month cannot shift by a month on an x axis by year");
    fails({ x: field("dates", "quarter"), measures: ["mtd"] }, "mtd adds up from the start of the month, but the x axis is by quarter");
    fails({ x: field("dates", "week"), measures: ["prev_year"] }, "prev_year cannot shift by a year on an x axis by week");
  });

  it("cannot add up a distinct count", () => {
    fails({ x: MONTH, measures: ["buyers_ytd"] }, "buyers_ytd cannot add up a distinct count along the x axis");
  });

  it("need every dataset the window reads to reach x", () => {
    fails({ x: field("customers", "region"), measures: ["mixed"] }, "mixed needs the x axis on customers.region, which goals does not reach or a filter in it removes");
  });

  it("are found before any dataset is asked for", () => {
    let calls = 0;
    expect(() => modelQuery(timed, { source: () => (calls++, ""), x: CAT, group: null, measures: ["ytd"], order: "x", limit: 1 })).toThrow();
    expect(calls).toBe(0);
  });
});
