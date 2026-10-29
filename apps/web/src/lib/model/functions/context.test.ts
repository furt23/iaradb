import { describe, expect, it } from "vitest";

import { checkModel } from "../check";
import { render } from "../parts";
import type { AtomContext, Measure } from "../types";

const SCHEMA = {
  orders: ["id", "total", "status", "customer_id", "created", "qty"],
  customers: ["id", "segment", "region_id"],
  regions: ["id", "name"],
  items: ["order_id", "price"],
};
// items → orders → customers → regions
const RELATE = [
  "relate(items.order_id, orders.id)",
  "relate(orders.customer_id, customers.id)",
  "relate(customers.region_id, regions.id)",
  "r = sum(orders.total)",
  "",
].join("\n");

const check = (source: string) => checkModel(RELATE + source, SCHEMA);
const messages = (source: string) => check(source).diagnostics.map((d) => d.message);
const measure = (source: string, name = "m"): Measure => {
  const m = check(source).model.measures.find((x) => x.name === name);
  if (!m) throw new Error(`no measure ${name}: ${messages(source).join("; ")}`);
  return m;
};
const context = (source: string, atom = 0): AtomContext | undefined => measure(source).atoms[atom].context;
const sqlOf = (source: string) => {
  const m = measure(source);
  return render(m.expr, (i) => m.atoms[i].sql);
};

const PAID = { dataset: "orders", sql: "(\"status\" = 'paid')" };

describe("calculate", () => {
  it("adds a condition on the atom's own dataset and removes the filters on the column it reads", () => {
    const [atom] = measure('m = calculate(sum(orders.total), orders.status == "paid")').atoms;
    expect(atom).toEqual({
      dataset: "orders",
      sql: 'SUM("total")',
      agg: "sum",
      context: { filters: [PAID], removed: [{ dataset: "orders", column: "status" }] },
    });
  });

  it("takes a condition on a dataset the atom reaches, however far", () => {
    expect(context('m = calculate(sum(orders.total), customers.segment == "AUTO")')).toEqual({
      filters: [{ dataset: "customers", sql: "(\"segment\" = 'AUTO')" }],
      removed: [{ dataset: "customers", column: "segment" }],
    });
    expect(context('m = calculate(sum(orders.total), regions.name == "S")')?.filters).toEqual([{ dataset: "regions", sql: "(\"name\" = 'S')" }]);
    expect(context('m = calculate(sum(items.price), regions.name == "S")')?.filters).toEqual([{ dataset: "regions", sql: "(\"name\" = 'S')" }]);
  });

  it("removes every column a condition reads, once", () => {
    const c = context('m = calculate(sum(orders.total), orders.status == "a" and orders.qty > 1 or orders.status == "b")');
    expect(c?.removed).toEqual([
      { dataset: "orders", column: "status" },
      { dataset: "orders", column: "qty" },
    ]);
    expect(c?.filters).toHaveLength(1);
    expect(context("m = calculate(sum(orders.total), if_(orders.qty > 1, orders.total, 0) > 5)")?.removed).toEqual([
      { dataset: "orders", column: "qty" },
      { dataset: "orders", column: "total" },
    ]);
  });

  it("takes several conditions, on several datasets", () => {
    expect(context('m = calculate(sum(orders.total), orders.status == "paid", customers.segment == "AUTO")')).toEqual({
      filters: [PAID, { dataset: "customers", sql: "(\"segment\" = 'AUTO')" }],
      removed: [
        { dataset: "orders", column: "status" },
        { dataset: "customers", column: "segment" },
      ],
    });
  });

  it("takes a bare boolean column, and a param", () => {
    expect(context("m = calculate(sum(orders.total), orders.status)")?.filters).toEqual([{ dataset: "orders", sql: '"status"' }]);
    expect(context('m = calculate(sum(orders.total), orders.qty > param("min", 2))')?.filters).toEqual([{ dataset: "orders", sql: '("qty" > :min)' }]);
  });

  it("changes every atom of the measure", () => {
    const m = measure('m = calculate(sum(orders.total) / count_rows(orders) + sum(orders.qty), orders.status == "paid")');
    expect(m.atoms).toHaveLength(3);
    for (const a of m.atoms) expect(a.context?.filters).toEqual([PAID]);
  });

  it("changes both atoms of an average", () => {
    const m = measure('m = calculate(avg(orders.total), orders.status == "paid")');
    expect(m.atoms.map((a) => [a.agg, a.context?.filters.length])).toEqual([["sum", 1], ["count", 1]]);
  });

  it("applies to a measure by name and leaves that measure as it was", () => {
    const { model } = check('m = calculate(r, orders.status == "paid")');
    const [r, m] = model.measures;
    expect(r.atoms[0].context).toBeUndefined();
    expect(m.atoms[0].context?.filters).toEqual([PAID]);
    expect(sqlOf('m = calculate(r, orders.status == "paid")')).toBe('(SUM("total"))');
  });

  it("is an aggregate: it goes in arithmetic with other aggregates", () => {
    const m = measure('m = r / calculate(r, orders.status == "paid")');
    expect(m.atoms).toHaveLength(2);
    expect(m.atoms[0].context).toBeUndefined();
    expect(m.atoms[1].context?.filters).toEqual([PAID]);
    expect(m.expr).toEqual(["(CAST(((", { atom: 0 }, ")) AS DOUBLE) / ((", { atom: 1 }, ")))"]);
  });

  it("does not change the measure's datasets", () => {
    expect(measure('m = calculate(sum(orders.total), customers.segment == "AUTO")').datasets).toEqual(["orders"]);
  });

  it("leaves a measure alone when there is nothing to change", () => {
    expect(measure("m = calculate(r)").atoms[0]).toEqual({ dataset: "orders", sql: 'SUM("total")', agg: "sum" });
  });

  it("is a different atom from the same aggregation without it, and one atom when written twice", () => {
    expect(measure('m = r + calculate(r, orders.status == "paid")').atoms).toHaveLength(2);
    const twice = measure('m = calculate(r, orders.status == "paid") + calculate(sum(orders.total), orders.status == "paid")');
    expect(twice.atoms).toHaveLength(1);
    expect(twice.expr).toEqual(["((", { atom: 0 }, ") + ", { atom: 0 }, ")"]);
  });

  it("is one atom whatever the order of its conditions", () => {
    const m = measure('m = calculate(r, orders.status == "paid", customers.segment == "A") + calculate(r, customers.segment == "A", orders.status == "paid")');
    expect(m.atoms).toHaveLength(1);
  });

  it("keeps the same filter once when it is written twice", () => {
    expect(context('m = calculate(r, orders.status == "paid", orders.status == "paid")')?.filters).toEqual([PAID]);
  });
});

