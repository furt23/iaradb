import { describe, expect, it } from "vitest";

import type { ColumnInfo } from "@iara/protocol";

import { checkWidget } from "@/lib/dashboards/widgets";

import { filterOver, filterValueType, newLayoutItem, newWidget, sameLayout, valueTypeOf, widgetLabel } from "./newWidget";

const columns: ColumnInfo[] = [
  { name: "revenue", type: "double" },
  { name: "day", type: "date32" },
  { name: "region", type: "string_view" },
];

describe("newWidget", () => {
  it("makes widgets the server accepts", () => {
    for (const kind of ["chart", "counter", "table", "text", "filter"] as const) {
      const w = newWidget(kind, "abcd1234", "sales", columns)!;
      expect(checkWidget(w.id, w)).toEqual(w);
    }
  });

  it("charts the columns, and counts rows in a counter", () => {
    expect(newWidget("chart", "abcd1234", "sales", columns)).toMatchObject({ kind: "chart", dataset: "sales", spec: { kind: "line", x: "day", y: ["revenue"] } });
    expect(newWidget("counter", "abcd1234", "sales", [])).toMatchObject({ kind: "chart", spec: { kind: "counter", agg: "count", y: [] } });
  });

  it("still gives a chart when the columns are not known", () => {
    expect(newWidget("chart", "abcd1234", "sales", [])).toMatchObject({ spec: { x: "", y: [] } });
  });

  it("starts text with a title to replace", () => {
    expect(newWidget("text", "abcd1234", "", [])).toEqual({ id: "abcd1234", kind: "text", markdown: "## Title\n\nWrite here." });
  });
});

describe("filters", () => {
  it("narrow by the first text column, typed by it", () => {
    expect(newWidget("filter", "abcd1234", "sales", columns)).toMatchObject({ control: "select", fields: [{ dataset: "sales", column: "region" }], value_type: "text" });
  });

  it("fall back to the first column, whatever its type", () => {
    expect(filterOver("sales", columns.slice(0, 2))).toEqual({ fields: [{ dataset: "sales", column: "revenue" }], value_type: "number" });
    expect(filterOver("sales", [])).toBeNull();
    expect(newWidget("filter", "abcd1234", "sales", [])).toBeNull();
  });

  it("type their values by the column, except for dates and text search", () => {
    expect(valueTypeOf("int64")).toBe("number");
    expect(valueTypeOf("timestamp[us]")).toBe("date");
    expect(valueTypeOf("string")).toBe("text");
    expect(filterValueType("multi", "int64")).toBe("number");
    expect(filterValueType("date_range", "string")).toBe("date");
    expect(filterValueType("text", "int64")).toBe("text");
  });
});

describe("layout", () => {
  it("sizes by kind and puts the widget below the others", () => {
    const first = newLayoutItem([], newWidget("chart", "aaaaaaaa", "sales", columns)!);
    expect(first).toEqual({ widget: "aaaaaaaa", x: 0, y: 0, w: 6, h: 8 });
    const layout = [first];
    expect(newLayoutItem(layout, newWidget("counter", "bbbbbbbb", "sales", [])!)).toEqual({ widget: "bbbbbbbb", x: 0, y: 8, w: 3, h: 4 });
    expect(newLayoutItem(layout, newWidget("filter", "cccccccc", "sales", columns)!)).toMatchObject({ w: 3, h: 3 });
    expect(newLayoutItem(layout, newWidget("text", "dddddddd", "", [])!)).toMatchObject({ w: 6, h: 4 });
  });

  it("compares layouts by their boxes", () => {
    const a = [{ widget: "aaaaaaaa", x: 0, y: 0, w: 6, h: 8 }];
    expect(sameLayout(a, [{ ...a[0] }])).toBe(true);
    expect(sameLayout(a, [{ ...a[0], w: 3 }])).toBe(false);
    expect(sameLayout(a, [])).toBe(false);
  });

  it("labels widgets that have no title", () => {
    expect(widgetLabel(newWidget("counter", "abcd1234", "s", [])!)).toBe("Counter");
    expect(widgetLabel(newWidget("chart", "abcd1234", "s", columns)!)).toBe("Chart");
  });
});
