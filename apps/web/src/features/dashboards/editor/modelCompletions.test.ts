import { describe, expect, it } from "vitest";

import { CALENDAR_COLUMNS } from "@/lib/model/types";

import { modelCompletions, type ModelNames } from "./modelCompletions";

const span = { from: 0, to: 0, line: 1, col: 1 };
const ctx: ModelNames = {
  model: {
    measures: [{ name: "revenue", datasets: ["orders"], atoms: [], expr: [], span }],
    calendars: [{ name: "dates", columns: [{ dataset: "orders", column: "placed" }], span }],
    params: [{ name: "discount", default: 0.1, span }],
  },
  schema: { orders: ["id", "total", "placed"], loose: null },
  functions: [{ name: "sum", signature: "sum(expr)", doc: "Total of the values." }],
  t: (key) => key,
};

const labels = (code: string, cursor = code.length) => modelCompletions(code, cursor, ctx).items.map((i) => i.label);

describe("modelCompletions", () => {
  it("lists a dataset's columns after its name and a dot", () => {
    expect(modelCompletions("total = sum(orders.", 19, ctx)).toMatchObject({ from: 19 });
    expect(labels("total = sum(orders.")).toEqual(["id", "total", "placed"]);
    expect(labels("total = sum(orders.to")).toEqual(["id", "total", "placed"]);
    expect(modelCompletions("sum(orders.to", 13, ctx).from).toBe(11);
  });

  it("lists the calendar columns after a calendar's name", () => {
    expect(labels("by_day = sum(dates.")).toEqual([...CALENDAR_COLUMNS]);
  });

  it("offers nothing after an unknown name or a dataset that was not read", () => {
    expect(labels("sum(nope.")).toEqual([]);
    expect(labels("sum(loose.")).toEqual([]);
    expect(labels("sum(1.")).toEqual([]);
  });

  it("otherwise lists measures, datasets, calendars, params and functions, each with what it is", () => {
    const items = modelCompletions("x = re", 6, ctx);
    expect(items.from).toBe(4);
    expect(items.items.map((i) => [i.label, i.type])).toEqual([
      ["revenue", "variable"],
      ["orders", "class"],
      ["loose", "class"],
      ["dates", "namespace"],
      ["discount", "constant"],
      ["sum", "function"],
    ]);
    expect(items.items.find((i) => i.label === "sum")).toMatchObject({ detail: "sum(expr)", signature: "sum(expr)", doc: "Total of the values." });
    expect(items.items.find((i) => i.label === "discount")?.detail).toBe("Parameter = 0.1");
  });

  it("completes on the line of the cursor", () => {
    expect(modelCompletions("a = sum(orders.total)\nb = di", 28, ctx).from).toBe(26);
    expect(labels("a = 1\nb = orders.", 17)).toEqual(["id", "total", "placed"]);
  });

  it("is silent in a comment or a string", () => {
    expect(labels("# one measure per line: orders.")).toEqual([]);
    expect(labels('x = "revenue')).toEqual([]);
    expect(labels("x = 'a' + re")).not.toEqual([]);
    expect(labels("# a comment\nx = re")).not.toEqual([]);
  });
});
