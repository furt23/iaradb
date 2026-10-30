import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { ChartWidget, TableWidget } from "@/lib/dashboards/types";
import type { Measure } from "@/lib/model/types";

import { FieldTreeView } from "./FieldTreeView";
import { buildFieldTree } from "./fieldTree";

const span = { from: 0, to: 0, line: 1, col: 1 };
const measure: Measure = { name: "revenue", datasets: ["orders"], atoms: [], expr: [], span };
const model = { measures: [measure], calendars: [], params: [{ name: "discount", default: 0.1, span }] };
const found = { orders: [{ name: "id", type: "int64" }, { name: "region", type: "string" }] };
const tree = buildFieldTree({ datasets: [{ name: "orders", sql: "", params: {} }], model, found, query: "" });

const chart: ChartWidget = { id: "c", kind: "chart", dataset: "orders", spec: { kind: "bar", x: "region", y: [], agg: "sum" }, measures: ["revenue"] };
const table: TableWidget = { id: "t", kind: "table", dataset: "orders", columns: ["id"] };

const html = (widget: ChartWidget | TableWidget | undefined, open = true) =>
  renderToStaticMarkup(
    createElement(FieldTreeView, { tree, widget, isOpen: () => open, onToggle: () => undefined, onActivate: () => undefined, onMenu: () => undefined }),
  );
const checkboxes = (markup: string) => [...markup.matchAll(/<input[^>]*type="checkbox"[^>]*aria-label="([^"]+)"[^>]*>/g)].map((m) => ({ name: m[1], checked: /checked=""/.test(m[0]) }));

describe("FieldTreeView", () => {
  it("lists a dataset's columns, then its measures with the fx mark, and the params", () => {
    const markup = html(undefined);
    expect(markup.indexOf(">id<")).toBeLessThan(markup.indexOf(">region<"));
    expect(markup.indexOf(">region<")).toBeLessThan(markup.indexOf(">revenue<"));
    expect(markup).toContain("ƒx");
    expect(markup).toContain("discount");
    expect(markup).toContain("0.1");
    expect(markup).toContain('draggable="true"');
  });

  it("shows only the dataset while it is closed", () => {
    const markup = html(undefined, false);
    expect(markup).toContain("orders");
    expect(markup).not.toContain(">region<");
  });

  it("has no checkbox without a selected widget", () => {
    expect(checkboxes(html(undefined))).toEqual([]);
  });

  it("checks a chart's measures and marks its x column", () => {
    const markup = html(chart);
    expect(checkboxes(markup)).toEqual([{ name: "revenue", checked: true }]);
    expect(markup).toContain('aria-pressed="true"');
  });

  it("checks the columns a table shows", () => {
    expect(checkboxes(html(table))).toEqual([
      { name: "id", checked: true },
      { name: "region", checked: false },
    ]);
  });
});
