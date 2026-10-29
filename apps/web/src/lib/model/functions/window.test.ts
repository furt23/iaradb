import { describe, expect, it } from "vitest";

import { checkModel } from "../check";
import { render } from "../parts";
import type { Measure } from "../types";

const SCHEMA = { orders: ["id", "total", "status", "created"], customers: ["id"] };
const CAL = "dates = calendar(orders.created)\n";

const check = (source: string) => checkModel(source, SCHEMA);
const messages = (source: string) => check(source).diagnostics.map((d) => d.message);
const measure = (source: string, name = "m"): Measure => {
  const m = check(source).model.measures.find((x) => x.name === name);
  if (!m) throw new Error(`no measure ${name}: ${messages(source).join("; ")}`);
  return m;
};

describe("running_total", () => {
  it("gives every atom the running window, without a calendar", () => {
    const m = measure("m = running_total(sum(orders.total))");
    expect(m.atoms).toEqual([{ dataset: "orders", sql: 'SUM("total")', agg: "sum", window: { kind: "running" } }]);
    expect(m.expr).toEqual([{ atom: 0 }]);
  });

  it("goes over an average's two atoms, and over a ratio's", () => {
    expect(measure("m = running_total(avg(orders.total))").atoms.map((a) => [a.agg, a.window?.kind])).toEqual([["sum", "running"], ["count", "running"]]);
    expect(measure("m = running_total(sum(orders.total) / count_rows(orders))").atoms.map((a) => a.window?.kind)).toEqual(["running", "running"]);
  });

  it("keeps the context calculate gave, in either order", () => {
    const filter = 'orders.status == "paid"';
    const a = measure(`m = running_total(calculate(sum(orders.total), ${filter}))`).atoms[0];
    const b = measure(`m = calculate(running_total(sum(orders.total)), ${filter})`).atoms[0];
    expect(a).toEqual(b);
    expect(a.window).toEqual({ kind: "running" });
    expect(a.context?.removed).toEqual([{ dataset: "orders", column: "status" }]);
  });

  it("cannot add up a distinct count, and takes one window", () => {
    expect(messages("m = running_total(count_distinct(orders.id))")).toEqual(["count_distinct cannot be accumulated by running_total"]);
    expect(messages("m = running_total(running_total(sum(orders.total)))")).toEqual(["running_total cannot wrap running_total"]);
    expect(messages(`${CAL}m = running_total(ytd(sum(orders.total)))`)).toEqual(["running_total cannot wrap ytd"]);
    expect(messages(`${CAL}m = running_total(previous_year(sum(orders.total)))`)).toEqual(["running_total cannot wrap previous_year"]);
    expect(messages("m = running_total(rolling(sum(orders.total), 2))")).toEqual(["running_total cannot wrap rolling"]);
  });

  it("needs an aggregation or a measure", () => {
    expect(messages("m = running_total(orders.total)")).toEqual(["`orders.total` must be inside an aggregation, e.g. sum(orders.total)"]);
    expect(messages("m = running_total(3)")).toEqual(["running_total() needs a measure or an aggregation like sum(orders.total), not a fixed value"]);
  });
});

