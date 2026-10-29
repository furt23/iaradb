import { describe, expect, it } from "vitest";

import { checkModel } from "../check";
import { render } from "../parts";

const SCHEMA = { orders: ["a", "b"] };
const sql = (source: string) => {
  const m = checkModel(`m = ${source}`, SCHEMA).model.measures[0];
  return m && render(m.expr, (i) => m.atoms[i].sql);
};
const errors = (source: string) => checkModel(`m = ${source}`, SCHEMA).diagnostics.map((d) => d.message);

describe("if_", () => {
  it("is row level next to columns and aggregate level next to aggregations", () => {
    expect(sql("sum(if_(orders.a > 0, orders.b, 0))")).toBe('SUM(CASE WHEN ("a" > 0) THEN "b" ELSE 0 END)');
    expect(sql("if_(sum(orders.a) > 0, sum(orders.b), 0)")).toBe('CASE WHEN (SUM("a") > 0) THEN SUM("b") ELSE 0 END');
  });

  it("is a constant when everything in it is", () => {
    const { model, diagnostics } = checkModel("k = if_(1 > 0, 1, 2)\nm = sum(orders.a) * k", SCHEMA);
    expect(diagnostics).toEqual([]);
    expect(render(model.measures[0].expr, (i) => model.measures[0].atoms[i].sql)).toBe('(SUM("a") * CASE WHEN (1 > 0) THEN 1 ELSE 2 END)');
  });

  it("refuses a column beside an aggregation in any of its parts", () => {
    expect(errors("if_(orders.a > 0, sum(orders.b), 0)")[0]).toContain("`orders.a` must be inside an aggregation");
  });
});

describe("divide", () => {
  it("writes the divisor twice and the measure keeps one atom for it", () => {
    const [m] = checkModel("m = divide(sum(orders.a), sum(orders.b))", SCHEMA).model.measures;
    expect(m.atoms.map((a) => a.sql)).toEqual(['SUM("b")', 'SUM("a")']); // in order of first use: the divisor is tested first
  });

  it("guards the divisor with = 0 and IS NULL, and defaults the alternate to NULL", () => {
    expect(sql("divide(sum(orders.a), sum(orders.b))")).toBe(
      'CASE WHEN (SUM("b")) = 0 OR (SUM("b")) IS NULL THEN NULL ELSE CAST((SUM("a")) AS DOUBLE) / (SUM("b")) END',
    );
  });

  it("works per row inside an aggregation", () => {
    expect(sql("sum(divide(orders.a, orders.b, 0))")).toBe('SUM(CASE WHEN ("b") = 0 OR ("b") IS NULL THEN 0 ELSE CAST(("a") AS DOUBLE) / ("b") END)');
  });

  it("takes the alternate into account for the level", () => {
    expect(errors("divide(sum(orders.a), sum(orders.b), orders.a)")[0]).toContain("`orders.a` must be inside an aggregation");
  });
});
