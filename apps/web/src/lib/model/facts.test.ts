import { describe, expect, it } from "vitest";

import { factSql, keyName, planFacts, type Ignore } from "./facts";
import { atom, calendar, measure, model as modelOf, rel, sum } from "./testing";
import type { Atom, ColumnRef, Measure } from "./types";

const model = modelOf({
  relationships: [
    rel("orders.customer_id", "customers.id"),
    rel("customers.city_id", "cities.id"),
    rel("goals.customer_id", "customers.id"),
    rel("orders.day", "dates.date", "date"),
    rel("goals.day", "dates.date", "date"),
  ],
  calendars: [calendar("dates", "orders.day", "goals.day")],
});
const revenue = measure("revenue", [sum("orders", "a")]);
const n = measure("n", [atom("orders", "COUNT(*)", "count")]);
const target = measure("target", [sum("goals", "amount")]);
const ratio = measure("ratio", [sum("orders", "a"), sum("goals", "amount")], ["(", { atom: 0 }, ") / (", { atom: 1 }, ")"]);
const ticket = measure("ticket", [sum("orders", "a"), atom("orders", "COUNT(*)", "count")], [{ atom: 0 }, " / ", { atom: 1 }]);
const key = (dataset: string, column: string): ColumnRef => ({ dataset, column });
const source = (d: string) => `SELECT * FROM ${d}`;
/** a measure of one aggregation that reads orders in the given context and window */
const of = (extra: Partial<Atom>, name = "m") => measure(name, [sum("orders", "a", extra)]);
const plan = (measures: Measure[], keys: ColumnRef[] = [], hasX = false) => planFacts(model, measures, keys, hasX);

