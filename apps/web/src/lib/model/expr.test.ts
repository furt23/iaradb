import { describe, expect, it } from "vitest";

import type { Expr } from "./ast";
import { checkExpr, type Entry, type Env } from "./expr";
import { ModelError } from "./functions/def";
import { parse } from "./parse";

const measure = { name: "revenue", dataset: "orders", sql: 'SUM("a")', span: { from: 0, to: 0, line: 1, col: 1 } };
const names = new Map<string, Entry>([
  ["revenue", { kind: "measure", measure }],
  ["rate", { kind: "const", sql: "0.1" }],
  ["tag", { kind: "const", sql: "'x'", text: true }],
  ["bad", { kind: "broken" }],
]);
const env: Env = { schema: { orders: ["a", "b"], loose: null }, names, relationships: [] };

function exprOf(source: string): Expr {
  const [s] = parse(`x = ${source}`).statements;
  if (s.kind !== "assign") throw new Error("not an assignment");
  return s.value;
}

const typed = (source: string, wholeValue = false) => checkExpr(exprOf(source), env, wholeValue);
const error = (source: string) => {
  try {
    typed(source);
  } catch (e) {
    if (e instanceof ModelError) return e.message;
    throw e;
  }
  throw new Error("did not throw");
};

describe("checkExpr", () => {
  it("gives literals the scalar level", () => {
    expect(typed("1_000")).toEqual({ level: "scalar", sql: "1000", datasets: [] });
    expect(typed("'it\\'s'")).toEqual({ level: "scalar", sql: "'it''s'", datasets: [], text: true });
    expect([typed("True").sql, typed("False").sql, typed("None").sql]).toEqual(["TRUE", "FALSE", "NULL"]);
  });

  it("gives a column the row level and remembers it as the bare one", () => {
    const t = typed("orders.a");
    expect(t).toMatchObject({ level: "row", sql: '"a"', datasets: ["orders"], bare: { text: "orders.a", span: { from: 4, to: 12 } } });
  });

  it("gives a measure its sql in parentheses and the aggregate level", () => {
    expect(typed("revenue")).toEqual({ level: "aggregate", sql: '(SUM("a"))', datasets: ["orders"] });
  });

  it("writes out a constant", () => {
    expect(typed("rate")).toEqual({ level: "scalar", sql: "0.1", datasets: [], text: undefined });
    expect(typed("rate * 2").sql).toBe("(0.1 * 2)");
  });

  it("takes the highest level of the parts and the datasets in order", () => {
    expect(typed("revenue * 2")).toMatchObject({ level: "aggregate", datasets: ["orders"] });
    expect(typed("orders.a * loose.x")).toMatchObject({ level: "row", datasets: ["orders", "loose"] });
    expect(typed("rate + 1").level).toBe("scalar");
  });

  it("refuses a name that has an error, a dataset used as a value and a column that is not there", () => {
    expect(error("bad + 1")).toBe("`bad` has an error");
    expect(error("orders")).toContain("is a dataset, not a value");
    expect(error("orders.zzz")).toBe("orders has no column zzz");
    expect(error("revenue.a")).toContain("`revenue` is not a dataset");
  });

  it("refuses text in arithmetic, also through a constant", () => {
    expect(error("tag + 1")).toContain("arithmetic needs numbers");
    expect(() => typed("tag == 'x'")).not.toThrow();
  });

  it("allows measure(...) only as the whole value", () => {
    expect(typed("measure(revenue, label='R')", true)).toMatchObject({ level: "aggregate", label: "R" });
    expect(error("measure(revenue)")).toContain("has to be the whole value of a line");
    expect(error("relate(orders.a, loose.x)")).toBe("relate(...) has to be a line of its own");
  });

  it("puts the error on the node at fault", () => {
    try {
      typed("sum(orders.a) + nope(1)");
    } catch (e) {
      expect((e as ModelError).span).toMatchObject({ from: 20, to: 24 });
    }
  });
});
