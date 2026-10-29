import { describe, expect, it } from "vitest";

import { checkModel } from "../check";
import { render } from "../parts";
import { AGGREGATE_FUNCTIONS } from "./aggregate";

const SCHEMA = { orders: ["a"], customers: ["id"] };
const one = (source: string) => checkModel(`m = ${source}`, SCHEMA);
const sql = (source: string) => {
  const m = one(source).model.measures[0];
  return render(m.expr, (i) => m.atoms[i].sql);
};

describe("aggregate functions", () => {
  it("are all aggregates over one expression, except count_rows which takes a dataset", () => {
    expect(AGGREGATE_FUNCTIONS.map((f) => f.name)).toEqual(["sum", "avg", "min", "max", "count", "count_distinct", "count_rows"]);
    for (const f of AGGREGATE_FUNCTIONS) expect(f.kind).toBe("expr");
  });

  it("take a constant too, which reads no dataset", () => {
    expect(one("count(5)").diagnostics[0].message).toBe("count() does not read any dataset: aggregate a column, e.g. sum(orders.total)");
    expect(sql("sum(orders.a + 5)")).toBe('SUM(("a" + 5))');
  });

  it("count_rows reads the dataset it is given", () => {
    expect(one("count_rows(customers)").model.measures[0]).toMatchObject({ datasets: ["customers"], atoms: [{ dataset: "customers", sql: "COUNT(*)", agg: "count" }] });
  });

  it("make one atom, over the one dataset their columns are in", () => {
    expect(one("sum(orders.a)").model.measures[0].atoms).toEqual([{ dataset: "orders", sql: 'SUM("a")', agg: "sum" }]);
    expect(one("sum(orders.a * customers.id)").diagnostics[0].message).toBe("an aggregation reads one dataset: sum(...) reads orders and customers");
  });

  it("say how a window adds each one up", () => {
    const aggs = ["sum", "min", "max", "count", "count_distinct"].map((f) => one(`${f}(orders.a)`).model.measures[0].atoms[0].agg);
    expect(aggs).toEqual(["sum", "min", "max", "count", "count_distinct"]);
    expect(one("count_rows(orders)").model.measures[0].atoms[0].agg).toBe("count");
  });

  it("make avg a sum and a count, empty when there is nothing to count", () => {
    const [m] = one("avg(orders.a * 2)").model.measures;
    expect(m.atoms).toEqual([
      { dataset: "orders", sql: 'SUM(("a" * 2))', agg: "sum" },
      { dataset: "orders", sql: 'COUNT(("a" * 2))', agg: "count" },
    ]);
    expect(m.expr).toEqual(["(CAST(", { atom: 0 }, " AS DOUBLE) / NULLIF(", { atom: 1 }, ", 0))"]);
    expect(sql("avg(orders.a)")).toBe('(CAST(SUM("a") AS DOUBLE) / NULLIF(COUNT("a"), 0))');
  });

  it("share the sum of an avg with a sum of the same value", () => {
    const [m] = one("sum(orders.a) / avg(orders.a)").model.measures;
    expect(m.atoms.map((a) => a.sql)).toEqual(['SUM("a")', 'COUNT("a")']);
  });

  it("refuse an aggregation inside, naming the outer function", () => {
    expect(one("avg(max(orders.a))").diagnostics[0].message).toBe("an aggregation inside another is not allowed: avg() takes a value per row");
    expect(one("avg(orders.a * customers.id)").diagnostics[0].message).toBe("an aggregation reads one dataset: avg(...) reads orders and customers");
  });
});
