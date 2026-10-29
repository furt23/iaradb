import { describe, expect, it } from "vitest";

import { hasRank, mapAtoms, numbered, partsOf, render, sql, text, type Parts } from "./parts";
import type { Atom } from "./types";

const sum: Atom = { dataset: "orders", sql: 'SUM("a")', agg: "sum" };
const count: Atom = { dataset: "customers", sql: "COUNT(*)", agg: "count" };

describe("sql", () => {
  it("glues text and parts, joining the text that ends up side by side", () => {
    expect(sql`(${[sum]} + ${"1"})`).toEqual(["(", sum, " + 1)"]);
    expect(sql`(${["a", "b"]})`).toEqual(["(ab)"]);
    expect(sql`${[sum]}`).toEqual([sum]);
  });

  it("leaves out empty text", () => {
    expect(sql`${""}${[sum]}${[]}`).toEqual([sum]);
    expect(sql``).toEqual([]);
  });
});

describe("text", () => {
  it("joins what has no aggregation", () => {
    expect(text(["(", '"a"', " + 1)"])).toBe('("a" + 1)');
  });

  it("refuses an aggregation", () => {
    expect(() => text(["(", sum, ")"])).toThrow("cannot go inside another");
  });
});

describe("numbered", () => {
  it("numbers atoms in order of first use and puts the holes in the template", () => {
    expect(numbered(sql`(${[count]} / ${[sum]})`)).toEqual({ atoms: [count, sum], expr: ["(", { atom: 0 }, " / ", { atom: 1 }, ")"] });
  });

  it("gives the same dataset and SQL one number", () => {
    const again = { ...sum };
    expect(numbered(sql`${[sum]} + ${[again]} + ${[count]}`)).toEqual({ atoms: [sum, count], expr: [{ atom: 0 }, " + ", { atom: 0 }, " + ", { atom: 1 }] });
  });

  it("tells apart the same SQL over two datasets", () => {
    expect(numbered([sum, { ...sum, dataset: "other" }]).atoms).toHaveLength(2);
  });

  it("makes a plain aggregation [{ atom: 0 }]", () => {
    expect(numbered([sum]).expr).toEqual([{ atom: 0 }]);
  });

  it("tells apart the same SQL by how it adds up, its context and its window", () => {
    const distinct: Atom = { ...sum, agg: "count_distinct" };
    const filtered: Atom = { ...sum, context: { filters: [{ dataset: "orders", sql: '("a" > 1)' }], removed: [{ dataset: "orders", column: "a" }] } };
    const windowed: Atom = { ...sum, window: { kind: "to_date", period: "year" } };
    const both: Atom = { ...filtered, window: { kind: "to_date", period: "year" } };
    expect(numbered([sum, distinct, filtered, windowed, both]).atoms).toHaveLength(5);
    expect(numbered([windowed, { ...windowed, window: { kind: "to_date", period: "year" } }]).atoms).toHaveLength(1);
    expect(numbered([windowed, { ...windowed, window: { kind: "to_date", period: "month" } }]).atoms).toHaveLength(2);
    expect(numbered([{ ...sum, window: { kind: "rolling", n: 3 } }, { ...sum, window: { kind: "rolling", n: 4 } }]).atoms).toHaveLength(2);
  });

  it("gives atoms with the same context in another order one number", () => {
    const f1 = { dataset: "orders", sql: "x" };
    const f2 = { dataset: "customers", sql: "y" };
    const a: Atom = { ...sum, context: { filters: [f1, f2], removed: [{ dataset: "orders" }, { dataset: "customers", column: "c" }] } };
    const b: Atom = { ...sum, context: { filters: [f2, f1], removed: [{ dataset: "customers", column: "c" }, { dataset: "orders" }] } };
    expect(numbered([a, b]).expr).toEqual([{ atom: 0 }, { atom: 0 }]);
  });

  it("numbers the atoms inside a rank too, with the same numbers", () => {
    const parts: Parts = [{ rank: sql`(${[count]})` }, " + ", sum, " + ", { rank: [sum] }];
    expect(numbered(parts)).toEqual({
      atoms: [count, sum],
      expr: [{ rank: ["(", { atom: 0 }, ")"] }, " + ", { atom: 1 }, " + ", { rank: [{ atom: 1 }] }],
    });
  });

  it("keeps the atoms as they are, copied", () => {
    const { atoms } = numbered([sum]);
    expect(atoms[0]).toEqual(sum);
    expect(atoms[0]).not.toBe(sum);
  });
});

describe("hasRank and mapAtoms", () => {
  it("sees a rank at the top, and only there", () => {
    expect(hasRank(["a", sum])).toBe(false);
    expect(hasRank(["a", { rank: [sum] }])).toBe(true);
  });

  it("replaces each atom and keeps the text and the ranks", () => {
    const windowed = (a: Atom): Atom => ({ ...a, window: { kind: "running" } });
    expect(mapAtoms(["(", sum, " + ", count, ")"], windowed)).toEqual(["(", windowed(sum), " + ", windowed(count), ")"]);
    const rank = { rank: [sum] };
    expect(mapAtoms([rank], windowed)).toEqual([rank]);
  });
});

describe("partsOf and render", () => {
  it("take a numbered measure back to parts", () => {
    const m = numbered(sql`(${[count]} / ${[sum]})`);
    expect(partsOf(m)).toEqual(["(", count, " / ", sum, ")"]);
  });

  it("writes each atom with the text asked for", () => {
    expect(render(["(", { atom: 0 }, " / ", { atom: 1 }, ")"], (i) => `_q."__a${i}"`)).toBe('(_q."__a0" / _q."__a1")');
  });

  it("takes a rank back to parts, and writes it with the text asked for", () => {
    const m = numbered([{ rank: sql`(${[sum]})` }, " <= 3"]);
    expect(partsOf(m)).toEqual([{ rank: ["(", sum, ")"] }, " <= 3"]);
    expect(render(m.expr, (i) => `a${i}`, (inner) => `RANK() OVER (ORDER BY ${inner} DESC)`)).toBe("RANK() OVER (ORDER BY (a0) DESC) <= 3");
  });

  it("needs to be told how to write a rank", () => {
    expect(() => render([{ rank: [{ atom: 0 }] }], (i) => `a${i}`)).toThrow("render needs rankSql");
  });
});
