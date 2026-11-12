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
  it("checks what a chart draws: its measures, its x, its legend and its values", () => {
    expect(fieldState(chart({ measures: ["revenue"] }), measure("revenue"))).toEqual({ checked: true });
    expect(fieldState(chart(), measure("revenue"))).toEqual({ checked: false });
    expect(fieldState(chart({ spec: { kind: "bar", x: "region", y: [], agg: "sum" } }), column("region"))).toEqual({ checked: true });
    expect(fieldState(chart({ spec: { kind: "bar", x: "a", y: [], agg: "sum", group: "region" } }), column("region"))).toEqual({ checked: true });
    expect(fieldState(chart({ values: [{ name: "v", dataset: "orders", column: "total", agg: "sum" }] }), column("total"))).toEqual({ checked: true });
    expect(fieldState(chart(), column("region"))).toEqual({ checked: false });
  });

  it("reads a column of another dataset as dataset.column", () => {
    const c = chart({ spec: { kind: "bar", x: "dates.year", y: [], agg: "sum" } });
    expect(fieldState(c, column("year", "dates"))).toEqual({ checked: true });
    expect(fieldState(c, column("year", "orders"))).toEqual({ checked: false });
  });

  it("sees what a chart still aggregates in the kernel", () => {
    expect(fieldState(chart({ spec: { kind: "bar", x: "region", y: ["total"], agg: "sum" } }), column("total"))).toEqual({ checked: true });
  });

  it("picks the x of a chart drawn from rows, in its own dataset", () => {
    const scatter = chart({ spec: { kind: "scatter", x: "total", y: ["tax"], agg: "none" } });
    expect(fieldState(scatter, column("total"))).toEqual({ checked: true });
    expect(fieldState(scatter, column("year", "dates"))).toBeNull();
    expect(fieldState(scatter, measure("m"))).toBeNull();
  });

  it("checks the columns of a table, all of its own while it lists none", () => {
    expect(fieldState(table(), column("id"))).toEqual({ checked: true });
    expect(fieldState(table(["id"]), column("id"))).toEqual({ checked: true });
    expect(fieldState(table(["id"]), column("region"))).toEqual({ checked: false });
    expect(fieldState(table(), column("year", "dates"))).toEqual({ checked: false });
    expect(fieldState(table(["dates.year"]), column("year", "dates"))).toEqual({ checked: true });
    expect(fieldState(table(), measure("m"))).toBeNull();
  });

  it("shows no control without a widget, or for text and filters", () => {
    expect(fieldState(undefined, measure("m"))).toBeNull();
    expect(fieldState({ id: "x", kind: "text", markdown: "" }, column("id"))).toBeNull();
    expect(fieldState({ id: "f", kind: "filter", control: "select" }, column("id"))).toBeNull();
  });
});

describe("toggleField on a chart", () => {
  const number = (name: string, dataset = "orders"): FieldRef => ({ ...column(name, dataset), type: "double" });
  const text = (name: string, dataset = "orders"): FieldRef => ({ ...column(name, dataset), type: "string" });

  it("adds a measure, and removes it the second time", () => {
    const added = toggleField(chart(), measure("revenue")) as ChartWidget;
    expect(added.measures).toEqual(["revenue"]);
    expect((toggleField(added, measure("revenue")) as ChartWidget).measures).toBeUndefined();
  });

  it("replaces the measure of a card", () => {
    expect((toggleField({ ...counter(), measures: ["a"] }, measure("b")) as ChartWidget).measures).toEqual(["b"]);
  });

  it("puts a number from any dataset among the values, summed", () => {
    expect((toggleField(chart(), number("balance", "customer")) as ChartWidget).values).toEqual([{ name: "Sum of balance", dataset: "customer", column: "balance", agg: "sum" }]);
  });

  it("tells apart two columns of one name, by dataset", () => {
    const one = toggleField(chart(), number("total")) as ChartWidget;
    const two = toggleField(one, number("total", "customer")) as ChartWidget;
    expect(two.values?.map((v) => v.name)).toEqual(["Sum of total", "Sum of total (customer)"]);
  });

  it("puts the rest on the x, then the legend, then a new x, qualified outside the chart's dataset", () => {
    const first = toggleField(chart(), text("region")) as ChartWidget;
    expect(first.spec.x).toBe("region");
    const second = toggleField(first, text("segment", "customer")) as ChartWidget;
    expect(second.spec.group).toBe("customer.segment");
    expect((toggleField(second, text("name", "nation")) as ChartWidget).spec.x).toBe("nation.name");
  });

  it("gives a pie no legend: the column takes the x", () => {
    const pie = chart({ spec: { kind: "pie", x: "region", y: [], agg: "sum" } });
    const next = toggleField(pie, text("segment")) as ChartWidget;
    expect(next.spec).toMatchObject({ x: "segment" });
    expect(next.spec.group).toBeUndefined();
  });

  it("makes a card count text, in place of what it counted", () => {
    expect((toggleField(counter(), text("region")) as ChartWidget).values).toEqual([{ name: "Count of region", dataset: "orders", column: "region", agg: "count" }]);
  });

  it("takes a column off wherever it is, the second time", () => {
    const on = chart({ spec: { kind: "bar", x: "region", y: [], agg: "sum", group: "segment" }, values: [{ name: "v", dataset: "orders", column: "total", agg: "sum" }] });
    expect((toggleField(on, column("region")) as ChartWidget).spec.x).toBe("");
    expect((toggleField(on, column("segment")) as ChartWidget).spec.group).toBeNull();
    expect((toggleField(on, column("total")) as ChartWidget).values).toBeUndefined();
  });

  it("uses the author's words for the name", () => {
    const word = (key: string, { column: c }: { column: string }) => `${key === "Sum of {{column}}" ? "Soma de" : key} ${c}`;
    expect((toggleField(chart(), number("total"), [], word) as ChartWidget).values?.[0].name).toBe("Soma de total");
  });

  it("sets the x of a chart drawn from rows, and leaves a picked one alone", () => {
    const scatter = chart({ spec: { kind: "scatter", x: "total", y: ["tax"], agg: "none" } });
    expect((toggleField(scatter, column("price")) as ChartWidget).spec.x).toBe("price");
    expect(toggleField(scatter, column("total"))).toBeNull();
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

  it("does nothing for a measure", () => {
    expect(toggleField(table(), measure("m"), COLUMNS)).toBeNull();
  });

  it("shows a column of another dataset as dataset.column, and hides it again", () => {
    const on = toggleField(table(), column("year", "dates"), COLUMNS) as TableWidget;
    expect(on.columns).toEqual([...COLUMNS, "dates.year"]);
    expect("columns" in (toggleField(on, column("year", "dates"), COLUMNS) as TableWidget)).toBe(false);
  });
});

describe("dropField", () => {
  it("does what checking does, but never unchecks", () => {
    const added = dropField(chart(), measure("revenue")) as ChartWidget;
    expect(added.measures).toEqual(["revenue"]);
    expect(dropField(added, measure("revenue"))).toBeNull();
    expect((dropField(chart(), { ...column("region"), type: "string" }) as ChartWidget).spec.x).toBe("region");
    expect(dropField(table(), column("id"), COLUMNS)).toBeNull();
    expect(dropField(table(["id"]), column("total"), COLUMNS)).toEqual(table(["id", "total"]));
  });

  it("ignores widgets that take no fields", () => {
    expect(dropField({ id: "x", kind: "text", markdown: "" }, measure("m"))).toBeNull();
  });
});
