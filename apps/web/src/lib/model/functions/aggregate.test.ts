import { describe, expect, it } from "vitest";

import { checkModel } from "../check";
import { AGGREGATE_FUNCTIONS } from "./aggregate";

const SCHEMA = { orders: ["a"], customers: ["id"] };
const one = (source: string) => checkModel(`m = ${source}`, SCHEMA);

describe("aggregate functions", () => {
  it("are all aggregates over one expression, except count_rows which takes a dataset", () => {
    expect(AGGREGATE_FUNCTIONS.map((f) => f.name)).toEqual(["sum", "avg", "min", "max", "count", "count_distinct", "count_rows"]);
    for (const f of AGGREGATE_FUNCTIONS) expect(f.kind).toBe("expr");
  });

  it("take a constant too, which reads no dataset", () => {
    expect(one("count(5)").diagnostics[0].message).toContain("does not read any dataset");
    expect(one("sum(orders.a + 5)").model.measures[0].sql).toBe('SUM(("a" + 5))');
  });

  it("count_rows reads the dataset it is given", () => {
    expect(one("count_rows(customers)").model.measures[0]).toMatchObject({ dataset: "customers", sql: "COUNT(*)" });
  });

  it("refuse an aggregation inside, naming the outer function", () => {
    expect(one("avg(max(orders.a))").diagnostics[0].message).toBe("an aggregation inside another is not allowed: avg() takes a value per row");
  });
});
