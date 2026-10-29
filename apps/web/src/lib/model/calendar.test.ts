import { describe, expect, it } from "vitest";

import { calendar } from "./testing";
import { calendarSql, checkWindow, guard, periodIndex, periodStart, shiftedKey } from "./calendar";
import type { AtomWindow } from "./types";

const base = (d: string) => `SELECT * FROM ${d}`;
const COLUMNS =
  '"date", CAST(EXTRACT(YEAR FROM "date") AS INTEGER) AS "year", CAST(DATE_TRUNC(\'quarter\', "date") AS DATE) AS "quarter", ' +
  'CAST(DATE_TRUNC(\'month\', "date") AS DATE) AS "month", CAST(DATE_TRUNC(\'week\', "date") AS DATE) AS "week", ' +
  'CAST(EXTRACT(MONTH FROM "date") AS INTEGER) AS "month_of_year", ' +
  'CAST(CASE WHEN EXTRACT(DOW FROM "date") = 0 THEN 7 ELSE EXTRACT(DOW FROM "date") END AS INTEGER) AS "day_of_week"';

describe("calendarSql", () => {
  it("is the distinct non-null dates of the columns, with the calendar's columns", () => {
    expect(calendarSql(calendar("dates", "orders.o_date", "targets.t_date"), base)).toBe(
      `SELECT ${COLUMNS} FROM (SELECT DISTINCT "date" FROM (` +
        'SELECT CAST("o_date" AS DATE) AS "date" FROM (SELECT * FROM orders) AS _s0 WHERE "o_date" IS NOT NULL UNION ALL ' +
        'SELECT CAST("t_date" AS DATE) AS "date" FROM (SELECT * FROM targets) AS _s1 WHERE "t_date" IS NOT NULL) AS _u) AS _d',
    );
  });

  it("is the same shape for one column", () => {
    expect(calendarSql(calendar("dates", "orders.o_date"), base)).toBe(
      `SELECT ${COLUMNS} FROM (SELECT DISTINCT "date" FROM (SELECT CAST("o_date" AS DATE) AS "date" FROM (SELECT * FROM orders) AS _s0 WHERE "o_date" IS NOT NULL) AS _u) AS _d`,
    );
  });

  it("reads each dataset as the caller gives it, unfiltered, and quotes the names", () => {
    const sql = calendarSql(calendar("dates", 'o.we"ird'), (d) => `SELECT * FROM raw_${d}`);
    expect(sql).toContain('CAST("we""ird" AS DATE) AS "date" FROM (SELECT * FROM raw_o) AS _s0 WHERE "we""ird" IS NOT NULL');
  });

  it("keeps a line comment at the end of a dataset's text from swallowing the parenthesis", () => {
    expect(calendarSql(calendar("dates", "orders.o_date"), () => "SELECT * FROM t -- all")).toContain("FROM (\nSELECT * FROM t -- all\n) AS _s0");
    expect(guard("SELECT 1")).toBe("SELECT 1");
  });

  it("needs a column", () => {
    expect(() => calendarSql(calendar("dates"), base)).toThrow("calendar dates has no columns");
  });
});

