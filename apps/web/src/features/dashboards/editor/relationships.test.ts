import { describe, expect, it } from "vitest";

import type { ChartWidget, TableWidget } from "@/lib/dashboards/types";
import { checkModel } from "@/lib/model/check";

import { removeRelationship } from "./modelEdits";
import { missingLink, orient, relateLine, relateProblem, suggestRelationships } from "./relationships";

const col = (name: string, type = "int64") => ({ name, type });
const TPCH = {
  orders: [col("o_orderkey"), col("o_custkey"), col("o_totalprice", "double"), col("o_comment", "string")],
  customer: [col("c_custkey"), col("c_nationkey"), col("c_comment", "string")],
  nation: [col("n_nationkey"), col("n_name", "string")],
};
const SCHEMA = Object.fromEntries(Object.entries(TPCH).map(([k, v]) => [k, v.map((c) => c.name)]));
const modelOf = (source: string) => checkModel(source, SCHEMA).model;

describe("suggestRelationships", () => {
  it("pairs keys that differ only by the tables' prefixes, and not other columns", () => {
    const s = suggestRelationships(TPCH, []);
    const text = s.map((x) => `${x.a.dataset}.${x.a.column}=${x.b.dataset}.${x.b.column}`);
    expect(text).toContain("orders.o_custkey=customer.c_custkey");
    expect(text).toContain("customer.c_nationkey=nation.n_nationkey");
    expect(text.join()).not.toContain("comment");
  });

  it("pairs customer_id with a customers table's id", () => {
    const s = suggestRelationships({ sales: [col("customer_id")], customers: [col("id")] }, []);
    expect(s).toEqual([{ a: { dataset: "sales", column: "customer_id" }, b: { dataset: "customers", column: "id" } }]);
  });

  it("skips columns of different kinds", () => {
    expect(suggestRelationships({ a: [col("x_key")], b: [col("y_key", "string")] }, [])).toEqual([]);
  });

  it("leaves out datasets already connected", () => {
    const { relationships } = modelOf("relate(orders.o_custkey, customer.c_custkey)\n");
    expect(suggestRelationships(TPCH, relationships).map((x) => x.a.dataset + x.b.dataset)).toEqual(["customernation"]);
  });

  it("keeps to the datasets in focus", () => {
    expect(suggestRelationships(TPCH, [], ["nation"]).every((x) => x.a.dataset === "nation" || x.b.dataset === "nation")).toBe(true);
    expect(suggestRelationships(TPCH, [], ["orders", "customer"]).map((x) => x.b.dataset)).toEqual(["customer"]);
  });
});

describe("orient", () => {
  const a = { dataset: "orders", column: "o_custkey" };
  const b = { dataset: "customer", column: "c_custkey" };

  it("points at the unique side", () => {
    expect(orient(a, b, [false, true])).toEqual({ many: a, one: b });
    expect(orient(b, a, [true, false])).toEqual({ many: a, one: b });
  });

  it("keeps the given way when both are unique, and gives up when neither is", () => {
    expect(orient(a, b, [true, true])).toEqual({ many: a, one: b });
    expect(orient(a, b, [false, false])).toBeNull();
  });
});

describe("relateProblem", () => {
  it("accepts a new relationship", () => {
    expect(relateProblem("", relateLine({ dataset: "orders", column: "o_custkey" }, { dataset: "customer", column: "c_custkey" }), SCHEMA)).toBeNull();
  });

  it("says why it does not fit", () => {
    const source = "relate(orders.o_custkey, customer.c_custkey)";
    expect(relateProblem(source, "relate(customer.c_custkey, orders.o_custkey)", SCHEMA)).toContain("reverse");
    expect(relateProblem("", "relate(orders.nope, customer.c_custkey)", SCHEMA)).toBeTruthy();
  });

  it("ignores problems the source already had", () => {
    expect(relateProblem("x = nonsense(1)\n", "relate(orders.o_custkey, customer.c_custkey)", SCHEMA)).toBeNull();
  });
});

describe("removeRelationship", () => {
  it("takes its whole line out, and leaves the rest", () => {
    const source = "total = sum(orders.o_totalprice)\nrelate(orders.o_custkey, customer.c_custkey)\nrows = count_rows(orders)\n";
    const next = removeRelationship(source, modelOf(source).relationships[0]);
    expect(next).toBe("total = sum(orders.o_totalprice)\nrows = count_rows(orders)\n");
  });
});

describe("missingLink", () => {
  const DATASETS = Object.keys(TPCH);
  const chart = (x: string, dataset = "orders"): ChartWidget => ({
    id: "c",
    kind: "chart",
    dataset: "orders",
    spec: { kind: "bar", x, y: [], agg: "sum" },
    values: [{ name: "n", dataset, column: "o_totalprice", agg: "sum" }],
  });

  it("finds a column of a dataset nothing connects", () => {
    expect(missingLink(modelOf(""), chart("customer.c_comment"), DATASETS)).toEqual(["orders", "customer"]);
  });

  it("finds nothing once they are related, however far", () => {
    const model = modelOf("relate(orders.o_custkey, customer.c_custkey)\nrelate(customer.c_nationkey, nation.n_nationkey)\n");
    expect(missingLink(model, chart("nation.n_name"), DATASETS)).toBeNull();
  });

  it("asks nothing of the chart's own columns", () => {
    expect(missingLink(modelOf(""), chart("o_comment"), DATASETS)).toBeNull();
  });

  it("looks at a table's columns", () => {
    const table: TableWidget = { id: "t", kind: "table", dataset: "orders", columns: ["o_orderkey", "customer.c_comment"] };
    expect(missingLink(modelOf(""), table, DATASETS)).toEqual(["orders", "customer"]);
  });
});
