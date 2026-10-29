import { describe, expect, it } from "vitest";

import { checkModel } from "../check";
import { render } from "../parts";
import { CALENDAR_COLUMNS, type AtomWindow, type Measure } from "../types";

const SCHEMA = {
  orders: ["id", "total", "created", "customer_id"],
  customers: ["id", "since", "region_id"],
  regions: ["id"],
  targets: ["day", "goal"],
  loose: null,
};
const CAL = "dates = calendar(orders.created)\n";

const check = (source: string) => checkModel(source, SCHEMA);
const messages = (source: string) => check(source).diagnostics.map((d) => d.message);
const measure = (source: string, name = "m"): Measure => {
  const m = check(source).model.measures.find((x) => x.name === name);
  if (!m) throw new Error(`no measure ${name}: ${messages(source).join("; ")}`);
  return m;
};
const windowOf = (source: string): AtomWindow | undefined => measure(CAL + source).atoms[0].window;

describe("calendar", () => {
  it("declares a calendar and makes its name a dataset with the calendar columns", () => {
    const { model, diagnostics } = check(`${CAL}m = calculate(sum(orders.total), dates.year == 2024)`);
    expect(diagnostics).toEqual([]);
    expect(model.calendars).toEqual([{ name: "dates", columns: [{ dataset: "orders", column: "created" }], span: { from: 8, to: 32, line: 1, col: 9 } }]);
    for (const c of CALENDAR_COLUMNS) expect(messages(`${CAL}m = calculate(sum(orders.total), dates.${c} == 1)`), c).toEqual([]);
    expect(messages(`${CAL}m = calculate(sum(orders.total), dates.nope == 1)`)).toEqual(["dates has no column nope"]);
    expect(messages(`${CAL}m = count_rows(dates)`)).toEqual([]);
  });

  it("relates each column to the date of the calendar, as a date", () => {
    const { model } = check("dates = calendar(orders.created, targets.day)");
    expect(model.relationships).toEqual([
      { many: { dataset: "orders", column: "created" }, one: { dataset: "dates", column: "date" }, span: { from: 8, to: 45, line: 1, col: 9 }, cast: "date" },
      { many: { dataset: "targets", column: "day" }, one: { dataset: "dates", column: "date" }, span: { from: 8, to: 45, line: 1, col: 9 }, cast: "date" },
    ]);
    expect(model.calendars[0].columns).toHaveLength(2);
  });

  it("keeps relationships and calendars in file order", () => {
    const { model } = check("relate(orders.customer_id, customers.id)\ndates = calendar(customers.since)\nrelate(customers.region_id, regions.id)");
    expect(model.relationships.map((r) => `${r.many.dataset}.${r.many.column}→${r.one.dataset}`)).toEqual([
      "orders.customer_id→customers",
      "customers.since→dates",
      "customers.region_id→regions",
    ]);
  });

  it("takes columns of a dataset whose columns are not known", () => {
    expect(messages("dates = calendar(loose.anything)")).toEqual([]);
  });

  it("needs a column that exists", () => {
    expect(messages("dates = calendar(orders.nope)")).toEqual(["orders has no column nope"]);
    expect(messages("dates = calendar(nope.a)")).toEqual(["unknown name nope"]);
    expect(messages("dates = calendar(1)")[0]).toContain("expected a column written dataset.column");
    expect(messages("dates = calendar(orders)")[0]).toContain("expected a column written dataset.column");
  });

  it("needs at least one column, and no keywords", () => {
    expect(messages("dates = calendar()")).toEqual(["calendar() needs at least one column, e.g. calendar(orders.o_orderdate)"]);
    expect(messages("dates = calendar(col=orders.created)")).toEqual(["calendar() has no argument named col"]);
  });

  it("refuses a column listed twice", () => {
    expect(messages("dates = calendar(orders.created, orders.created)")).toEqual(["calendar() lists orders.created twice"]);
  });

  it("is only one per model, and the second is left out", () => {
    const { model, diagnostics } = check("dates = calendar(orders.created)\nother = calendar(targets.day)");
    expect(diagnostics.map((d) => [d.line, d.message])).toEqual([[2, "only one calendar per model for now: dates is on line 1"]]);
    expect(model.calendars.map((c) => c.name)).toEqual(["dates"]);
    expect(model.relationships).toHaveLength(1);
  });

  it("is the whole value of a line", () => {
    expect(messages("m = 1 + calendar(orders.created)")).toEqual(["calendar(...) has to be the whole value of a line: name = calendar(...)"]);
    expect(messages("m = sum(calendar(orders.created))")[0]).toContain("has to be the whole value of a line");
    expect(messages("calendar(orders.created)")[0]).toContain("only `name = expression` lines");
  });

  it("takes a name no dataset, function or other line has", () => {
    expect(messages("orders = calendar(orders.created)")).toEqual(["`orders` is a dataset name: pick another name"]);
    expect(messages("sum = calendar(orders.created)")).toEqual(["`sum` is a function name: pick another name"]);
    expect(messages("dates = sum(orders.total)\ndates = calendar(orders.created)")).toEqual(["`dates` is already defined"]);
    expect(messages("dates = calendar(orders.created)\ndates = sum(orders.total)")).toEqual(["`dates` is a dataset name: pick another name"]);
  });

  it("leaves out its measure-side name when it has an error", () => {
    expect(messages("dates = calendar(orders.nope)\nm = calculate(sum(orders.total), dates.year == 1)")).toEqual([
      "orders has no column nope",
      "`dates` has an error",
    ]);
  });

  it("can be declared below the measures that use it", () => {
    const source = "m = ytd(sum(orders.total))\nn = calculate(sum(orders.total), dates.year == 1)\ndates = calendar(orders.created)";
    expect(messages(source)).toEqual([]);
    expect(check(source).model.measures.map((m) => m.name)).toEqual(["m", "n"]);
  });
});

