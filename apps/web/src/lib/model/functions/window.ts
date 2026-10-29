/**
 * Functions that work along the chart's x: `running_total` and `rank` here,
 * and `applyWindow`, which the time functions (time.ts) use too.
 */

import type { Call, Expr } from "../ast";
import { hasRank, mapAtoms } from "../parts";
import type { AtomWindow } from "../types";
import { bind, fail, needAggregate, type FnCx, type FnDef, type Typed } from "./def";

const PERIOD_FUNCTIONS = { year: "ytd", quarter: "qtd", month: "mtd" } as const;

/** The function a window came from, for "ytd cannot wrap previous_year". */
function windowName(w: AtomWindow): string {
  switch (w.kind) {
    case "shift":
      return w.unit === "year" ? "previous_year" : "previous_period";
    case "to_date":
      return PERIOD_FUNCTIONS[w.period];
    case "running":
      return "running_total";
    case "rolling":
      return "rolling";
  }
}

/**
 * Gives every atom of `measure` the window `fn` stands for. An atom takes one
 * window; a distinct count cannot be added up from one period to the next; and
 * the windows that read dates need a calendar. Its context (calculate) is kept.
 */
export function applyWindow(fn: string, call: Call, measure: Expr, t: Typed, window: AtomWindow, cx: FnCx): Typed {
  needAggregate(fn, measure, t);
  if (hasRank(t.sql)) fail(measure, `${fn} cannot wrap rank`);
  const accumulates = window.kind === "to_date" || window.kind === "running" || window.kind === "rolling";
  const sql = mapAtoms(t.sql, (atom) => {
    if (atom.window) fail(measure, `${fn} cannot wrap ${windowName(atom.window)}`);
    if (accumulates && atom.agg === "count_distinct") fail(measure, `count_distinct cannot be accumulated by ${fn}`);
    return { ...atom, window };
  });
  if ((window.kind === "to_date" || window.kind === "shift") && cx.calendars.length === 0) {
    fail(call, `${fn} needs a calendar: dates = calendar(orders.o_orderdate)`);
  }
  return { ...t, sql };
}

export const WINDOW_FUNCTIONS: readonly FnDef[] = [
  {
    kind: "expr",
    name: "running_total",
    signature: "running_total(measure)",
    doc: "The measure added up from the first x of the chart to each x, within each series. Example: running_total(sum(orders.total))",
    check(call, cx) {
      const { measure } = bind(call, { params: ["measure"], required: 1, positional: 1 });
      return applyWindow("running_total", call, measure, cx.expr(measure), { kind: "running" }, cx);
    },
  },
  {
    kind: "expr",
    name: "rank",
    signature: "rank(measure)",
    doc: "Where the measure stands among the chart's x values, 1 for the highest, within each series. Example: rank(sum(orders.total))",
    check(call, cx) {
      const { measure } = bind(call, { params: ["measure"], required: 1, positional: 1 });
      const t = cx.expr(measure);
      needAggregate("rank", measure, t);
      if (hasRank(t.sql)) fail(measure, "rank cannot wrap rank");
      return { level: "aggregate", sql: [{ rank: t.sql }], datasets: t.datasets };
    },
  },
];