describe("checkWindow", () => {
  const cals = [calendar("dates", "orders.day")];
  const x = (column: string) => ({ dataset: "dates", column });
  const check = (w: AtomWindow, xAxis: { dataset: string; column: string } | null) => checkWindow("m", w, cals, xAxis);
  const ytd: AtomWindow = { kind: "to_date", period: "year" };
  const prev: AtomWindow = { kind: "shift", unit: "year" };

  it("needs the chart's x axis", () => {
    for (const w of [ytd, prev, { kind: "running" } as const, { kind: "rolling", n: 3 } as const]) {
      expect(() => check(w, null)).toThrow("m needs the chart's x axis");
    }
  });

  it("needs the x axis on a calendar column for a shift and a total to date", () => {
    expect(() => check(prev, { dataset: "orders", column: "day" })).toThrow("m needs the x axis on a calendar column, e.g. dates.month");
    expect(() => check(ytd, { dataset: "dates", column: "nope" })).toThrow("e.g. dates.month");
    expect(() => checkWindow("m", ytd, [], { dataset: "orders", column: "day" })).toThrow("e.g. dates.month");
  });

  it("finds x's grain: date is the day, the others are their own", () => {
    const grains = ["date", "week", "month", "quarter", "year"].map((c) => check({ kind: "shift", unit: "grain" }, x(c)));
    expect(grains).toEqual(["day", "week", "month", "quarter", "year"]);
  });

  it("refuses a time window on a calendar column that is no time grain", () => {
    for (const column of ["month_of_year", "day_of_week"]) {
      for (const w of [ytd, prev, { kind: "rolling", n: 3 } as const]) {
        expect(() => check(w, x(column))).toThrow(`m needs the x axis on a date, week, month, quarter or year of dates, not ${column}`);
      }
    }
  });

  it("lets a running total go along any x, a calendar column or not", () => {
    expect(check({ kind: "running" }, x("month_of_year"))).toBeNull();
    expect(check({ kind: "running" }, { dataset: "orders", column: "day" })).toBeNull();
    expect(check({ kind: "running" }, x("month"))).toBe("month");
  });

  it("lets a rolling window go along any x: a time grain counts periods, another x counts rows", () => {
    expect(check({ kind: "rolling", n: 3 }, x("month"))).toBe("month");
    expect(check({ kind: "rolling", n: 3 }, { dataset: "orders", column: "day" })).toBeNull();
  });

  it("adds up from the start of a period no finer than the x axis", () => {
    expect(check({ kind: "to_date", period: "year" }, x("date"))).toBe("day");
    expect(check({ kind: "to_date", period: "month" }, x("month"))).toBe("month");
    expect(check({ kind: "to_date", period: "quarter" }, x("week"))).toBe("week");
    expect(() => check({ kind: "to_date", period: "month" }, x("quarter"))).toThrow("m adds up from the start of the month, but the x axis is by quarter");
    expect(() => check({ kind: "to_date", period: "quarter" }, x("year"))).toThrow("by year");
  });

  it("shifts by a unit no finer than the x axis", () => {
    expect(() => check({ kind: "shift", unit: "week" }, x("month"))).toThrow("m cannot shift by a week on an x axis by month");
    expect(() => check({ kind: "shift", unit: "quarter" }, x("month"))).not.toThrow();
    expect(() => check({ kind: "shift", unit: "month" }, x("quarter"))).toThrow("by quarter");
    expect(() => check({ kind: "shift", unit: "month" }, x("year"))).toThrow("by year");
    expect(() => check({ kind: "shift", unit: "day" }, x("date"))).not.toThrow();
    expect(() => check({ kind: "shift", unit: "grain" }, x("year"))).not.toThrow();
  });

  it("does not shift a week by a month, a quarter or a year: the day it lands on is no Monday", () => {
    for (const unit of ["month", "quarter", "year"] as const) expect(() => check({ kind: "shift", unit }, x("week"))).toThrow(`cannot shift by a ${unit} on an x axis by week`);
    expect(() => check({ kind: "shift", unit: "week" }, x("week"))).not.toThrow();
  });
});

describe("the SQL of a window", () => {
  it("moves a key forward by a unit of dates, and a year's integer by 1", () => {
    expect(shiftedKey('_j0."month"', "month", "year")).toBe(`(_j0."month" + INTERVAL '1' YEAR)`);
    expect(shiftedKey('_j0."month"', "month", "grain")).toBe(`(_j0."month" + INTERVAL '1' MONTH)`);
    expect(shiftedKey('_j0."date"', "day", "week")).toBe(`(_j0."date" + INTERVAL '1' WEEK)`);
    expect(shiftedKey('_j0."quarter"', "quarter", "quarter")).toBe(`(_j0."quarter" + INTERVAL '1' QUARTER)`);
    expect(shiftedKey('_j0."year"', "year", "grain")).toBe('(_j0."year" + 1)');
    expect(shiftedKey('_j0."year"', "year", "year")).toBe('(_j0."year" + 1)');
  });

  it("finds the start of the period a key is in, the key itself when the period is the grain", () => {
    expect(periodStart('"__k0"', "month", "year")).toBe(`CAST(DATE_TRUNC('year', "__k0") AS DATE)`);
    expect(periodStart('"__k0"', "day", "month")).toBe(`CAST(DATE_TRUNC('month', "__k0") AS DATE)`);
    expect(periodStart('"__k0"', "month", "month")).toBe('"__k0"');
    expect(periodStart('"__k0"', "year", "year")).toBe('"__k0"');
  });

  it("counts periods in whole numbers for a RANGE frame, since the engine takes no month offsets", () => {
    expect(periodIndex('"__k0"', "day")).toEqual({ index: 'CAST("__k0" AS INTEGER)', step: 1 });
    expect(periodIndex('"__k0"', "week")).toEqual({ index: 'CAST("__k0" AS INTEGER)', step: 7 });
    expect(periodIndex('"__k0"', "month")).toEqual({ index: 'EXTRACT(YEAR FROM "__k0") * 12 + EXTRACT(MONTH FROM "__k0")', step: 1 });
    expect(periodIndex('"__k0"', "quarter")).toEqual({ index: 'EXTRACT(YEAR FROM "__k0") * 4 + EXTRACT(QUARTER FROM "__k0")', step: 1 });
    expect(periodIndex('"__k0"', "year")).toEqual({ index: '"__k0"', step: 1 });
  });
});