describe("calculate errors", () => {
  it("needs a dataset the atom reaches, for each atom", () => {
    expect(messages('m = calculate(sum(customers.id), orders.status == "paid")')).toEqual(["calculate: orders does not reach customers"]);
    expect(messages('m = calculate(sum(regions.id), customers.segment == "a")')).toEqual(["calculate: customers does not reach regions"]);
    expect(messages('m = calculate(sum(orders.total) + sum(regions.id), customers.segment == "a")')).toEqual(["calculate: customers does not reach regions"]);
    expect(messages('m = calculate(r, items.price > 1)')).toEqual(["calculate: items does not reach orders"]);
  });

  it("points at the condition", () => {
    const source = 'm = calculate(sum(customers.id), orders.status == "paid")';
    expect(checkModel(source, SCHEMA).diagnostics[0]).toMatchObject({ message: "calculate: orders does not reach customers", from: 33, to: 56 });
  });

  it("needs a measure or an aggregation first", () => {
    expect(messages("m = calculate(orders.total)")).toEqual(["`orders.total` must be inside an aggregation, e.g. sum(orders.total)"]);
    expect(messages("m = calculate(5)")).toEqual(["calculate() needs a measure or an aggregation like sum(orders.total), not a fixed value"]);
    expect(messages("m = calculate()")).toEqual(["calculate() is missing `measure`"]);
  });

  it("takes only conditions on the columns of one dataset", () => {
    const on = "a calculate() filter is a condition on columns, e.g. orders.status == \"paid\"";
    expect(messages("m = calculate(r, sum(orders.qty) > 1)")).toEqual(["a calculate() filter works on rows: it cannot use an aggregation or a measure"]);
    expect(messages("m = calculate(r, r > 1)")).toEqual(["a calculate() filter works on rows: it cannot use an aggregation or a measure"]);
    expect(messages("m = calculate(r, 1 > 0)")).toEqual([on]);
    expect(messages("m = calculate(r, orders.qty + 1)")).toEqual([on]);
    expect(messages("m = calculate(r, 5)")).toEqual([on]);
    expect(messages('m = calculate(r, "paid")')).toEqual([on]);
    expect(messages("m = calculate(r, -orders.qty)")).toEqual([on]);
    expect(messages("m = calculate(r, orders.qty > customers.id)")).toEqual(["a calculate() filter reads one dataset: this one reads orders and customers"]);
  });

  it("refuses keyword arguments and a rank to change", () => {
    expect(messages("m = calculate(r, filter=orders.qty > 1)")).toEqual(["calculate() has no argument named filter"]);
    expect(messages("m = calculate(rank(r), orders.qty > 1)")).toEqual(["calculate cannot wrap rank"]);
  });

  it("checks the columns", () => {
    expect(messages("m = calculate(r, orders.nope > 1)")).toEqual(["orders has no column nope"]);
    expect(messages("m = calculate(r, nope.a > 1)")).toEqual(["unknown name nope"]);
  });
});

