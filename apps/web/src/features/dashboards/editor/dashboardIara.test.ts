import { describe, expect, it, vi } from "vitest";

import type { Dashboard, RenderResult, Widget, WidgetData } from "@/lib/dashboards/types";
import { FileContext } from "@/lib/iara/protocol";

import { applyDashboardOps, dashboardContext, outcomeOf, type DashboardIo } from "./dashboardIara";

const table = (id: string): Widget => ({ id, kind: "table", dataset: "orders" });
const dashboard: Dashboard = {
  slug: "d",
  config: { id: "abcd1234", title: "Sales", refresh_minutes: 60 },
  datasets: [{ name: "orders", sql: "SELECT * FROM orders", params: { min: { type: "number", default: 1 } } }],
  widgets: [table("tbl00001")],
  layout: [{ widget: "tbl00001", x: 0, y: 0, w: 6, h: 8 }],
  model: "a = sum(orders.x)\n",
  problems: [],
};

function io() {
  const calls: unknown[][] = [];
  const log = (name: string) => async (...args: unknown[]) => void calls.push([name, ...args]);
  const value: DashboardIo = { saveDataset: log("dataset"), deleteDataset: log("noDataset"), saveModel: log("model"), saveWidget: log("widget"), deleteWidget: log("noWidget"), saveLayout: log("layout"), newId: () => "newid123" };
  return { value, calls };
}

describe("dashboardContext", () => {
  it("is what the request's schema takes, with each widget's state", () => {
    const result: RenderResult = { at: 0, widgets: { tbl00001: { kind: "error", message: "no such column" } } };
    const ctx = dashboardContext({ dashboard, model: dashboard.model, found: { orders: [{ name: "x", type: "int64" }] }, view: "canvas", selected: "tbl00001", result });
    expect(FileContext.safeParse(ctx).success).toBe(true);
    expect(ctx.widgets[0].status).toBe("error: no such column");
    expect(ctx.datasets[0].columns).toEqual([{ name: "x", type: "int64" }]);
    expect(JSON.parse(ctx.widgets[0].json)).toEqual({ kind: "table", dataset: "orders" });
  });

  it("cuts what is too long to send", () => {
    const long = { ...dashboard, datasets: [{ name: "orders", sql: "x".repeat(30_000), params: {} }] };
    expect(FileContext.safeParse(dashboardContext({ dashboard: long, model: "", found: {}, view: "data", selected: null, result: null })).success).toBe(true);
  });
});

describe("applyDashboardOps", () => {
  it("writes datasets, then the model, then the widgets and the layout", async () => {
    const { value, calls } = io();
    await applyDashboardOps(
      [
        { op: "set_widget", id: null, widget: { kind: "table", dataset: "customer" } },
        { op: "add_model_lines", lines: ["relate(orders.c, customer.id)"] },
        { op: "set_dataset", name: "customer", sql: "SELECT * FROM customer" },
      ],
      dashboard,
      value,
    );
    expect(calls.map((c) => c[0])).toEqual(["dataset", "model", "widget", "layout"]);
    expect(calls[1][1]).toBe("a = sum(orders.x)\nrelate(orders.c, customer.id)\n");
    expect(calls[2][1]).toMatchObject({ id: "newid123", kind: "table" });
    expect((calls[3][1] as { widget: string }[]).map((i) => i.widget)).toEqual(["tbl00001", "newid123"]);
  });

  it("keeps the placeholders' specs of a dataset it rewrites", async () => {
    const { value, calls } = io();
    await applyDashboardOps([{ op: "set_dataset", name: "orders", sql: "SELECT * FROM orders WHERE x > :min" }], dashboard, value);
    expect(calls[0][2]).toContain('"min"');
    expect(calls[0][2]).toContain("WHERE x > :min");
  });

  it("removes and moves widgets, in one layout", async () => {
    const { value, calls } = io();
    const two = { ...dashboard, layout: [...dashboard.layout, { widget: "tbl00002", x: 6, y: 0, w: 6, h: 8 }] };
    await applyDashboardOps([{ op: "remove_widget", id: "tbl00002" }, { op: "move_widget", id: "tbl00001", x: 2, y: 3, w: 4, h: 5 }], two, value);
    expect(calls).toEqual([["noWidget", "tbl00002"], ["layout", [{ widget: "tbl00001", x: 2, y: 3, w: 4, h: 5 }]]]);
  });

  it("writes no layout when nothing moved, and replaces a widget where it is", async () => {
    const { value, calls } = io();
    await applyDashboardOps([{ op: "set_widget", id: "tbl00001", widget: { kind: "table", dataset: "orders", title: "T" } }], dashboard, value);
    expect(calls.map((c) => c[0])).toEqual(["widget"]);
  });

  it("stops at the first failure", async () => {
    const { value, calls } = io();
    const failing = { ...value, saveModel: vi.fn().mockRejectedValue(new Error("disk full")) };
    await expect(applyDashboardOps([{ op: "add_model_lines", lines: ["b = 1"] }, { op: "remove_widget", id: "tbl00001" }], dashboard, failing)).rejects.toThrow("disk full");
    expect(calls).toEqual([]);
  });
});

describe("outcomeOf", () => {
  const widgets = [{ ...table("tbl00001"), title: "Orders" } as Widget, table("tbl00002")];
  const ok: WidgetData = { kind: "table", columns: [], rows: [], total: 5 };
  const bad: WidgetData = { kind: "error", message: "boom" };

  it("lists how each widget draws", () => {
    const o = outcomeOf(widgets, null, { at: 0, widgets: { tbl00001: ok, tbl00002: ok } });
    expect(o).toMatchObject({ applied: true, ran: true, status: "ok" });
    expect(o.output).toContain("Orders (tbl00001): 5 rows");
  });

  it("is an error when a widget stopped working", () => {
    const o = outcomeOf(widgets, { at: 0, widgets: { tbl00001: ok, tbl00002: ok } }, { at: 1, widgets: { tbl00001: bad, tbl00002: ok } });
    expect(o.status).toBe("error");
    expect(o.output).toContain("boom");
    expect(o.error).toContain("tbl00001");
  });

  it("does not blame the change for what was already broken", () => {
    expect(outcomeOf(widgets, { at: 0, widgets: { tbl00001: bad } }, { at: 1, widgets: { tbl00001: bad, tbl00002: ok } }).status).toBe("ok");
  });
});
