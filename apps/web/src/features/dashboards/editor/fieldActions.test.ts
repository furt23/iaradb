import { describe, expect, it } from "vitest";

import type { ChartWidget, TableWidget } from "@/lib/dashboards/types";

import type { FieldRef } from "../canvas/fieldDrag";
import { dropField, fieldState, toggleField } from "./fieldActions";

const chart = (extra: Partial<ChartWidget> = {}): ChartWidget => ({ id: "c", kind: "chart", dataset: "orders", spec: { kind: "bar", x: "", y: [], agg: "sum" }, ...extra });
const counter = (): ChartWidget => chart({ spec: { kind: "counter", x: "", y: [], agg: "count" } });
const table = (columns?: string[]): TableWidget => ({ id: "t", kind: "table", dataset: "orders", ...(columns && { columns }) });
const measure = (name: string): FieldRef => ({ kind: "measure", dataset: "orders", name });
const column = (name: string, dataset = "orders"): FieldRef => ({ kind: "column", dataset, name });
const COLUMNS = ["id", "region", "total"];

describe("fieldState", () => {
  it("checks a chart's measures and picks its x", () => {
    expect(fieldState(chart({ measures: ["revenue"] }), measure("revenue"))).toEqual({ control: "check", checked: true });
    expect(fieldState(chart(), measure("revenue"))).toEqual({ control: "check", checked: false });
    expect(fieldState(chart({ spec: { kind: "bar", x: "region", y: [], agg: "sum" } }), column("region"))).toEqual({ control: "pick", picked: true });
    expect(fieldState(chart(), column("region"))).toEqual({ control: "pick", picked: false });
  });

  it("reads a column of another dataset as dataset.column", () => {
    const c = chart({ spec: { kind: "bar", x: "dates.year", y: [], agg: "sum" } });
    expect(fieldState(c, column("year", "dates"))).toEqual({ control: "pick", picked: true });
    expect(fieldState(c, column("year", "orders"))).toEqual({ control: "pick", picked: false });
  });

  it("has no x column for a counter", () => {
    expect(fieldState(counter(), column("region"))).toBeNull();
    expect(fieldState(counter(), measure("m"))).toEqual({ control: "check", checked: false });
  });

  it("checks the columns of a table's own dataset, all of them while it lists none", () => {
    expect(fieldState(table(), column("id"))).toEqual({ control: "check", checked: true });
    expect(fieldState(table(["id"]), column("id"))).toEqual({ control: "check", checked: true });
    expect(fieldState(table(["id"]), column("region"))).toEqual({ control: "check", checked: false });
    expect(fieldState(table(), column("year", "dates"))).toBeNull();
    expect(fieldState(table(), measure("m"))).toBeNull();
  });

  it("shows no control without a widget, or for text and filters", () => {
    expect(fieldState(undefined, measure("m"))).toBeNull();
    expect(fieldState({ id: "x", kind: "text", markdown: "" }, column("id"))).toBeNull();
    expect(fieldState({ id: "f", kind: "filter", control: "select" }, column("id"))).toBeNull();
  });
});

describe("toggleField on a chart", () => {
  it("adds a measure, and removes it the second time", () => {
    const added = toggleField(chart(), measure("revenue")) as ChartWidget;
    expect(added.measures).toEqual(["revenue"]);
    expect((toggleField(added, measure("revenue")) as ChartWidget).measures).toBeUndefined();
  });

  it("replaces the measure of a counter", () => {
    expect((toggleField({ ...counter(), measures: ["a"] }, measure("b")) as ChartWidget).measures).toEqual(["b"]);
  });

  it("sets x to the column, qualified outside the chart's dataset, and leaves a picked x alone", () => {
    expect((toggleField(chart(), column("region")) as ChartWidget).spec.x).toBe("region");
    expect((toggleField(chart(), column("year", "dates")) as ChartWidget).spec.x).toBe("dates.year");
    expect(toggleField(chart({ spec: { kind: "bar", x: "region", y: [], agg: "sum" } }), column("region"))).toBeNull();
  });

  it("does nothing for a column of a counter", () => {
    expect(toggleField(counter(), column("region"))).toBeNull();
  });
});

describe("toggleField on a table", () => {
  it("hides a column of an unlisted table by listing the rest, in the dataset's order", () => {
    expect(toggleField(table(), column("region"), COLUMNS)).toEqual(table(["id", "total"]));
  });

  it("shows a hidden column at the end of the list", () => {
    expect(toggleField(table(["total"]), column("id"), COLUMNS)).toEqual(table(["total", "id"]));
  });

  it("lists nothing again once every column is shown in the dataset's order", () => {
    const w = toggleField(table(["id", "total"]), column("region"), COLUMNS) as TableWidget;
    expect(w.columns).toEqual(["id", "total", "region"]);
    expect("columns" in (toggleField(table(["id", "region"]), column("total"), COLUMNS) as TableWidget)).toBe(false);
  });

  it("keeps the last column, and does nothing before the columns are known", () => {
    expect(toggleField(table(["id"]), column("id"), COLUMNS)).toBeNull();
    expect(toggleField(table(), column("id"), [])).toBeNull();
  });

  it("does nothing for a measure or a column of another dataset", () => {
    expect(toggleField(table(), measure("m"), COLUMNS)).toBeNull();
    expect(toggleField(table(), column("year", "dates"), COLUMNS)).toBeNull();
  });
});

describe("dropField", () => {
  it("does what checking does, but never unchecks", () => {
    const added = dropField(chart(), measure("revenue")) as ChartWidget;
    expect(added.measures).toEqual(["revenue"]);
    expect(dropField(added, measure("revenue"))).toBeNull();
    expect((dropField(chart(), column("region")) as ChartWidget).spec.x).toBe("region");
    expect(dropField(table(), column("id"), COLUMNS)).toBeNull();
    expect(dropField(table(["id"]), column("total"), COLUMNS)).toEqual(table(["id", "total"]));
  });

  it("ignores widgets that take no fields", () => {
    expect(dropField({ id: "x", kind: "text", markdown: "" }, measure("m"))).toBeNull();
  });
});