describe("all_", () => {
  it("removes a whole dataset, or one column", () => {
    expect(context("m = calculate(r, all_(customers))")).toEqual({ filters: [], removed: [{ dataset: "customers" }] });
    expect(context("m = calculate(r, all_(customers.segment))")).toEqual({ filters: [], removed: [{ dataset: "customers", column: "segment" }] });
  });

  it("takes several, and goes with conditions", () => {
    expect(context("m = calculate(r, all_(customers, regions.name))")?.removed).toEqual([{ dataset: "customers" }, { dataset: "regions", column: "name" }]);
    expect(context('m = calculate(r, all_(customers), orders.status == "paid")')).toEqual({
      filters: [PAID],
      removed: [{ dataset: "orders", column: "status" }, { dataset: "customers" }],
    });
    expect(context("m = calculate(r, all_(customers), all_(regions))")?.removed).toEqual([{ dataset: "customers" }, { dataset: "regions" }]);
  });

  it("with nothing in it removes the datasets the atom reads and everything it reaches", () => {
    expect(context("m = calculate(r, all_())")).toEqual({
      filters: [],
      removed: [{ dataset: "orders" }, { dataset: "customers" }, { dataset: "regions" }],
    });
    expect(context("m = calculate(sum(customers.id), all_())")?.removed).toEqual([{ dataset: "customers" }, { dataset: "regions" }]);
    expect(context("m = calculate(sum(regions.id), all_())")?.removed).toEqual([{ dataset: "regions" }]);
  });

  it("removes for each atom what that atom reaches", () => {
    const m = measure("m = calculate(sum(orders.total) / sum(regions.id), all_())");
    expect(m.atoms.map((a) => a.context?.removed.map((r) => r.dataset))).toEqual([["orders", "customers", "regions"], ["regions"]]);
  });

  it("does not need the dataset to be reached by the atom", () => {
    expect(context("m = calculate(sum(regions.id), all_(orders))")?.removed).toEqual([{ dataset: "orders" }]);
  });

  it("is only a filter of calculate", () => {
    const only = "all_(...) only works as a filter of calculate: calculate(sum(orders.total), all_(customers))";
    expect(messages("m = all_(customers)")).toEqual([only]);
    expect(messages("m = r + all_(customers)")).toEqual([only]);
    expect(messages("m = calculate(all_(customers), orders.qty > 1)")).toEqual([only]);
    expect(messages("m = calculate(r, not all_(customers))")).toEqual([only]);
    expect(messages("m = sum(if_(all_(customers), 1, 0))")).toEqual([only]);
  });

  it("takes datasets and columns", () => {
    expect(messages("m = calculate(r, all_(1))")).toEqual(["expected a dataset name (datasets: orders, customers, regions, items)"]);
    expect(messages("m = calculate(r, all_(r))")[0]).toContain("expected a dataset name");
    expect(messages("m = calculate(r, all_(nope))")).toEqual(["unknown name nope"]);
    expect(messages("m = calculate(r, all_(customers.nope))")).toEqual(["customers has no column nope"]);
    expect(messages("m = calculate(r, all_(x=customers))")).toEqual(["all_() has no argument named x"]);
  });
});

