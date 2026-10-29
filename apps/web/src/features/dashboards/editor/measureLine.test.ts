import { describe, expect, it } from "vitest";

import { appendLines, checkAdded } from "./measureLine";

const schema = { orders: ["id", "total"] };
const source = "revenue = sum(orders.total)\n";

describe("appendLines", () => {
  it("adds the lines after the source, which ends in a line break", () => {
    expect(appendLines(source, ["a = 1"])).toBe(`${source}a = 1\n`);
    expect(appendLines("x = 1", ["a = 1", "b = 2"])).toBe("x = 1\na = 1\nb = 2\n");
    expect(appendLines("", ["a = 1"])).toBe("a = 1\n");
  });
});

describe("checkAdded", () => {
  it("accepts a line that defines a new measure", () => {
    expect(checkAdded(source, "orders_n = count_rows(orders)", schema)).toMatchObject({ ok: true, measure: "orders_n", diagnostics: [] });
    expect(checkAdded(source, "double = revenue * 2", schema).ok).toBe(true);
    expect(checkAdded("", "n = count_rows(orders)", schema).ok).toBe(true);
  });

  it("refuses a name that is taken, with the problem placed in the line", () => {
    const r = checkAdded(source, "revenue = sum(orders.id)", schema);
    expect(r.ok).toBe(false);
    expect(r.diagnostics.length).toBeGreaterThan(0);
    expect(r.diagnostics.every((d) => d.from >= 0 && d.to <= "revenue = sum(orders.id)".length)).toBe(true);
  });

  it("refuses a line with an error, and one that defines no measure", () => {
    expect(checkAdded(source, "x = sum(orders.nope)", schema).ok).toBe(false);
    expect(checkAdded(source, "x = ", schema).ok).toBe(false);
    expect(checkAdded(source, "", schema)).toMatchObject({ ok: false, diagnostics: [] });
    expect(checkAdded(source, "k = 3", schema).ok).toBe(false);
  });

  it("does not report the source's own problems", () => {
    expect(checkAdded("bad = sum(orders.nope)\n", "n = count_rows(orders)", schema)).toMatchObject({ ok: true, diagnostics: [] });
  });

  it("takes the last measure of several lines", () => {
    expect(checkAdded(source, "a = sum(orders.id)\nb = a * 2", schema)).toMatchObject({ ok: true, measure: "b" });
  });
});
