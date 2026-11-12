import { describe, expect, it } from "vitest";

import { datasetsWritten, modelAfter, opsProblems, type DashboardContext } from "./iaraOps";

const chart = (extra: Record<string, unknown> = {}) => ({
  kind: "chart",
  dataset: "orders",
  spec: { kind: "bar", x: "status", y: [], agg: "sum" },
  values: [{ name: "Total", dataset: "orders", column: "total", agg: "sum" }],
  ...extra,
});

const ctx: DashboardContext = {
  surface: "dashboard",
  path: "dashboards/d",
  title: "D",
  view: "canvas",
  datasets: [
    { name: "orders", sql: "SELECT * FROM orders", columns: [{ name: "status", type: "string" }, { name: "total", type: "double" }, { name: "cust", type: "int64" }] },
    { name: "customer", sql: "SELECT * FROM customer", columns: [{ name: "id", type: "int64" }, { name: "segment", type: "string" }] },
    { name: "clean", sql: "", recipe: true, columns: null },
  ],
  model: "revenue = sum(orders.total)\n",
  widgets: [{ id: "abcd1234", json: "{}", status: "ok" }],
  layout: [{ widget: "abcd1234", x: 0, y: 0, w: 6, h: 8 }],
};

describe("modelAfter", () => {
  it("adds lines on lines of their own, and applies edits in order", () => {
    expect(modelAfter("a = sum(t.x)", [{ op: "add_model_lines", lines: ["b = sum(t.y)", "c = sum(t.z)"] }])).toBe("a = sum(t.x)\nb = sum(t.y)\nc = sum(t.z)\n");
    expect(modelAfter("a = sum(t.x)\n", [{ op: "edit_model", edits: [{ old: "t.x", new: "t.w" }] }])).toBe("a = sum(t.w)\n");
  });

  it("throws when an edit does not fit", () => {
    expect(() => modelAfter("a = 1", [{ op: "edit_model", edits: [{ old: "nope", new: "x" }] }])).toThrow();
  });
});

describe("opsProblems", () => {
  it("accepts a chart across tables with the relationship it needs, in one change", () => {
    expect(
      opsProblems(
        [
          { op: "add_model_lines", lines: ["relate(orders.cust, customer.id)"] },
          { op: "set_widget", id: null, widget: chart({ spec: { kind: "bar", x: "customer.segment", y: [], agg: "sum" } }) },
        ],
        ctx,
      ),
    ).toEqual([]);
  });

  it("says when the tables of a chart are not related", () => {
    const [problem] = opsProblems([{ op: "set_widget", id: null, widget: chart({ spec: { kind: "bar", x: "customer.segment", y: [], agg: "sum" } }) }], ctx);
    expect(problem).toContain("not related");
  });

  it("accepts a new dataset used by a new chart", () => {
    expect(opsProblems([{ op: "set_dataset", name: "nation", sql: "SELECT * FROM nation" }, { op: "set_widget", id: null, widget: { kind: "table", dataset: "nation" } }], ctx)).toEqual([]);
  });

  it.each([
    ["a bad dataset name", { op: "set_dataset", name: "Bad Name", sql: "SELECT 1" }, "not a dataset name"],
    ["two statements", { op: "set_dataset", name: "two", sql: "SELECT 1; SELECT 2" }, "one query"],
    ["a recipe's SQL", { op: "set_dataset", name: "clean", sql: "SELECT 1" }, "cleaning steps"],
    ["a missing dataset", { op: "remove_dataset", name: "ghost" }, "no dataset ghost"],
    ["a bad model line", { op: "add_model_lines", lines: ["x = sum(ghost.y)"] }, "model:"],
    ["an edit that does not fit", { op: "edit_model", edits: [{ old: "nope", new: "x" }] }, "model:"],
    ["a missing widget", { op: "remove_widget", id: "ghost123" }, "no widget ghost123"],
    ["moving a missing widget", { op: "move_widget", id: "ghost123", x: 0, y: 0, w: 6, h: 6 }, "no widget ghost123"],
    ["a place off the grid", { op: "move_widget", id: "abcd1234", x: 10, y: 0, w: 6, h: 6 }, "columns"],
    ["a widget that does not check", { op: "set_widget", id: null, widget: { kind: "chart" } }, "widget:"],
    ["a chart on a missing dataset", { op: "set_widget", id: null, widget: chart({ dataset: "ghost" }) }, "no dataset ghost"],
    ["a value of a missing dataset", { op: "set_widget", id: null, widget: chart({ values: [{ name: "n", dataset: "ghost", agg: "count" }] }) }, "no dataset ghost"],
    ["a missing measure", { op: "set_widget", id: null, widget: chart({ values: undefined, measures: ["ghost"] }) }, "no measure ghost"],
    ["replacing a missing widget", { op: "set_widget", id: "ghost123", widget: chart() }, "no widget ghost123"],
  ] as const)("refuses %s", (_, op, message) => {
    expect(opsProblems([op as never], ctx).join("\n")).toContain(message);
  });

  it("knows a measure the same change adds", () => {
    expect(opsProblems([{ op: "add_model_lines", lines: ["cost = sum(orders.total)"] }, { op: "set_widget", id: null, widget: chart({ values: undefined, measures: ["cost"] }) }], ctx)).toEqual([]);
  });

  it("does not blame the change for what the model already got wrong", () => {
    const broken = { ...ctx, model: "x = nonsense(1)\n" };
    expect(opsProblems([{ op: "add_model_lines", lines: ["ok = sum(orders.total)"] }], broken)).toEqual([]);
  });
});

describe("datasetsWritten", () => {
  it("lists the SQL to plan", () => {
    expect(datasetsWritten([{ op: "set_dataset", name: "a", sql: "SELECT 1" }, { op: "remove_widget", id: "x" }])).toEqual([{ name: "a", sql: "SELECT 1" }]);
  });
});
