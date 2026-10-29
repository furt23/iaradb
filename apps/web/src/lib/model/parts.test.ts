import { describe, expect, it } from "vitest";

import { numbered, partsOf, render, sql, text } from "./parts";
import type { Atom } from "./types";

const sum: Atom = { dataset: "orders", sql: 'SUM("a")' };
const count: Atom = { dataset: "customers", sql: "COUNT(*)" };

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
});

describe("partsOf and render", () => {
  it("take a numbered measure back to parts", () => {
    const m = numbered(sql`(${[count]} / ${[sum]})`);
    expect(partsOf(m)).toEqual(["(", count, " / ", sum, ")"]);
  });

  it("writes each atom with the text asked for", () => {
    expect(render(["(", { atom: 0 }, " / ", { atom: 1 }, ")"], (i) => `_q."__a${i}"`)).toBe('(_q."__a0" / _q."__a1")');
  });
});
