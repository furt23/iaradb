import { describe, expect, it } from "vitest";

import { checkModel } from "@/lib/model/check";

import { checkNew, checkReplaced, nameOf, takenNames } from "./measureDraft";

const schema = { orders: ["id", "total", "region"] };
const source = "revenue = sum(orders.total)\nrows = count_rows(orders)\n";
const startOf = (src: string, name: string) => checkModel(src, schema).model.measures.find((m) => m.name === name)!.span.from;

describe("nameOf", () => {
  it("reads the name before the =", () => {
    expect(nameOf("revenue = sum(orders.total)")).toBe("revenue");
    expect(nameOf("  _x1=3")).toBe("_x1");
    expect(nameOf("a == b")).toBeUndefined();
    expect(nameOf("sum(orders.total)")).toBeUndefined();
    expect(nameOf("")).toBeUndefined();
  });
});

describe("checkNew", () => {
  it("accepts a new measure and reads its format", () => {
    expect(checkNew(source, "n = sum(orders.id)", schema)).toMatchObject({ ok: true, name: "n", format: undefined, diagnostics: [] });
    expect(checkNew(source, 'p = measure(sum(orders.total), format="percent", decimals=1)', schema)).toMatchObject({ ok: true, format: { style: "percent", decimals: 1 } });
  });

  it("refuses a taken name and a line with an error", () => {
    expect(checkNew(source, "revenue = sum(orders.id)", schema).ok).toBe(false);
    const bad = checkNew(source, "x = sum(orders.nope)", schema);
    expect(bad.ok).toBe(false);
    expect(bad.diagnostics.length).toBeGreaterThan(0);
  });
});

describe("checkReplaced", () => {
  const replace = (name: string, text: string) => {
    const start = startOf(source, name);
    const stmt = checkModel(source, schema).model.measures.find((m) => m.name === name)!.span;
    const next = source.slice(0, start) + text + source.slice(stmt.to);
    return checkReplaced(next, start, text, schema);
  };

  it("accepts a new expression, or a new name", () => {
    expect(replace("revenue", "revenue = sum(orders.id)")).toMatchObject({ ok: true, name: "revenue", diagnostics: [] });
    expect(replace("revenue", "total = sum(orders.total)")).toMatchObject({ ok: true, name: "total" });
    expect(replace("revenue", 'revenue = measure(sum(orders.total), format="currency")').format).toEqual({ style: "currency", currency: "BRL" });
  });

  it("places the problems of the edited text in it", () => {
    const text = "revenue = sum(orders.nope)";
    const r = replace("revenue", text);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.every((d) => d.from >= 0 && d.to <= text.length)).toBe(true);
  });

  it("leaves out the problems of other lines", () => {
    const broken = "revenue = sum(orders.total)\nbad = sum(orders.nope)\nrows = count_rows(orders)\n";
    const start = 0;
    const text = "revenue = sum(orders.id)";
    const next = text + broken.slice("revenue = sum(orders.total)".length);
    expect(checkModel(next, schema).diagnostics.length).toBeGreaterThan(0);
    expect(checkReplaced(next, start, text, schema)).toMatchObject({ ok: true, diagnostics: [] });
  });
});

describe("takenNames", () => {
  it("lists the other measures, calendars and params", () => {
    const span = { from: 0, to: 0, line: 1, col: 1 };
    const model = {
      measures: [
        { name: "a", datasets: [], atoms: [], expr: [], span },
        { name: "b", datasets: [], atoms: [], expr: [], span },
      ],
      calendars: [{ name: "dates", columns: [], span }],
      params: [{ name: "p", default: 1, span }],
    };
    expect(takenNames(model)).toEqual(["a", "b", "dates", "p"]);
    expect(takenNames(model, "a")).toEqual(["b", "dates", "p"]);
  });
});
