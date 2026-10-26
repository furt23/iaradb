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
    expect(paramSpecOf(datasets, "since")).toEqual({ type: "date" });
    expect(paramSpecOf(datasets, "region")).toEqual({ type: "text" });
    expect(paramSpecOf(datasets, "nope")).toBeUndefined();
  });
});
