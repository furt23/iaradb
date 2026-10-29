import { describe, expect, it } from "vitest";

import { DATASET_NAME } from "@/lib/dashboards/query";
import type { Dataset } from "@/lib/dashboards/types";

import { datasetNameFor, paramNames, paramSpecOf, tableNames, tableQuery } from "./datasets";

const dataset = (name: string, sql: string, params: Dataset["params"] = {}): Dataset => ({ name, sql, params });

describe("tableNames", () => {
  it("lists each default-catalog table once, other catalogs' tables in full", () => {
    const schema = { orders: [], "tpch.lineitem": [], "demo.main.orders": [], "demo.tpch.lineitem": [], "sales.main.deals": [] };
    expect(tableNames(schema)).toEqual(["orders", "tpch.lineitem", "sales.main.deals"]);
  });
});

describe("datasetNameFor", () => {
  it("takes the table's last part and keeps it free", () => {
    expect(datasetNameFor("sales.Orders", [])).toBe("orders");
    expect(datasetNameFor("orders", ["orders"])).toBe("orders_2");
    expect(datasetNameFor("orders", ["orders", "orders_2"])).toBe("orders_3");
  });

  it("always gives a valid name", () => {
    for (const table of ["my-table", "tpch.main.line item", "x".repeat(100), "..", ""]) {
      expect(datasetNameFor(table, [])).toMatch(DATASET_NAME);
    }
  });
});

describe("tableQuery", () => {
  it("selects the whole table", () => {
    expect(tableQuery("sales.orders")).toBe("SELECT * FROM sales.orders\n");
  });
});

describe("params", () => {
  const datasets = [dataset("a", "SELECT * FROM t WHERE r = :region"), dataset("b", "SELECT :since AS s, :region AS r", { since: { type: "date" } })];

  it("lists the placeholders once, in order", () => {
    expect(paramNames(datasets)).toEqual(["region", "since"]);
  });

  it("gives the spec of the first dataset that declares one, or plain text", () => {
    expect(paramSpecOf(datasets, "since", [])).toEqual({ type: "date" });
    expect(paramSpecOf(datasets, "region", [])).toEqual({ type: "text" });
    expect(paramSpecOf(datasets, "nope", [])).toBeUndefined();
  });

  it("falls back to the model's params: a number when the default is one, else text", () => {
    const span = { from: 0, to: 0, line: 1, col: 1 };
    const params = [
      { name: "discount", default: 0.1, span },
      { name: "label", default: "all", span },
      { name: "region", default: 5, span },
    ];
    expect(paramSpecOf(datasets, "discount", params)).toEqual({ type: "number", default: 0.1 });
    expect(paramSpecOf(datasets, "label", params)).toEqual({ type: "text", default: "all" });
    // a dataset that declares the same name answers first
    expect(paramSpecOf(datasets, "region", params)).toEqual({ type: "text" });
    expect(paramSpecOf(datasets, "nope", params)).toBeUndefined();
  });
});