describe("rank", () => {
  it("is a template of a rank over the template of the measure", () => {
    const m = measure("m = rank(sum(orders.total))");
    expect(m.atoms).toEqual([{ dataset: "orders", sql: 'SUM("total")', agg: "sum" }]);
    expect(m.expr).toEqual([{ rank: [{ atom: 0 }] }]);
    expect(m.datasets).toEqual(["orders"]);
  });

  it("ranks a measure used by name as the measure is, in parentheses", () => {
    expect(measure("r = sum(orders.total)\nm = rank(r)").expr).toEqual([{ rank: ["(", { atom: 0 }, ")"] }]);
    expect(measure("r = sum(orders.total) / count_rows(orders)\nm = rank(r)").expr).toEqual([
      { rank: ["((CAST((", { atom: 0 }, ") AS DOUBLE) / (", { atom: 1 }, ")))"] },
    ]);
  });

  it("is an aggregate, so it goes in a condition or an if_", () => {
    const m = measure("r = sum(orders.total)\nm = rank(r) <= 3");
    expect(m.expr).toEqual(["(", { rank: ["(", { atom: 0 }, ")"] }, " <= 3)"]);
    expect(messages("r = sum(orders.total)\nm = if_(rank(r) <= 3, r, 0)")).toEqual([]);
    expect(messages("m = rank(sum(orders.total)) + orders.total")[0]).toContain("`orders.total` must be inside an aggregation");
  });

  it("counts its atoms once however often the rank is written, and with the other atoms", () => {
    const m = measure("r = sum(orders.total)\nm = rank(r) + rank(r) + r");
    expect(m.atoms).toHaveLength(1);
    expect(m.expr.filter((p) => typeof p === "object").map((p) => Object.keys(p))).toEqual([["rank"], ["rank"], ["atom"]]);
  });

  it("ranks what has a context, and goes inside a measure that has none", () => {
    const m = measure('m = rank(calculate(sum(orders.total), orders.status == "paid"))');
    expect(m.atoms[0].context?.filters).toHaveLength(1);
    expect(m.expr).toEqual([{ rank: [{ atom: 0 }] }]);
  });

  it("renders with the compiler's own text for the rank", () => {
    const m = measure("m = rank(sum(orders.total)) * 2");
    expect(render(m.expr, (i) => m.atoms[i].sql, (inner) => `RANK(${inner})`)).toBe('(RANK(SUM("total")) * 2)');
  });

  it("cannot rank a rank, even inside an expression", () => {
    expect(messages("m = rank(rank(sum(orders.total)))")).toEqual(["rank cannot wrap rank"]);
    expect(messages("r = rank(sum(orders.total))\nm = rank(r)")).toEqual(["rank cannot wrap rank"]);
    expect(messages("m = rank(rank(sum(orders.total)) + 1)")).toEqual(["rank cannot wrap rank"]);
  });

  it("cannot be wrapped by a window or calculate", () => {
    expect(messages(`${CAL}m = ytd(rank(sum(orders.total)))`)).toEqual(["ytd cannot wrap rank"]);
    expect(messages("m = running_total(rank(sum(orders.total)))")).toEqual(["running_total cannot wrap rank"]);
    expect(messages("m = rolling(rank(sum(orders.total)), 2)")).toEqual(["rolling cannot wrap rank"]);
    expect(messages(`${CAL}m = previous_year(rank(sum(orders.total)))`)).toEqual(["previous_year cannot wrap rank"]);
    expect(messages('m = calculate(rank(sum(orders.total)), orders.status == "a")')).toEqual(["calculate cannot wrap rank"]);
  });

  it("can be wrapped by a window through the measure it ranks, and ranks a windowed measure", () => {
    const m = measure(`${CAL}m = rank(ytd(sum(orders.total)))`);
    expect(m.atoms[0].window).toEqual({ kind: "to_date", period: "year" });
    expect(m.expr).toEqual([{ rank: [{ atom: 0 }] }]);
  });

  it("needs an aggregation or a measure, one argument", () => {
    expect(messages("m = rank(orders.total)")).toEqual(["`orders.total` must be inside an aggregation, e.g. sum(orders.total)"]);
    expect(messages("m = rank(1)")).toEqual(["rank() needs a measure or an aggregation like sum(orders.total), not a fixed value"]);
    expect(messages("m = rank()")).toEqual(["rank() is missing `measure`"]);
    expect(messages("m = rank(sum(orders.total), customers.id)")).toEqual(["rank() takes 1 argument, got 2"]);
  });

  it("lists the datasets of the atoms inside", () => {
    expect(measure("m = rank(sum(orders.total)) + sum(customers.id)").datasets).toEqual(["orders", "customers"]);
  });
});