describe("calendar relationships", () => {
  it("are checked like relate: a second path leaves the whole calendar out", () => {
    const { model, diagnostics } = check("relate(orders.customer_id, customers.id)\ndates = calendar(orders.created, customers.since)");
    expect(diagnostics.map((d) => [d.line, d.message])).toEqual([
      [
        2,
        "this relationship gives orders a second path to dates: orders.customer_id → customers.id then customers.since → dates.date and orders.created → dates.date",
      ],
    ]);
    expect(model.calendars).toEqual([]);
    expect(model.relationships).toHaveLength(1);
    expect(messages("relate(orders.customer_id, customers.id)\ndates = calendar(orders.created, customers.since)\nm = count_rows(dates)")).toContain("`dates` has an error");
  });

  it("point at the column that conflicts", () => {
    const source = "relate(orders.customer_id, customers.id)\ndates = calendar(orders.created, customers.since)";
    expect(check(source).diagnostics[0]).toMatchObject({ line: 2, col: 34, from: 74, to: 89 });
  });

  it("see the relationships written below the calendar", () => {
    const { model, diagnostics } = check("dates = calendar(orders.created, customers.since)\nrelate(orders.customer_id, customers.id)");
    // the first pass reads the lines in file order: the relate line comes second, and conflicts with the calendar's
    expect(diagnostics.map((d) => d.line)).toEqual([2]);
    expect(diagnostics[0].message).toContain("a second path to dates");
    expect(model.relationships).toHaveLength(2);
  });

  it("make a cycle impossible: a relationship from the calendar back to a dataset", () => {
    const { model, diagnostics } = check("dates = calendar(orders.created)\nrelate(dates.year, orders.id)");
    expect(diagnostics.map((d) => [d.line, d.message])).toEqual([
      [2, "this relationship creates a cycle: dates.year → orders.id and, the other way, orders.created → dates.date"],
    ]);
    expect(model.relationships).toHaveLength(1);
  });

  it("make a cycle impossible: the calendar column is reached from its own calendar", () => {
    const { diagnostics } = check("relate(regions.id, orders.id)\nrelate(orders.created, customers.since)\ndates = calendar(customers.since)\nrelate(dates.date, regions.id)");
    expect(diagnostics.map((d) => d.line)).toEqual([4]);
    expect(diagnostics[0].message).toContain("creates a cycle");
  });

  it("let two datasets share the calendar", () => {
    const { model, diagnostics } = check("relate(orders.customer_id, customers.id)\ndates = calendar(orders.created, targets.day)");
    expect(diagnostics).toEqual([]);
    expect(model.relationships.filter((r) => r.cast === "date")).toHaveLength(2);
  });
});

