import { describe, expect, it } from "vitest";

import { checkModel } from "../check";

const SCHEMA = { orders: ["a", "b"], customers: ["id"] };
const first = (source: string) => checkModel(source, SCHEMA).model.measures[0];

describe("measure", () => {
  it("builds the NumberFormat of the dashboards from its options", () => {
    expect(first('m = measure(sum(orders.a), format="currency", currency="EUR", decimals=2, compact=True)').format).toEqual({
      style: "currency",
      currency: "EUR",
      decimals: 2,
      compact: true,
    });
  });

  it("defaults the currency only for the currency style", () => {
    expect(first('m = measure(sum(orders.a), format="currency")').format).toEqual({ style: "currency", currency: "BRL" });
    expect(first('m = measure(sum(orders.a), format="percent")').format).toEqual({ style: "percent" });
  });

  it("keeps the label as given", () => {
    expect(first('m = measure(sum(orders.a), label="Net revenue (BRL)")').label).toBe("Net revenue (BRL)");
    expect(first('m = measure(sum(orders.a), label="")').label).toBe("");
  });
});

describe("relate", () => {
  it("returns the relationship with the span of the call", () => {
    const { model } = checkModel("# customers\nrelate(orders.a, customers.id)", SCHEMA);
    expect(model.relationships).toEqual([
      { many: { dataset: "orders", column: "a" }, one: { dataset: "customers", column: "id" }, span: { from: 12, to: 42, line: 2, col: 1 } },
    ]);
  });
});
