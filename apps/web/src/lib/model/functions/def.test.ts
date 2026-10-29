import { describe, expect, it } from "vitest";

import type { Call, Expr } from "../ast";
import { parse } from "../parse";
import { bind, fail, list, merge, ModelError, needAggregate, noText, variadic, type Typed } from "./def";

function callOf(source: string): Call {
  const [s] = parse(`x = ${source}`).statements;
  if (s.kind !== "assign" || s.value.kind !== "call") throw new Error("not a call");
  return s.value;
}

function exprOf(source: string): Expr {
  const [s] = parse(`x = ${source}`).statements;
  if (s.kind !== "assign") throw new Error("not an assignment");
  return s.value;
}

const P = { params: ["a", "b", "c"], required: 2, positional: 2 };

/** the message a function throws */
function thrown(f: () => unknown): string {
  try {
    f();
  } catch (e) {
    if (e instanceof ModelError) return e.message;
    throw e;
  }
  throw new Error("did not throw");
}

describe("bind", () => {
  it("matches positional and keyword arguments to names", () => {
    const call = callOf("f(1, c=3, b=2)");
    expect(Object.keys(bind(call, P))).toEqual(["a", "c", "b"]);
    expect(Object.keys(bind(callOf("f(1, 2)"), P))).toEqual(["a", "b"]);
  });

  it("says what is missing, unknown, repeated or too many", () => {
    expect(thrown(() => bind(callOf("f(1)"), P))).toBe("f() is missing `b`");
    expect(thrown(() => bind(callOf("f()"), P))).toBe("f() is missing `a`, `b`");
    expect(thrown(() => bind(callOf("f(1, 2, z=1)"), P))).toBe("f() has no argument named z");
    expect(thrown(() => bind(callOf("f(1, 2, a=1)"), P))).toBe("f() got a twice");
    expect(thrown(() => bind(callOf("f(1, 2, 3)"), P))).toBe("f() takes 2 arguments; pass c by name, got 3");
    expect(thrown(() => bind(callOf("f(1, 2)"), { params: ["a"], required: 1, positional: 1 }))).toBe("f() takes 1 argument, got 2");
  });

  it("points the error at the offending argument", () => {
    const call = callOf("f(1, 2, 3)");
    try {
      bind(call, P);
    } catch (e) {
      expect((e as ModelError).span).toEqual(call.args[2].span);
    }
  });
});

describe("merge", () => {
  const num = (level: Typed["level"], datasets: string[] = [], bare?: Typed["bare"]) => ({
    node: exprOf("1"),
    typed: { level, sql: ["x"], datasets, bare },
  });

  it("takes the highest level and the datasets in order, without repeats", () => {
    expect(merge([num("scalar"), num("row", ["a", "b"], { text: "a.x", span: exprOf("1").span })])).toMatchObject({ level: "row", datasets: ["a", "b"] });
    expect(merge([num("scalar"), num("aggregate", ["b"]), num("aggregate", ["a", "b"])])).toMatchObject({ level: "aggregate", datasets: ["b", "a"] });
    expect(merge([num("scalar"), num("scalar")])).toMatchObject({ level: "scalar", datasets: [] });
  });

  it("refuses a row next to an aggregate and names the first bare column", () => {
    const bare = (text: string) => ({ text, span: exprOf("1").span });
    const parts = [num("row", ["a"], bare("a.x")), num("row", ["a"], bare("a.y")), num("aggregate", ["a"])];
    expect(thrown(() => merge(parts))).toBe("`a.x` must be inside an aggregation, e.g. sum(a.x)");
  });
});

describe("noText and fail", () => {
  it("refuses text where numbers are needed", () => {
    expect(() => noText(exprOf("1"), { level: "scalar", sql: ["1"], datasets: [] })).not.toThrow();
    expect(thrown(() => noText(exprOf("'a'"), { level: "scalar", sql: ["'a'"], datasets: [], text: true }))).toContain("arithmetic needs numbers");
  });

  it("fail throws a ModelError carrying the span", () => {
    const e = exprOf("1");
    expect(() => fail(e, "no")).toThrow(ModelError);
  });
});

describe("variadic", () => {
  it("lets the named keywords through, by name, and refuses the others", () => {
    expect(Object.keys(variadic(callOf("f(1, 2, default=3)"), ["default"]))).toEqual(["default"]);
    expect(variadic(callOf("f(1, 2)"))).toEqual({});
    expect(thrown(() => variadic(callOf("f(1, other=3)"), ["default"]))).toBe("f() has no argument named other");
    expect(thrown(() => variadic(callOf("f(default=3)")))).toBe("f() has no argument named default");
  });
});

describe("needAggregate", () => {
  const typed = (level: Typed["level"], bare?: Typed["bare"]): Typed => ({ level, sql: ["x"], datasets: [], bare });

  it("takes an aggregation", () => {
    expect(() => needAggregate("calculate", exprOf("1"), typed("aggregate"))).not.toThrow();
  });

  it("asks a bare column to be wrapped, pointing at the column", () => {
    const span = exprOf("1").span;
    expect(thrown(() => needAggregate("calculate", exprOf("1"), typed("row", { text: "orders.a", span })))).toBe("`orders.a` must be inside an aggregation, e.g. sum(orders.a)");
  });

  it("refuses a fixed value, naming the function", () => {
    expect(thrown(() => needAggregate("ytd", exprOf("1"), typed("scalar")))).toBe("ytd() needs a measure or an aggregation like sum(orders.total), not a fixed value");
  });
});

describe("list", () => {
  it("joins with commas and an and", () => {
    expect([list([]), list(["a"]), list(["a", "b"]), list(["a", "b", "c"])]).toEqual(["", "a", "a and b", "a, b and c"]);
  });
});
