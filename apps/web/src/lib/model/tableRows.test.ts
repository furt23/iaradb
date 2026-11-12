import { describe, expect, it } from "vitest";

import type { Relationship } from "./types";
import { tableRowsSql } from "./tableRows";
import { valueMeasure, withValues } from "./values";

const SPAN = { from: 0, to: 0, line: 0, col: 0 };
const rel = (many: string, fk: string, one: string, key: string): Relationship => ({ many: { dataset: many, column: fk }, one: { dataset: one, column: key }, span: SPAN });
const RELS = [rel("orders", "cust", "customer", "id"), rel("customer", "nation", "nation", "id")];

describe("tableRowsSql", () => {
  it("joins each dataset once, along its path", () => {
    const sql = tableRowsSql(
      RELS,
      "orders",
      [
        { dataset: "orders", column: "total", as: "total" },
        { dataset: "customer", column: "name", as: "customer.name" },
        { dataset: "nation", column: "name", as: "nation.name" },
      ],
      (d) => `SELECT * FROM ${d}`,
    );
    expect(sql).toContain(`_f."total" AS "total"`);
    expect(sql).toContain(`_j0."name" AS "customer.name"`);
    expect(sql).toContain(`_j1."name" AS "nation.name"`);
    expect(sql.match(/LEFT JOIN/g)).toHaveLength(2);
    expect(sql).toContain(`ON _f."cust" = _j0."id"`);
    expect(sql).toContain(`ON _j0."nation" = _j1."id"`);
  });

  it("refuses a dataset it does not reach", () => {
    expect(() => tableRowsSql(RELS, "customer", [{ dataset: "orders", column: "total", as: "orders.total" }], () => "SELECT 1")).toThrow("customer has no relationship to orders");
  });
});

describe("valueMeasure", () => {
  it("quotes the column and aggregates it", () => {
    expect(valueMeasure({ name: "n", dataset: "d", column: 'a"b', agg: "sum" }).atoms[0]).toEqual({ dataset: "d", sql: 'SUM("a""b")', agg: "sum" });
    expect(valueMeasure({ name: "n", dataset: "d", agg: "count" }).atoms[0].sql).toBe("COUNT(*)");
    expect(valueMeasure({ name: "n", dataset: "d", column: "c", agg: "count_distinct" }).atoms[0].sql).toBe('COUNT(DISTINCT "c")');
  });

  it("carries its number format", () => {
    const format = { style: "currency", currency: "BRL" } as const;
    expect(valueMeasure({ name: "n", dataset: "d", column: "c", agg: "sum", format }).format).toEqual(format);
  });

  it("averages as a sum over a count, as the model's avg does", () => {
    const m = valueMeasure({ name: "n", dataset: "d", column: "c", agg: "avg" });
    expect(m.atoms.map((a) => a.agg)).toEqual(["sum", "count"]);
    expect(m.expr).toHaveLength(5);
  });
});

describe("withValues", () => {
  const model = { relationships: [], calendars: [], params: [], measures: [{ ...valueMeasure({ name: "n", dataset: "other", agg: "count" }) }] };

  it("finds a value before a measure of its name", () => {
    const next = withValues(model, [{ name: "n", dataset: "d", agg: "count" }]);
    expect(next.measures.find((m) => m.name === "n")?.datasets).toEqual(["d"]);
  });

  it("returns the model as it is without values", () => {
    expect(withValues(model)).toBe(model);
  });
});
