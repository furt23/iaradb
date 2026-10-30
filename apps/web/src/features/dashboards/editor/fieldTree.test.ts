import { describe, expect, it } from "vitest";

import type { Dataset } from "@/lib/dashboards/types";
import type { Measure, Model } from "@/lib/model/types";

import { CALENDAR_COLUMN_INFO } from "./calendarColumns";
import { buildFieldTree, typeGlyph } from "./fieldTree";

const span = { from: 0, to: 0, line: 1, col: 1 };
const dataset = (name: string): Dataset => ({ name, sql: "", params: {} });
const measure = (name: string, datasets: string[]): Measure => ({ name, datasets, atoms: [], expr: [], span });
const model: Pick<Model, "measures" | "calendars" | "params"> = {
  measures: [measure("revenue", ["orders", "customers"]), measure("headcount", ["customers"]), measure("answer", [])],
  calendars: [{ name: "dates", columns: [{ dataset: "orders", column: "placed" }], span }],
  params: [
    { name: "discount", default: 0.1, span },
    { name: "region", default: "all", span },
  ],
};
const datasets = [dataset("orders"), dataset("customers")];
const found = { orders: [{ name: "id", type: "int64" }, { name: "region", type: "string" }, { name: "placed", type: "date32" }], customers: "no such table" };
const build = (query = "", over: Partial<Parameters<typeof buildFieldTree>[0]> = {}) => buildFieldTree({ datasets, model, found, query, ...over });
const names = (tree: ReturnType<typeof build>) => tree.nodes.map((n) => n.name);

describe("buildFieldTree", () => {
  it("lists datasets then calendars, each with its columns and the measures it is the home of", () => {
    const tree = build();
    expect(tree.nodes.map((n) => [n.kind, n.name])).toEqual([
      ["dataset", "orders"],
      ["dataset", "customers"],
      ["calendar", "dates"],
    ]);
    // a measure's home is the first dataset it reads
    expect(tree.nodes[0].measures.map((m) => m.name)).toEqual(["revenue"]);
    expect(tree.nodes[1].measures.map((m) => m.name)).toEqual(["headcount"]);
    expect(tree.nodes.every((n) => !n.open)).toBe(true);
  });

  it("keeps the state of the columns: read, not read yet, or why not", () => {
    const tree = build("", { found: { ...found, orders: undefined as never } });
    expect(tree.nodes[0].columns).toBeNull();
    expect(tree.nodes[1].columns).toBe("no such table");
    expect(build().nodes[0].columns).toHaveLength(3);
  });

  it("gives a calendar its own columns without reading any", () => {
    expect(build().nodes[2].columns).toEqual(CALENDAR_COLUMN_INFO);
  });

  it("puts a measure that reads no dataset of the dashboard on its own, and lists the params", () => {
    const tree = build();
    expect(tree.loose.map((m) => m.name)).toEqual(["answer"]);
    expect(tree.params.map((p) => p.name)).toEqual(["discount", "region"]);
    // a measure of a dataset that is gone is loose too
    expect(build("", { datasets: [dataset("customers")] }).loose.map((m) => m.name)).toEqual(["revenue", "answer"]);
  });

  it("keeps what matches the search, open, whatever the case", () => {
    const tree = build("REGION");
    // the column of orders, and the param
    expect(names(tree)).toEqual(["orders"]);
    expect(tree.nodes[0]).toMatchObject({ open: true, measures: [] });
    expect((tree.nodes[0].columns as { name: string }[]).map((c) => c.name)).toEqual(["region"]);
    expect(tree.params.map((p) => p.name)).toEqual(["region"]);
    expect(tree.loose).toEqual([]);
  });

  it("finds a measure under its dataset", () => {
    const tree = build("headc");
    expect(names(tree)).toEqual(["customers"]);
    expect(tree.nodes[0]).toMatchObject({ open: true, columns: "no such table" });
    expect(tree.nodes[0].measures.map((m) => m.name)).toEqual(["headcount"]);
  });

  it("keeps all of a dataset whose own name matches, closed", () => {
    const tree = build("order");
    expect(names(tree)).toEqual(["orders"]);
    expect(tree.nodes[0].open).toBe(false);
    expect(tree.nodes[0].columns).toHaveLength(3);
    expect(tree.nodes[0].measures.map((m) => m.name)).toEqual(["revenue"]);
  });

  it("finds a calendar's column, and a loose measure", () => {
    expect(names(build("day_of"))).toEqual(["dates"]);
    expect(build("answ").loose.map((m) => m.name)).toEqual(["answer"]);
    expect(build("zzz")).toEqual({ nodes: [], loose: [], params: [] });
  });

  it("ignores spaces around the search", () => {
    expect(names(build("  customers "))).toEqual(["customers"]);
  });
});

describe("typeGlyph", () => {
  it("marks numbers, dates, booleans and the rest", () => {
    expect(typeGlyph("int64")).toBe("123");
    expect(typeGlyph("decimal128(10,2)")).toBe("123");
    expect(typeGlyph("date32")).toBe("31");
    expect(typeGlyph("timestamp(us)")).toBe("31");
    expect(typeGlyph("bool")).toBe("T/F");
    expect(typeGlyph("utf8")).toBe("Aa");
  });
});