describe("calculate inside calculate", () => {
  const INNER = 'calculate(r, orders.status == "a")';

  it("keeps both when they filter different columns", () => {
    expect(context(`m = calculate(${INNER}, orders.qty > 1)`)).toEqual({
      filters: [{ dataset: "orders", sql: "(\"status\" = 'a')" }, { dataset: "orders", sql: '("qty" > 1)' }],
      removed: [{ dataset: "orders", column: "status" }, { dataset: "orders", column: "qty" }],
    });
  });

  it("lets the inner one win on the same column", () => {
    expect(context(`m = calculate(${INNER}, orders.status == "b")`)).toEqual({
      filters: [{ dataset: "orders", sql: "(\"status\" = 'a')" }],
      removed: [{ dataset: "orders", column: "status" }],
    });
  });

  it("drops an outer condition that reads a column the inner one covers, with what it would remove", () => {
    const c = context(`m = calculate(${INNER}, orders.status == "b" and orders.qty > 1)`);
    expect(c?.filters).toEqual([{ dataset: "orders", sql: "(\"status\" = 'a')" }]);
    expect(c?.removed).toEqual([{ dataset: "orders", column: "status" }]);
  });

  it("lets an inner all_ win over an outer condition on that dataset or column", () => {
    expect(context('m = calculate(calculate(r, all_(orders)), orders.status == "b")')).toEqual({ filters: [], removed: [{ dataset: "orders" }] });
    expect(context('m = calculate(calculate(r, all_(orders.status)), orders.status == "b")')).toEqual({ filters: [], removed: [{ dataset: "orders", column: "status" }] });
    expect(context('m = calculate(calculate(r, all_(orders.qty)), orders.status == "b")')?.filters).toEqual([{ dataset: "orders", sql: "(\"status\" = 'b')" }]);
  });

  it("keeps an inner condition under an outer all_, and adds up the removals", () => {
    expect(context(`m = calculate(${INNER}, all_(orders))`)).toEqual({
      filters: [{ dataset: "orders", sql: "(\"status\" = 'a')" }],
      removed: [{ dataset: "orders", column: "status" }, { dataset: "orders" }],
    });
    expect(context("m = calculate(calculate(r, all_(customers)), all_(regions), all_(customers))")?.removed).toEqual([{ dataset: "customers" }, { dataset: "regions" }]);
  });

  it("goes through measures by name, as many levels as there are", () => {
    const c = context('inner = calculate(r, orders.status == "a")\nmid = calculate(inner, customers.segment == "x")\nm = calculate(mid, orders.status == "z")');
    expect(c?.filters.map((f) => f.dataset)).toEqual(["orders", "customers"]);
    expect(c?.filters[0].sql).toBe("(\"status\" = 'a')");
  });

  it("does not change the measure used", () => {
    const { model } = check(`inner = ${INNER}\nm = calculate(inner, orders.qty > 1)`);
    expect(model.measures[1].atoms[0].context?.filters).toHaveLength(1);
    expect(model.measures[2].atoms[0].context?.filters).toHaveLength(2);
  });
});

describe("calculate and the time functions", () => {
  const CAL = "dates = calendar(orders.created)\n";
  const FILTER = "orders.status == \"paid\"";

  it("carry both on the atom, in either order", () => {
    const a = measure(`${CAL}m = calculate(ytd(r), ${FILTER})`).atoms[0];
    const b = measure(`${CAL}m = ytd(calculate(r, ${FILTER}))`).atoms[0];
    expect(a).toEqual(b);
    expect(a.window).toEqual({ kind: "to_date", period: "year" });
    expect(a.context?.filters).toEqual([PAID]);
  });

  it("filter on a calendar column", () => {
    const [atom] = measure(`${CAL}m = calculate(sum(orders.total), dates.year == 2024)`).atoms;
    expect(atom.context).toEqual({ filters: [{ dataset: "dates", sql: '("year" = 2024)' }], removed: [{ dataset: "dates", column: "year" }] });
    expect(messages(`${CAL}m = calculate(sum(customers.id), dates.year == 2024)`)).toEqual(["calculate: dates does not reach customers"]);
  });
});