describe("time functions", () => {
  it("give every atom a window", () => {
    expect(windowOf("m = ytd(sum(orders.total))")).toEqual({ kind: "to_date", period: "year" });
    expect(windowOf("m = qtd(sum(orders.total))")).toEqual({ kind: "to_date", period: "quarter" });
    expect(windowOf("m = mtd(sum(orders.total))")).toEqual({ kind: "to_date", period: "month" });
    expect(windowOf("m = previous_year(sum(orders.total))")).toEqual({ kind: "shift", unit: "year" });
    expect(windowOf("m = previous_period(sum(orders.total))")).toEqual({ kind: "shift", unit: "grain" });
    expect(windowOf("m = rolling(sum(orders.total), 3)")).toEqual({ kind: "rolling", n: 3 });
  });

  it("take a unit for previous_period, by position or name", () => {
    for (const unit of ["year", "quarter", "month", "week", "day"]) {
      expect(windowOf(`m = previous_period(sum(orders.total), "${unit}")`)).toEqual({ kind: "shift", unit });
    }
    expect(windowOf('m = previous_period(sum(orders.total), unit="week")')).toEqual({ kind: "shift", unit: "week" });
  });

  it("keep the SQL of the atom and the template around it", () => {
    const m = measure(`${CAL}m = ytd(sum(orders.total)) / 2`);
    expect(m.atoms).toEqual([{ dataset: "orders", sql: 'SUM("total")', agg: "sum", window: { kind: "to_date", period: "year" } }]);
    expect(render(m.expr, (i) => m.atoms[i].sql)).toBe('(CAST((SUM("total")) AS DOUBLE) / (2))');
  });

  it("go over every atom: an average, a ratio, a named measure", () => {
    const avg = measure(`${CAL}m = ytd(avg(orders.total))`);
    expect(avg.atoms.map((a) => [a.agg, a.window?.kind])).toEqual([["sum", "to_date"], ["count", "to_date"]]);
    expect(avg.expr).toEqual(["(CAST(", { atom: 0 }, " AS DOUBLE) / NULLIF(", { atom: 1 }, ", 0))"]);
    const ratio = measure(`${CAL}m = previous_year(sum(orders.total) / count_rows(orders))`);
    expect(ratio.atoms.map((a) => a.window)).toEqual([{ kind: "shift", unit: "year" }, { kind: "shift", unit: "year" }]);
    const named = measure(`${CAL}r = sum(orders.total)\nm = mtd(r) - r`);
    expect(named.atoms.map((a) => a.window)).toEqual([{ kind: "to_date", period: "month" }, undefined]);
  });

  it("make a different atom from the same aggregation without a window, and one for the same window", () => {
    expect(measure(`${CAL}r = sum(orders.total)\nm = r + ytd(r)`).atoms).toHaveLength(2);
    expect(measure(`${CAL}r = sum(orders.total)\nm = ytd(r) + ytd(sum(orders.total))`).atoms).toHaveLength(1);
    expect(measure(`${CAL}r = sum(orders.total)\nm = ytd(r) + mtd(r)`).atoms).toHaveLength(2);
    expect(measure(`${CAL}r = sum(orders.total)\nm = rolling(r, 3) + rolling(r, 4)`).atoms).toHaveLength(2);
  });

  it("do not change the measure they wrap", () => {
    const { model } = check(`${CAL}r = sum(orders.total)\nm = ytd(r)`);
    expect(model.measures[0].atoms[0].window).toBeUndefined();
  });

  it("accumulate sums and counts, mins and maxes, but not a distinct count", () => {
    for (const fn of ["min", "max", "count", "sum"]) expect(messages(`${CAL}m = ytd(${fn}(orders.total))`), fn).toEqual([]);
    expect(messages(`${CAL}m = ytd(count_distinct(orders.id))`)).toEqual(["count_distinct cannot be accumulated by ytd"]);
    expect(messages(`${CAL}m = qtd(count_distinct(orders.id))`)).toEqual(["count_distinct cannot be accumulated by qtd"]);
    expect(messages(`${CAL}m = mtd(sum(orders.total) / count_distinct(orders.id))`)).toEqual(["count_distinct cannot be accumulated by mtd"]);
    expect(messages(`${CAL}m = rolling(count_distinct(orders.id), 2)`)).toEqual(["count_distinct cannot be accumulated by rolling"]);
  });

  it("shift a distinct count, which needs no adding up", () => {
    expect(messages(`${CAL}m = previous_year(count_distinct(orders.id))`)).toEqual([]);
    expect(messages(`${CAL}m = previous_period(count_distinct(orders.id), "month")`)).toEqual([]);
  });

  it("take one window per atom", () => {
    expect(messages(`${CAL}m = ytd(previous_year(sum(orders.total)))`)).toEqual(["ytd cannot wrap previous_year"]);
    expect(messages(`${CAL}m = previous_year(ytd(sum(orders.total)))`)).toEqual(["previous_year cannot wrap ytd"]);
    expect(messages(`${CAL}m = qtd(qtd(sum(orders.total)))`)).toEqual(["qtd cannot wrap qtd"]);
    expect(messages(`${CAL}m = mtd(rolling(sum(orders.total), 2))`)).toEqual(["mtd cannot wrap rolling"]);
    expect(messages(`${CAL}m = rolling(previous_period(sum(orders.total), "day"), 2)`)).toEqual(["rolling cannot wrap previous_period"]);
    expect(messages(`${CAL}m = ytd(running_total(sum(orders.total)))`)).toEqual(["ytd cannot wrap running_total"]);
    expect(messages(`${CAL}r = ytd(sum(orders.total))\nm = previous_year(r)`)).toEqual(["previous_year cannot wrap ytd"]);
    expect(messages(`${CAL}m = ytd(sum(orders.total) + previous_year(sum(orders.total)))`)).toEqual(["ytd cannot wrap previous_year"]);
  });

  it("point at the measure they wrap", () => {
    expect(check(`${CAL}m = ytd(previous_year(sum(orders.total)))`).diagnostics[0]).toMatchObject({ line: 2, from: 41, to: 73 });
  });

  it("need a calendar, and say how to make one", () => {
    const need = "needs a calendar: dates = calendar(orders.o_orderdate)";
    expect(messages("m = ytd(sum(orders.total))")).toEqual([`ytd ${need}`]);
    expect(messages("m = qtd(sum(orders.total))")).toEqual([`qtd ${need}`]);
    expect(messages("m = mtd(sum(orders.total))")).toEqual([`mtd ${need}`]);
    expect(messages("m = previous_year(sum(orders.total))")).toEqual([`previous_year ${need}`]);
    expect(messages('m = previous_period(sum(orders.total), "month")')).toEqual([`previous_period ${need}`]);
  });

  it("point at the call when there is no calendar", () => {
    expect(check("m = 1 + ytd(sum(orders.total))").diagnostics[0]).toMatchObject({ from: 8, to: 30 });
  });

  it("do not need one when they only add up along x", () => {
    expect(messages("m = rolling(sum(orders.total), 3)")).toEqual([]);
    expect(messages("m = running_total(sum(orders.total))")).toEqual([]);
  });

  it("need an aggregation or a measure", () => {
    expect(messages(`${CAL}m = ytd(orders.total)`)).toEqual(["`orders.total` must be inside an aggregation, e.g. sum(orders.total)"]);
    expect(messages(`${CAL}m = previous_year(5)`)).toEqual(["previous_year() needs a measure or an aggregation like sum(orders.total), not a fixed value"]);
    expect(messages(`${CAL}m = ytd()`)).toEqual(["ytd() is missing `measure`"]);
    expect(messages(`${CAL}m = ytd(sum(orders.total), 2)`)).toEqual(["ytd() takes 1 argument, got 2"]);
  });

  it("take a known unit for previous_period", () => {
    const unit = 'unit must be "year", "quarter", "month", "week" or "day"';
    expect(messages(`${CAL}m = previous_period(sum(orders.total), "decade")`)).toEqual([unit]);
    expect(messages(`${CAL}m = previous_period(sum(orders.total), "grain")`)).toEqual([unit]);
    expect(messages(`${CAL}m = previous_period(sum(orders.total), 3)`)).toEqual([unit]);
    expect(messages(`${CAL}m = previous_period(sum(orders.total), month)`)).toEqual([unit]);
  });

  it("take n as a whole number from 1, written out", () => {
    for (const bad of ["0", "1.5", "-1", '"3"', "orders.total", "n", "2e1"]) {
      expect(messages(`n = 2\nm = rolling(sum(orders.total), ${bad})`)[0], bad).toBe("n must be a whole number from 1, written out: rolling(measure, 3)");
    }
    expect(windowOf("m = rolling(sum(orders.total), 1)")).toEqual({ kind: "rolling", n: 1 });
    expect(windowOf("m = rolling(sum(orders.total), n=12)")).toEqual({ kind: "rolling", n: 12 });
    expect(messages(`${CAL}m = rolling(sum(orders.total))`)).toEqual(["rolling() is missing `n`"]);
  });
});
