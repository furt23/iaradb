/**
 * Stage 4b: calendars. A calendar is a dataset the model makes of the distinct
 * dates of some columns; the time windows (previous year, year to date, rolling)
 * run along its columns, so their rules and their bits of SQL live next to it.
 */

import { quoteIdent } from "@/lib/dashboards/query";

import { CALENDAR_COLUMNS, type AtomWindow, type Calendar, type CalendarColumn, type ColumnRef } from "./types";

/** a subquery's text; a `--` comment at its end would swallow the closing parenthesis */
export const guard = (sql: string): string => (sql.includes("--") ? `\n${sql}\n` : sql);

/**
 * The rows of a calendar: each distinct date of its columns once, with the columns of CALENDAR_COLUMNS.
 * DATE_TRUNC('week') starts on Monday here and EXTRACT has no ISODOW, so day_of_week turns Sunday (0) into 7.
 */
export function calendarSql(cal: Calendar, base: (dataset: string) => string): string {
  if (cal.columns.length === 0) throw new Error(`calendar ${cal.name} has no columns`);
  const dates = cal.columns.map(
    (c, i) => `SELECT CAST(${quoteIdent(c.column)} AS DATE) AS "date" FROM (${guard(base(c.dataset))}) AS _s${i} WHERE ${quoteIdent(c.column)} IS NOT NULL`,
  );
  const part = (x: string) => `EXTRACT(${x} FROM "date")`;
  const start = (unit: string) => `CAST(DATE_TRUNC('${unit}', "date") AS DATE)`;
  const columns: Record<CalendarColumn, string> = {
    date: '"date"',
    year: `CAST(${part("YEAR")} AS INTEGER)`,
    quarter: start("quarter"),
    month: start("month"),
    week: start("week"),
    month_of_year: `CAST(${part("MONTH")} AS INTEGER)`,
    day_of_week: `CAST(CASE WHEN ${part("DOW")} = 0 THEN 7 ELSE ${part("DOW")} END AS INTEGER)`,
  };
  const select = CALENDAR_COLUMNS.map((c) => (c === "date" ? columns.date : `${columns[c]} AS ${quoteIdent(c)}`)).join(", ");
  return `SELECT ${select} FROM (SELECT DISTINCT "date" FROM (${dates.join(" UNION ALL ")}) AS _u) AS _d`;
}

/** the steps a time window moves in, finest first */
export type Grain = "day" | "week" | "month" | "quarter" | "year";
const ORDER: readonly Grain[] = ["day", "week", "month", "quarter", "year"];
const finer = (a: Grain, b: Grain) => ORDER.indexOf(a) < ORDER.indexOf(b);

/** the calendar columns that are a time grain (month_of_year and day_of_week are not: January of every year is one value) */
const GRAIN_OF: Partial<Record<CalendarColumn, Grain>> = { date: "day", week: "week", month: "month", quarter: "quarter", year: "year" };

/**
 * What a window needs of the chart's x, or throws; `name` is the measure, for the message.
 * Returns x's grain, null when x is not a time column of a calendar.
 */
export function checkWindow(name: string, w: AtomWindow, calendars: readonly Calendar[], x: ColumnRef | null): Grain | null {
  if (!x) throw new Error(`${name} needs the chart's x axis`);
  const cal = calendars.find((c) => c.name === x.dataset && (CALENDAR_COLUMNS as readonly string[]).includes(x.column));
  const grain = cal ? (GRAIN_OF[x.column as CalendarColumn] ?? null) : null;
  if (w.kind === "running") return grain;
  if (cal && !grain) throw new Error(`${name} needs the x axis on a date, week, month, quarter or year of ${cal.name}, not ${x.column}`);
  if (w.kind === "rolling") return grain;

  if (!grain) throw new Error(`${name} needs the x axis on a calendar column, e.g. ${calendars[0]?.name ?? "dates"}.month`);
  if (w.kind === "to_date" && finer(w.period, grain)) {
    throw new Error(`${name} adds up from the start of the ${w.period}, but the x axis is by ${grain}`);
  }
  if (w.kind === "shift" && w.unit !== "grain") {
    // a week moved by a month or more lands on a day that is not a Monday: no week is there to meet it
    if (finer(w.unit, grain) || (grain === "week" && w.unit !== "week")) throw new Error(`${name} cannot shift by a ${w.unit} on an x axis by ${grain}`);
  }
  return grain;
}

/** a key moved forward by one `unit` (a year's integer by 1), so that a period's value lands on the period it is compared to */
export function shiftedKey(key: string, grain: Grain, unit: Grain | "grain"): string {
  // shortcut: at day grain, moving Feb 29 or the 31st by a year or a month lands on the same day as the day before: they add up; upgrade if charts need it
  return grain === "year" ? `(${key} + 1)` : `(${key} + INTERVAL '1' ${(unit === "grain" ? grain : unit).toUpperCase()})`;
}

/** the DATE the `period` of a key begins on (the key itself when the period is the grain), to add up within */
export function periodStart(key: string, grain: Grain, period: "year" | "quarter" | "month"): string {
  return period === grain ? key : `CAST(DATE_TRUNC('${period}', ${key}) AS DATE)`;
}

/**
 * A whole number that grows by `step` from one period to the next, for a RANGE frame:
 * the engine refuses RANGE offsets in months on dates, so the months count as year * 12 + month.
 */
export function periodIndex(key: string, grain: Grain): { index: string; step: number } {
  const part = (x: string) => `EXTRACT(${x} FROM ${key})`;
  switch (grain) {
    case "day":
      return { index: `CAST(${key} AS INTEGER)`, step: 1 };
    case "week":
      // weeks begin on a Monday, so their days are 7 apart
      return { index: `CAST(${key} AS INTEGER)`, step: 7 };
    case "month":
      return { index: `${part("YEAR")} * 12 + ${part("MONTH")}`, step: 1 };
    case "quarter":
      return { index: `${part("YEAR")} * 4 + ${part("QUARTER")}`, step: 1 };
    case "year":
      return { index: key, step: 1 };
  }
}
