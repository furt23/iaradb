import { describe, expect, it } from "vitest";

import { checkModel } from "./check";
import { measureQuery, type MeasureQuery } from "./compile";

const SCHEMA = { orders: ["a", "b", "day", "status"], customers: ["id"] };
const { model } = checkModel(
  [
    "revenue = sum(orders.a)",
    "n = count_rows(orders)",
    "margin = (sum(orders.a) - sum(orders.b)) / sum(orders.a)",
    "people = count_distinct(customers.id)",
  ].join("\n"),
  SCHEMA,
);

const ask = (over: Partial<MeasureQuery>): string =>
  measureQuery(model, { source: "SELECT * FROM t", x: "day", group: null, measures: ["revenue"], order: "x", limit: 100, ...over });

describe("measureQuery", () => {
  it("groups by x and the series, ordered by x then the series", () => {
    expect(ask({ group: "status" })).toBe(
      'SELECT "day", "status", SUM("a") AS "revenue" FROM (SELECT * FROM t) AS _m GROUP BY "day", "status" ORDER BY "day", "status" LIMIT 100',
    );
  });

  it("groups by x alone", () => {
    expect(ask({})).toBe('SELECT "day", SUM("a") AS "revenue" FROM (SELECT * FROM t) AS _m GROUP BY "day" ORDER BY "day" LIMIT 100');
  });

  it("is one row without x: no GROUP BY and no ORDER BY, whatever else is asked", () => {
    const counter = 'SELECT SUM("a") AS "revenue" FROM (SELECT * FROM t) AS _m LIMIT 1';
    expect(ask({ x: null, limit: 1 })).toBe(counter);
    expect(ask({ x: null, group: "status", order: "value", limit: 1 })).toBe(counter);
  });

  it("orders by the first measure, largest first, empty values last", () => {
    expect(ask({ order: "value", limit: 10, measures: ["n", "revenue"] })).toBe(
      'SELECT "day", COUNT(*) AS "n", SUM("a") AS "revenue" FROM (SELECT * FROM t) AS _m GROUP BY "day" ORDER BY "n" DESC NULLS LAST LIMIT 10',
    );
    expect(ask({ order: "value", group: "status" })).toContain('GROUP BY "day", "status" ORDER BY "revenue" DESC NULLS LAST LIMIT 100');
  });

  it("selects several measures of one dataset, in the order asked", () => {
    expect(ask({ measures: ["margin", "revenue"] })).toBe(
      'SELECT "day", (CAST(((SUM("a") - SUM("b"))) AS DOUBLE) / (SUM("a"))) AS "margin", SUM("a") AS "revenue" FROM (SELECT * FROM t) AS _m GROUP BY "day" ORDER BY "day" LIMIT 100',
    );
  });

  it("quotes the columns, with quotes inside doubled", () => {
    expect(ask({ x: 'we"ird', group: "two words" })).toContain('SELECT "we""ird", "two words", SUM("a")');
    expect(ask({ x: 'we"ird' })).toContain('GROUP BY "we""ird" ORDER BY "we""ird"');
  });

  it("keeps the source on its own lines when it holds a line comment, so the parenthesis survives", () => {
    expect(ask({ source: "SELECT * FROM t -- all" })).toContain("FROM (\nSELECT * FROM t -- all\n) AS _m");
    expect(ask({ source: "SELECT 1" })).toContain("FROM (SELECT 1) AS _m");
  });

  it("throws on no measures, an unknown measure and measures of different datasets", () => {
    expect(() => ask({ measures: [] })).toThrow("no measures");
    expect(() => ask({ measures: ["revenue", "nope"] })).toThrow("unknown measure nope");
    expect(() => ask({ measures: ["revenue", "people"] })).toThrow("different datasets (orders, customers)");
  });

  it("throws on a limit that is not a positive whole number, since it goes into the text", () => {
    for (const limit of [0, -1, 1.5, NaN, Infinity]) expect(() => ask({ limit })).toThrow("limit");
    expect(() => ask({ limit: "1; DROP TABLE t" as unknown as number })).toThrow("limit");
  });
});
