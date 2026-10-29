import { describe, expect, it } from "vitest";

import type { ChartWidget, FilterWidget, TableWidget } from "./types";
import { checkWidget, newWidgetId, parseWidget, textWidget, widgetJson } from "./widgets";

const chart: ChartWidget = { id: "aaaaaaaa", kind: "chart", title: "Revenue", dataset: "sales", spec: { kind: "bar", x: "region", y: ["amount"], agg: "sum", group: null } };
const table: TableWidget = { id: "bbbbbbbb", kind: "table", dataset: "sales", columns: ["region", "amount"] };
const fieldFilter: FilterWidget = {
  id: "cccccccc",
  kind: "filter",
  control: "multi",
  fields: [{ dataset: "sales", column: "region" }],
  value_type: "text",
};
const paramFilter: FilterWidget = { id: "dddddddd", kind: "filter", title: "Year", control: "select", param: "year" };
const styledChart: ChartWidget = {
  ...chart,
  style: { series: { amount: { axis: "right", as: "line" } }, labels: true, format: { style: "currency", currency: "BRL", decimals: 2 } },
};
const measureChart: ChartWidget = { ...chart, measures: ["revenue", "margin_pct"] };
const formattedTable: TableWidget = {
  ...table,
  formats: { amount: { number: { style: "percent", decimals: 1 }, rules: [{ op: "<", value: 0, tone: "red" }], scale: { high: "green", low: "red" } } },
};

describe("parseWidget / widgetJson", () => {
  it.each([chart, table, fieldFilter, paramFilter, styledChart, formattedTable, measureChart])("round-trips a $kind widget", (w) => {
    expect(parseWidget(w.id, widgetJson(w as never))).toEqual(w);
  });

  it("writes without the id, in a stable order, indented, with a trailing newline", () => {
    const shuffled = { spec: chart.spec, dataset: "sales", title: "Revenue", kind: "chart", id: "aaaaaaaa" } as ChartWidget;
    const text = widgetJson(shuffled);
    expect(text).toBe(widgetJson(chart));
    expect(text.startsWith('{\n  "kind": "chart",\n  "title": "Revenue",\n  "dataset": "sales",\n  "spec": {')).toBe(true);
    expect(text).not.toContain("aaaaaaaa");
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("writes the measures after the spec, and leaves them out when there are none", () => {
    const text = widgetJson({ ...measureChart, style: { labels: true } });
    expect(text.indexOf('"spec"')).toBeLessThan(text.indexOf('"measures"'));
    expect(text.indexOf('"measures"')).toBeLessThan(text.indexOf('"style"'));
    expect(widgetJson(chart)).not.toContain("measures");
  });

  it("takes the id from the file name and drops unknown keys", () => {
    const w = parseWidget("eeeeeeee", JSON.stringify({ id: "zzzzzzzz", kind: "table", dataset: "sales", foo: 1 }));
    expect(w).toEqual({ id: "eeeeeeee", kind: "table", dataset: "sales" });
  });

  it.each([
    ["not json", /not valid JSON/],
    ["[]", /is an object/],
    [{ kind: "map" }, /kind is one of/],
    [{ kind: "text", markdown: "x" }, /\.md file/],
    [{ kind: "chart", spec: chart.spec }, /dataset is missing/],
    [{ kind: "chart", dataset: "s" }, /spec is an object/],
    [{ kind: "chart", dataset: "s", spec: { ...chart.spec, kind: "radar" } }, /spec kind/],
    [{ kind: "chart", dataset: "s", spec: { ...chart.spec, y: "amount" } }, /spec y/],
    [{ kind: "chart", dataset: "s", spec: { ...chart.spec, agg: "median" } }, /spec agg/],
    [{ kind: "chart", dataset: "s", spec: { ...chart.spec, bins: 0 } }, /spec bins/],
    [{ kind: "chart", dataset: "s", spec: chart.spec, measures: "revenue" }, /measures is a list of text/],
    [{ kind: "chart", dataset: "s", spec: chart.spec, measures: [] }, /1 to 10/],
    [{ kind: "chart", dataset: "s", spec: chart.spec, measures: Array.from({ length: 11 }, (_, i) => `m${i}`) }, /1 to 10/],
    [{ kind: "chart", dataset: "s", spec: chart.spec, measures: ["revenue", "revenue"] }, /name twice/],
    [{ kind: "chart", dataset: "s", spec: chart.spec, measures: ["1st"] }, /not a measure name/],
    [{ kind: "chart", dataset: "s", spec: chart.spec, measures: ["a b"] }, /not a measure name/],
    [{ kind: "chart", dataset: "s", spec: chart.spec, measures: [3] }, /list of text/],
    [{ kind: "table", dataset: "s", columns: "a" }, /columns is a list/],
    [{ kind: "filter", control: "slider", param: "p" }, /control is one of/],
    [{ kind: "filter", control: "select" }, /either fields or a param/],
    [{ kind: "filter", control: "select", param: "p", fields: [{ dataset: "s", column: "c" }], value_type: "text" }, /either fields or a param/],
    [{ kind: "filter", control: "select", param: "not a name" }, /param is the name/],
    [{ kind: "filter", control: "select", fields: [], value_type: "text" }, /fields is a list/],
    [{ kind: "filter", control: "select", fields: [{ dataset: "s", column: "c" }] }, /value_type is one of/],
    [{ kind: "filter", control: "select", fields: [{ dataset: "s", column: "c" }], value_type: "boolean" }, /value_type is one of/],
    [{ kind: "filter", control: "select", fields: [{ dataset: "s" }], value_type: "text" }, /field column/],
  ])("refuses %j", (value, error) => {
    expect(() => parseWidget("aaaaaaaa", typeof value === "string" ? value : JSON.stringify(value))).toThrow(error);
  });

  it("refuses an id that is not 8 characters of a-z and 0-9", () => {
    expect(() => parseWidget("A", widgetJson(table))).toThrow(/invalid widget id/);
  });
});

describe("checkWidget", () => {
  it("takes a text widget (an action's input)", () => {
    expect(checkWidget("ffffffff", { kind: "text", markdown: "# Hi", extra: 1 })).toEqual(textWidget("ffffffff", "# Hi"));
    expect(() => checkWidget("ffffffff", { kind: "text" })).toThrow(/markdown/);
  });

  it("takes up to 10 measures on a chart, and drops them from a widget that is not one", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `m_${i}`);
    expect(checkWidget("aaaaaaaa", { ...chart, measures: ten })).toEqual({ ...chart, measures: ten });
    expect(checkWidget("bbbbbbbb", { ...table, measures: ["revenue"] })).not.toHaveProperty("measures");
  });

  it("refuses a bad tone in a table's formats", () => {
    const bad = { ...table, formats: { amount: { rules: [{ op: ">", value: 1, tone: "purple" }] } } };
    expect(() => checkWidget("aaaaaaaa", bad)).toThrow(/rule tone is one of/);
  });
});

describe("newWidgetId", () => {
  it("is 8 characters of a-z and 0-9", () => {
    expect(newWidgetId()).toMatch(/^[a-z0-9]{8}$/);
  });
});