describe("planFacts", () => {
  it("makes a fact of each dataset the atoms read, in order of first use, and numbers the atoms across them", () => {
    const { facts } = plan([target, revenue, n]);
    expect(facts.map((f) => f.dataset)).toEqual(["goals", "orders"]);
    expect(facts[0].atoms).toEqual([{ sql: 'SUM("amount")', agg: "sum", alias: "__a0" }]);
    expect(facts[1].atoms).toEqual([
      { sql: 'SUM("a")', agg: "sum", alias: "__a1" },
      { sql: "COUNT(*)", agg: "count", alias: "__a2" },
    ]);
  });

  it("gives the same atom of two measures one place", () => {
    const p = plan([revenue, ticket, ratio]);
    expect(p.facts.flatMap((f) => f.atoms).map((a) => a.sql)).toEqual(['SUM("a")', "COUNT(*)", 'SUM("amount")']);
    expect(p.where(ticket.atoms[0])).toEqual(p.where(revenue.atoms[0]));
    expect(p.where(ticket.atoms[1])).toEqual({ fact: 0, alias: "__a1" });
  });

  it("finds what each fact reaches: the steps to the column's dataset, empty for its own, null for none", () => {
    const { facts } = plan([revenue], [key("orders", "a"), key("cities", "state"), key("goals", "amount")]);
    expect(facts[0].paths.map((p) => p && p.map((r) => `${r.many.dataset}>${r.one.dataset}`))).toEqual([[], ["orders>customers", "customers>cities"], null]);
  });

  it("is plain without a context or a window", () => {
    expect(plan([revenue]).facts.map((f) => f.plain)).toEqual([true]);
  });

  describe("contexts", () => {
    const filtered = { filters: [{ dataset: "customers", sql: '"region" = \'S\'' }], removed: [] };

    it("makes a fact of each context and window an atom is read in, the same atom with a different one included", () => {
      const p = plan([revenue, of({ context: filtered }), of({ window: { kind: "running" } }, "run")], [key("dates", "month")], true);
      expect(p.facts.map((f) => [f.plain, f.window?.kind, f.filters.length])).toEqual([
        [true, undefined, 0],
        [false, undefined, 1],
        [false, "running", 0],
      ]);
      expect(p.facts.flatMap((f) => f.atoms.map((a) => a.alias))).toEqual(["__a0", "__a1", "__a2"]);
    });

    it("takes two orders of the same context for one", () => {
      const a = { filters: [{ dataset: "customers", sql: "a" }, { dataset: "cities", sql: "b" }], removed: [{ dataset: "cities" }, { dataset: "goals", column: "x" }] };
      const b = { filters: [...a.filters].reverse(), removed: [...a.removed].reverse() };
      const p = plan([of({ context: a }, "one"), of({ context: b }, "two"), of({ context: { filters: [], removed: [] } }, "plain")]);
      expect(p.facts).toHaveLength(2);
      expect(p.facts[1].plain).toBe(true);
      expect(p.where(of({ context: b }).atoms[0])).toEqual(p.where(of({ context: a }).atoms[0]));
    });

    it("puts a filter on the steps from the atom's dataset to the filter's, the dataset's own on none, and drops one it cannot reach", () => {
      const ctx = { filters: [{ dataset: "cities", sql: "c" }, { dataset: "orders", sql: "o" }, { dataset: "goals", sql: "g" }], removed: [] };
      const [f] = plan([of({ context: ctx })]).facts;
      expect(f.filters.map((c) => [c.sql, c.path.map((r) => r.one.dataset)])).toEqual([
        ["c", ["customers", "cities"]],
        ["o", []],
      ]);
    });

    it("leaves a grouping column out when its dataset, a dataset on the way, its column or the fact's own dataset is removed", () => {
      const keys = [key("customers", "region"), key("cities", "state"), key("orders", "status")];
      const paths = (removed: { dataset: string; column?: string }[]) => plan([of({ context: { filters: [], removed } })], keys).facts[0].paths.map((p) => p !== null);
      expect(paths([])).toEqual([true, true, true]);
      expect(paths([{ dataset: "customers" }])).toEqual([false, false, true]);
      expect(paths([{ dataset: "cities" }])).toEqual([true, false, true]);
      expect(paths([{ dataset: "cities", column: "state" }])).toEqual([true, false, true]);
      expect(paths([{ dataset: "cities", column: "other" }])).toEqual([true, true, true]);
      expect(paths([{ dataset: "orders" }])).toEqual([false, false, false]);
      expect(paths([{ dataset: "goals" }])).toEqual([true, true, true]);
    });

    it("ignores what the context removes, a whole dataset or a column, and nothing without a context", () => {
      const removed = [{ dataset: "customers" }, { dataset: "cities", column: "state" }, { dataset: "customers" }];
      expect(plan([of({ context: { filters: [], removed } })]).facts[0].ignore).toEqual({ datasets: ["customers"], columns: [{ dataset: "cities", column: "state" }] });
      expect(plan([revenue]).facts[0].ignore).toBeUndefined();
      expect(plan([of({ context: { filters: [{ dataset: "orders", sql: "x" }], removed: [] } })]).facts[0].ignore).toBeUndefined();
    });
  });

  describe("windows", () => {
    const x = key("dates", "month");
    const ignored = (window: Atom["window"]) => plan([of({ window })], [x], true).facts.find((f) => f.window)!.ignore;

    it("read past the calendar's filters, except a running total, and a rolling window along an x that is no calendar", () => {
      expect(ignored({ kind: "shift", unit: "year" })).toEqual({ datasets: ["dates"], columns: [] });
      expect(ignored({ kind: "to_date", period: "year" })).toEqual({ datasets: ["dates"], columns: [] });
      expect(ignored({ kind: "rolling", n: 3 })).toEqual({ datasets: ["dates"], columns: [] });
      expect(ignored({ kind: "running" })).toBeUndefined();
      expect(plan([of({ window: { kind: "rolling", n: 3 } })], [key("customers", "region")], true).facts[0].ignore).toBeUndefined();
    });

    it("keep the calendar's column as x when a dataset is removed by the context, the calendar to read past included", () => {
      const f = plan([of({ window: { kind: "shift", unit: "year" }, context: { filters: [], removed: [{ dataset: "customers" }] } })], [x, key("customers", "region")], true).facts[0];
      expect(f.paths.map((p) => p !== null)).toEqual([true, false]);
      expect(f.ignore).toEqual({ datasets: ["customers", "dates"], columns: [] });
    });

    it("carry x's grain", () => {
      expect(plan([of({ window: { kind: "running" } })], [x], true).facts[0].grain).toBe("month");
      expect(plan([revenue], [x], true).facts[0].grain).toBeNull();
    });

    it("need x on a calendar column, and a fact that reaches it and keeps it", () => {
      expect(() => plan([of({ window: { kind: "shift", unit: "year" } })], [x], false)).toThrow("m needs the chart's x axis");
      expect(() => plan([of({ window: { kind: "shift", unit: "year" } })], [key("customers", "region")], true)).toThrow("m needs the x axis on a calendar column");
      expect(() => plan([measure("t", [sum("goals", "amount", { window: { kind: "running" } })])], [key("orders", "a")], true)).toThrow(
        "t needs the x axis on orders.a, which goals does not reach",
      );
      expect(() => plan([of({ window: { kind: "running" }, context: { filters: [], removed: [{ dataset: "dates" }] } })], [x], true)).toThrow("which orders does not reach or a filter in it removes");
    });

    it("cannot add up a distinct count, though they shift it", () => {
      const distinct = (window: Atom["window"]) => measure("people", [atom("orders", 'COUNT(DISTINCT "c")', "count_distinct", { window })]);
      for (const window of [{ kind: "running" }, { kind: "to_date", period: "year" }, { kind: "rolling", n: 2 }] as const) {
        expect(() => plan([distinct(window)], [x], true)).toThrow("people cannot add up a distinct count along the x axis");
      }
      expect(() => plan([distinct({ kind: "shift", unit: "year" })], [x], true)).not.toThrow();
    });
  });

  describe("the facts that give the result its rows", () => {
    it("are one plain fact for each dataset: an atom's own, or one with no atom when it is read only in a context or a window", () => {
      const keys = [key("dates", "month")];
      const shifted = of({ window: { kind: "shift", unit: "year" } });
      expect(plan([shifted], keys, true).facts.map((f) => [f.dataset, f.plain, f.atoms.length])).toEqual([
        ["orders", false, 1],
        ["orders", true, 0],
      ]);
      expect(plan([shifted, target], keys, true).facts.map((f) => [f.dataset, f.plain, f.atoms.length])).toEqual([
        ["orders", false, 1],
        ["goals", true, 1],
        ["orders", true, 0],
      ]);
      expect(plan([shifted, revenue], keys, true).facts.map((f) => f.plain)).toEqual([false, true]);
    });

    it("are not needed without grouping columns, one row being the result", () => {
      expect(plan([of({ context: { filters: [], removed: [{ dataset: "products" }] } })]).facts).toHaveLength(1);
    });

    it("reach what their dataset reaches", () => {
      const f = plan([of({ window: { kind: "running" } })], [key("dates", "month"), key("cities", "state")], true).facts[1];
      expect(f.atoms).toEqual([]);
      expect(f.paths.map((p) => p?.map((r) => r.one.dataset))).toEqual([["dates"], ["customers", "cities"]]);
    });
  });
});

