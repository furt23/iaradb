/** The calendar and the functions that look along time: year to date, the period before, a rolling total. */

import { conflict } from "../graph";
import type { AtomWindow, Relationship } from "../types";
import { CALENDAR_COLUMNS } from "../types";
import { bind, fail, variadic, type FnDef } from "./def";
import { applyWindow } from "./window";

const UNITS = ["year", "quarter", "month", "week", "day"] as const;

/** `ytd(measure)` and the like: the measure under a fixed window. */
function windowed(name: string, window: AtomWindow, doc: string, example: string): FnDef {
  return {
    kind: "expr",
    name,
    signature: `${name}(measure)`,
    doc: `${doc} Example: ${example}`,
    check(call, cx) {
      const { measure } = bind(call, { params: ["measure"], required: 1, positional: 1 });
      return applyWindow(name, call, measure, cx.expr(measure), window, cx);
    },
  };
}

export const TIME_FUNCTIONS: readonly FnDef[] = [
  {
    kind: "declaration",
    name: "calendar",
    signature: "calendar(dataset.column, ...)",
    doc: `A table of dates made of the dates in these columns, named by the line, with the columns ${CALENDAR_COLUMNS.join(", ")}: group or filter by them (dates.year). The time functions need it. One per model. Example: dates = calendar(orders.created)`,
    check(call, cx, name) {
      variadic(call);
      if (cx.calendars.length > 0) fail(call, `only one calendar per model for now: ${cx.calendars[0].name} is on line ${cx.calendars[0].span.line}`);
      if (call.args.length === 0) fail(call, "calendar() needs at least one column, e.g. calendar(orders.o_orderdate)");
      const columns = call.args.map((a) => cx.column(a));
      const made: Relationship[] = [];
      columns.forEach((many, i) => {
        if (columns.slice(0, i).some((c) => c.dataset === many.dataset && c.column === many.column)) {
          fail(call.args[i], `calendar() lists ${many.dataset}.${many.column} twice`);
        }
        const rel: Relationship = { many, one: { dataset: name, column: "date" }, span: call.span, cast: "date" };
        const why = conflict([...cx.relationships, ...made], rel);
        if (why) fail(call.args[i], why);
        made.push(rel);
      });
      return { calendar: { name, columns, span: call.span }, relationships: made };
    },
  },
  windowed("ytd", { kind: "to_date", period: "year" }, "The measure added up from the start of the year to each x (year to date).", "ytd(sum(orders.total))"),
  windowed("qtd", { kind: "to_date", period: "quarter" }, "The measure added up from the start of the quarter to each x.", "qtd(sum(orders.total))"),
  windowed("mtd", { kind: "to_date", period: "month" }, "The measure added up from the start of the month to each x.", "mtd(sum(orders.total))"),
  windowed("previous_year", { kind: "shift", unit: "year" }, "The measure a year before each x.", "previous_year(sum(orders.total))"),
  {
    kind: "expr",
    name: "previous_period",
    signature: 'previous_period(measure, unit="year"|"quarter"|"month"|"week"|"day")',
    doc: "The measure one period before each x: the chart's own period (the x's grain), or the unit given. Example: previous_period(sum(orders.total), \"month\")",
    check(call, cx) {
      const a = bind(call, { params: ["measure", "unit"], required: 1, positional: 2 });
      let unit: (typeof UNITS)[number] | "grain" = "grain";
      if (a.unit) {
        if (a.unit.kind !== "str" || !(UNITS as readonly string[]).includes(a.unit.value)) fail(a.unit, 'unit must be "year", "quarter", "month", "week" or "day"');
        unit = a.unit.value as (typeof UNITS)[number];
      }
      return applyWindow("previous_period", call, a.measure, cx.expr(a.measure), { kind: "shift", unit }, cx);
    },
  },
  {
    kind: "expr",
    name: "rolling",
    signature: "rolling(measure, n)",
    doc: "The measure added up over the last n x values of the chart (the x itself included). Example: rolling(sum(orders.total), 3)",
    check(call, cx) {
      const a = bind(call, { params: ["measure", "n"], required: 2, positional: 2 });
      if (a.n.kind !== "num" || !a.n.int || Number(a.n.value) < 1) fail(a.n, "n must be a whole number from 1, written out: rolling(measure, 3)");
      return applyWindow("rolling", call, a.measure, cx.expr(a.measure), { kind: "rolling", n: Number(a.n.value) }, cx);
    },
  },
];
