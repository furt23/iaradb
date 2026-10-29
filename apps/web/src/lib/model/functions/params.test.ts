import { describe, expect, it } from "vitest";

import { checkModel } from "../check";
import { render } from "../parts";

const SCHEMA = { orders: ["a", "b", "status"] };
const check = (source: string) => checkModel(source, SCHEMA);
const messages = (source: string) => check(source).diagnostics.map((d) => d.message);
const sqlOf = (source: string, name = "m") => {
  const m = check(source).model.measures.find((x) => x.name === name);
  return m && render(m.expr, (i) => m.atoms[i].sql);
};

describe("param", () => {
  it("is :name in the SQL, scalar, and a constant when assigned", () => {
    expect(sqlOf('rate = param("rate", 0.1)\nm = sum(orders.a) * rate')).toBe('(SUM("a") * :rate)');
    expect(sqlOf('rate = param("rate", 0.1)\nm = sum(orders.a * rate)')).toBe('SUM(("a" * :rate))');
    expect(check('rate = param("rate", 0.1)').model.measures).toEqual([]);
  });

  it("can be used inline, in a measure or a calculate filter", () => {
    expect(sqlOf('m = sum(orders.a) * param("rate", 0.1)')).toBe('(SUM("a") * :rate)');
    const [m] = check('m = calculate(sum(orders.a), orders.b > param("min", 10))').model.measures;
    expect(m.atoms[0].context?.filters).toEqual([{ dataset: "orders", sql: '("b" > :min)' }]);
  });

  it("lists each param once, in file order, however often it is used", () => {
    const source = ['m = sum(orders.a) * param("rate", 0.1)', 'n = sum(orders.b) * param("rate", 0.1)', 'k = param("k", 2)', 'o = sum(orders.a) * k + param("z", 1)'].join("\n");
    const { model, diagnostics } = check(source);
    expect(diagnostics).toEqual([]);
    expect(model.params.map((p) => [p.name, p.default, p.span.line])).toEqual([["rate", 0.1, 1], ["k", 2, 3], ["z", 1, 4]]);
  });

  it("takes a number, a negative or signed one, or a string", () => {
    const defaults = (src: string) => check(src).model.params.map((p) => p.default);
    expect(defaults('a = param("a", 5)\nb = param("b", -2.5)\nc = param("c", +3)\nd = param("d", "x y")\ne = param("e", 1_000)\nf = param("f", 1e3)')).toEqual([
      5, -2.5, 3, "x y", 1000, 1000,
    ]);
  });

  it("is text when its default is, so arithmetic on it is refused", () => {
    expect(messages('s = param("s", "x")\nm = sum(orders.a) * s')[0]).toContain("arithmetic needs numbers");
    expect(messages('s = param("s", "x")\nm = sum(if_(orders.status == s, 1, 0))')).toEqual([]);
    expect(sqlOf('s = param("s", "x")\nm = sum(if_(orders.status == s, 1, 0))')).toBe('SUM(CASE WHEN ("status" = :s) THEN 1 ELSE 0 END)');
  });

  it("can be used by name before the line that declares it", () => {
    expect(messages('m = sum(orders.a) * rate\nrate = param("rate", 2)')).toEqual([]);
    expect(sqlOf('m = sum(orders.a) * rate\nrate = param("rate", 2)')).toBe('(SUM("a") * :rate)');
  });

  it("keeps the first default when the same name is declared again with the same one, and refuses another", () => {
    expect(messages('rate = param("rate", 0.1)\nm = sum(orders.a) * param("rate", 0.1)')).toEqual([]);
    expect(messages('rate = param("rate", 0.1)\nm = sum(orders.a) * param("rate", 0.2)')).toEqual(['param "rate" already has the default 0.1 on line 1']);
    expect(messages('m = sum(if_(orders.status == param("s", "a"), 1, 0)) + sum(if_(orders.status == param("s", "b"), 1, 0))')).toEqual(['param "s" already has the default "a" on line 1']);
    expect(messages('m = sum(orders.a) * param("n", 1)\nk = sum(orders.a) * param("n", "1")')).toEqual(['param "n" already has the default 1 on line 1']);
    expect(check('m = sum(orders.a) * param("n", 1)\nk = sum(orders.a) * param("n", "1")').model.params).toHaveLength(1);
  });

  it("has to be named like the line it is assigned to", () => {
    expect(messages('r = param("rate", 0.1)')).toEqual(['the param name has to be the same as the name it is assigned to: r = param("r", ...)']);
    expect(check('r = param("rate", 0.1)').model.params).toEqual([]);
    expect(messages('m = measure(sum(orders.a) * param("rate", 1))')).toEqual([]);
  });

  it("needs an identifier that does not start with _", () => {
    expect(messages('m = sum(orders.a) * param("_x", 1)')).toEqual(['param names starting with _ are reserved: "_x"']);
    for (const bad of ["", "1a", "a b", "a-b", "é", "a.b"]) {
      expect(messages(`m = sum(orders.a) * param("${bad}", 1)`)).toEqual([`a param name is letters, digits and _, starting with a letter: "${bad}"`]);
    }
    expect(messages('m = sum(orders.a) * param("A_1", 1)')).toEqual([]);
  });

  it("needs a name in quotes and a literal default", () => {
    expect(messages("m = sum(orders.a) * param(rate, 1)")).toEqual(['the name must be a string in quotes, e.g. param("discount", 0.1)']);
    for (const bad of ["True", "None", "orders.a", "sum(orders.a)", "1 + 1", "-orders.a", "1e999"]) {
      expect(messages(`m = sum(orders.a) * param("p", ${bad})`)[0], bad).toBe("the default must be a number or a string in quotes");
    }
    expect(messages('m = param("p")')).toEqual(["param() is missing `default`"]);
    expect(messages('m = param("p", 1, 2)')).toEqual(["param() takes 2 arguments, got 3"]);
  });

  it("points the name error at the name and the conflict at the call", () => {
    expect(check('m = sum(orders.a) * param("_x", 1)').diagnostics[0]).toMatchObject({ from: 26, to: 30 });
  });

  it("does not take a name a dataset, a function or an earlier line has", () => {
    expect(messages('orders = param("orders", 1)')).toEqual(["`orders` is a dataset name: pick another name"]);
    expect(messages('sum = param("sum", 1)')).toEqual(["`sum` is a function name: pick another name"]);
    expect(messages('rate = sum(orders.a)\nrate = param("rate", 1)')).toEqual(["`rate` is already defined"]);
    expect(messages('rate = param("rate", 1)\nrate = sum(orders.a)')).toEqual(["`rate` is already defined"]);
    expect(messages('rate = param("rate", 1)\nrate = param("rate", 1)')).toEqual(["`rate` is already defined"]);
  });

  it("says `x` has an error for what uses a param that did not check", () => {
    expect(messages('rate = param("rate", None)\nm = sum(orders.a) * rate')).toEqual(["the default must be a number or a string in quotes", "`rate` has an error"]);
  });
});