describe("factSql", () => {
  const sqlOf = (measures: Measure[], keys: ColumnRef[], fact = 0, src: (d: string, ignore?: Ignore) => string = source, hasX = false) => {
    const { facts } = planFacts(model, measures, keys, hasX);
    return factSql(facts[fact], keys, src);
  };

  it("names the columns __k<i> and the atoms __a<n>, so that they cannot meet a dataset's columns", () => {
    expect(keyName(3)).toBe('"__k3"');
    expect(sqlOf([revenue], [key("orders", "a")])).toBe(
      'SELECT "__k0", SUM("a") AS "__a0" FROM (SELECT _f.*, _f."a" AS "__k0" FROM (SELECT * FROM orders) AS _f) AS _m GROUP BY "__k0"',
    );
  });

  it("has no GROUP BY without columns, and keeps the fact's own rows", () => {
    expect(sqlOf([revenue, n], [])).toBe('SELECT SUM("a") AS "__a0", COUNT(*) AS "__a1" FROM (SELECT _f.* FROM (SELECT * FROM orders) AS _f) AS _m');
  });

  it("joins each step once and leaves out the columns the fact does not reach, keeping their numbers", () => {
    const sql = sqlOf([target], [key("cities", "state"), key("orders", "a"), key("customers", "region")]);
    expect(sql).toBe(
      'SELECT "__k0", "__k2", SUM("amount") AS "__a0" FROM (SELECT _f.*, _j1."state" AS "__k0", _j0."region" AS "__k2" FROM (SELECT * FROM goals) AS _f ' +
        'LEFT JOIN (SELECT * FROM customers) AS _j0 ON _f."customer_id" = _j0."id" ' +
        'LEFT JOIN (SELECT * FROM cities) AS _j1 ON _j0."city_id" = _j1."id") AS _m GROUP BY "__k0", "__k2"',
    );
  });

  it("compares a calendar's date as a DATE, whatever the column holds", () => {
    expect(sqlOf([revenue], [key("dates", "month")])).toBe(
      'SELECT "__k0", SUM("a") AS "__a0" FROM (SELECT _f.*, _j0."month" AS "__k0" FROM (SELECT * FROM orders) AS _f ' +
        'LEFT JOIN (SELECT * FROM dates) AS _j0 ON CAST(_f."day" AS DATE) = _j0."date") AS _m GROUP BY "__k0"',
    );
  });

  describe("a context", () => {
    const withContext = (filters: { dataset: string; sql: string }[], removed: { dataset: string; column?: string }[] = []) => of({ context: { filters, removed } });

    it("narrows the fact's own rows before anything joins, so that the filter's columns cannot meet a dimension's", () => {
      expect(sqlOf([withContext([{ dataset: "orders", sql: '"a" > 1' }, { dataset: "orders", sql: '"s" = \'x\' OR "s" IS NULL' }])], [key("customers", "region")])).toBe(
        'SELECT "__k0", SUM("a") AS "__a0" FROM (SELECT _f.*, _j0."region" AS "__k0" FROM ' +
          `(SELECT * FROM (SELECT * FROM orders) AS _x WHERE ("a" > 1) AND ("s" = 'x' OR "s" IS NULL)) AS _f ` +
          'LEFT JOIN (SELECT * FROM customers) AS _j0 ON _f."customer_id" = _j0."id") AS _m GROUP BY "__k0"',
      );
    });

    it("narrows by a filter on a dataset it reaches with a semi-join, chained from the inside out through a snowflake", () => {
      const sql = sqlOf([withContext([{ dataset: "cities", sql: '"state" = \'SP\'' }])], []);
      expect(sql).toBe(
        'SELECT SUM("a") AS "__a0" FROM (SELECT _f.* FROM (SELECT * FROM (SELECT * FROM orders) AS _x WHERE (' +
          '_x."customer_id" IN (SELECT "id" FROM (SELECT * FROM customers) AS _s1 WHERE ' +
          `_s1."city_id" IN (SELECT "id" FROM (SELECT * FROM cities) AS _s2 WHERE "state" = 'SP')))) AS _f) AS _m`,
      );
    });

    it("compares the many side of a calendar's relationship as a DATE in the semi-join too", () => {
      const sql = sqlOf([withContext([{ dataset: "dates", sql: '"year" = 2024' }])], []);
      expect(sql).toContain('CAST(_x."day" AS DATE) IN (SELECT "date" FROM (SELECT * FROM dates) AS _s1 WHERE "year" = 2024)');
    });

    it("asks for each source without what the context removes, and without `ignore` when it removes nothing", () => {
      const asked: [string, Ignore | undefined][] = [];
      const spy = (d: string, ignore?: Ignore) => (asked.push([d, ignore]), `SELECT * FROM ${d}`);
      sqlOf([withContext([{ dataset: "cities", sql: "c" }], [{ dataset: "customers" }, { dataset: "cities", column: "state" }])], [key("customers", "region")], 0, spy);
      const ignore = { datasets: ["customers"], columns: [{ dataset: "cities", column: "state" }] };
      expect(asked).toEqual([["cities", ignore], ["customers", ignore], ["orders", ignore]]);
      asked.length = 0;
      sqlOf([revenue], [key("customers", "region")], 0, spy);
      expect(asked).toEqual([["customers", undefined], ["orders", undefined]]);
    });

    it("groups only by the columns it keeps", () => {
      const sql = sqlOf([withContext([], [{ dataset: "customers" }])], [key("dates", "month"), key("customers", "region")]);
      expect(sql).toContain('SELECT "__k0", SUM("a") AS "__a0" FROM (SELECT _f.*, _j0."month" AS "__k0" FROM');
      expect(sql).toMatch(/GROUP BY "__k0"$/);
      expect(sql).not.toContain("customers");
    });
  });

  describe("a window", () => {
    const x = key("dates", "month");
    const along = (window: Atom["window"], agg: Atom["agg"] = "sum", keys = [x]) => sqlOf([measure("m", [atom("orders", `${agg.toUpperCase()}("a")`, agg, { window })])], keys, 0, source, true);
    const GROUPED = 'SELECT "__k0", SUM("a") AS "__a0" FROM (SELECT _f.*, _j0."month" AS "__k0" FROM (SELECT * FROM orders) AS _f LEFT JOIN (SELECT * FROM dates) AS _j0 ON CAST(_f."day" AS DATE) = _j0."date" WHERE _j0."month" IS NOT NULL) AS _m GROUP BY "__k0"';

    it("moves a shift's key forward in the inner select, files the rows under the period they are compared to, and drops the rows with no date", () => {
      expect(along({ kind: "shift", unit: "year" })).toBe(
        'SELECT "__k0", SUM("a") AS "__a0" FROM (SELECT _f.*, (_j0."month" + INTERVAL \'1\' YEAR) AS "__k0" FROM (SELECT * FROM orders) AS _f ' +
          'LEFT JOIN (SELECT * FROM dates) AS _j0 ON CAST(_f."day" AS DATE) = _j0."date" WHERE _j0."month" IS NOT NULL) AS _m GROUP BY "__k0"',
      );
    });

    it("shifts only x: the series keeps its value", () => {
      const sql = along({ kind: "shift", unit: "grain" }, "sum", [x, key("customers", "region")]);
      expect(sql).toContain(`(_j0."month" + INTERVAL '1' MONTH) AS "__k0", _j1."region" AS "__k1"`);
    });

    it("adds up to date within the period, in order of x", () => {
      expect(along({ kind: "to_date", period: "year" })).toBe(
        'SELECT "__k0", SUM("__a0") OVER (PARTITION BY CAST(DATE_TRUNC(\'year\', "__k0") AS DATE) ORDER BY "__k0" ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "__a0" ' +
          `FROM (${GROUPED}) AS _g`,
      );
    });

    it("adds up to date within the period and the series, and in x itself when the period is the grain", () => {
      expect(along({ kind: "to_date", period: "year" }, "sum", [x, key("customers", "region")])).toContain(
        'OVER (PARTITION BY CAST(DATE_TRUNC(\'year\', "__k0") AS DATE), "__k1" ORDER BY "__k0" ROWS',
      );
      expect(along({ kind: "to_date", period: "month" })).toContain('OVER (PARTITION BY "__k0" ORDER BY "__k0" ROWS');
    });

    it("runs along x within the series, past nothing else", () => {
      expect(along({ kind: "running" })).toContain('OVER (ORDER BY "__k0" ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS "__a0" FROM (');
      expect(along({ kind: "running" }, "sum", [x, key("customers", "region")])).toContain('OVER (PARTITION BY "__k1" ORDER BY "__k0" ROWS');
    });

    it("accumulates a count by adding, a min by the min and a max by the max", () => {
      expect(along({ kind: "running" }, "count")).toContain('SUM("__a0") OVER');
      expect(along({ kind: "running" }, "min")).toContain('MIN("__a0") OVER');
      expect(along({ kind: "to_date", period: "year" }, "max")).toContain('MAX("__a0") OVER');
    });

    it("rolls over a count of periods on a RANGE frame: the engine takes no offset in months, and months can be missing", () => {
      expect(along({ kind: "rolling", n: 3 })).toContain(
        'OVER (ORDER BY EXTRACT(YEAR FROM "__k0") * 12 + EXTRACT(MONTH FROM "__k0") RANGE BETWEEN 2 PRECEDING AND CURRENT ROW) AS "__a0"',
      );
      expect(along({ kind: "rolling", n: 1 })).toContain("RANGE BETWEEN 0 PRECEDING");
    });

    it("rolls a week as seven days, a day as one, a quarter and a year as their own number", () => {
      const rolling = (column: string) => sqlOf([of({ window: { kind: "rolling", n: 3 } })], [key("dates", column)], 0, source, true);
      expect(rolling("week")).toContain('OVER (ORDER BY CAST("__k0" AS INTEGER) RANGE BETWEEN 14 PRECEDING');
      expect(rolling("date")).toContain('OVER (ORDER BY CAST("__k0" AS INTEGER) RANGE BETWEEN 2 PRECEDING');
      expect(rolling("quarter")).toContain('OVER (ORDER BY EXTRACT(YEAR FROM "__k0") * 4 + EXTRACT(QUARTER FROM "__k0") RANGE BETWEEN 2 PRECEDING');
      expect(rolling("year")).toContain('OVER (ORDER BY "__k0" RANGE BETWEEN 2 PRECEDING');
    });

    it("rolls over a count of rows when x is no calendar column", () => {
      const sql = sqlOf([of({ window: { kind: "rolling", n: 3 } })], [key("customers", "region")], 0, source, true);
      expect(sql).toContain('OVER (ORDER BY "__k0" ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS "__a0"');
    });

    it("reads the calendar whole, but only for a window that reads past its filters", () => {
      const asked: [string, Ignore | undefined][] = [];
      const spy = (d: string, ignore?: Ignore) => (asked.push([d, ignore]), `SELECT * FROM ${d}`);
      sqlOf([of({ window: { kind: "to_date", period: "year" } })], [x], 0, spy, true);
      expect(asked).toEqual([["dates", { datasets: ["dates"], columns: [] }], ["orders", { datasets: ["dates"], columns: [] }]]);
      asked.length = 0;
      sqlOf([of({ window: { kind: "running" } })], [x], 0, spy, true);
      expect(asked).toEqual([["dates", undefined], ["orders", undefined]]);
    });
  });
});
