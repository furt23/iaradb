/** Aggregations: they collapse the rows of a dataset into one value (an atom). */

import type { Call } from "../ast";
import { sql, text } from "../parts";
import type { Atom } from "../types";
import { bind, fail, list, type FnCx, type FnDef } from "./def";

/** The one dataset an aggregation reads: a total of two datasets' rows side by side has no meaning. */
function readsOne(call: Call, datasets: readonly string[]): string {
  if (datasets.length === 0) fail(call, `${call.func}() does not read any dataset: aggregate a column, e.g. sum(orders.total)`);
  if (datasets.length > 1) fail(call, `an aggregation reads one dataset: ${call.func}(...) reads ${list(datasets)}`);
  return datasets[0];
}

/** The dataset and the SQL of the value per row an aggregation takes, never another aggregation. */
function operand(call: Call, cx: FnCx): { dataset: string; x: string } {
  const { expr } = bind(call, { params: ["expr"], required: 1, positional: 1 });
  const t = cx.expr(expr);
  if (t.level === "aggregate") fail(expr, `an aggregation inside another is not allowed: ${call.func}() takes a value per row`);
  return { dataset: readsOne(call, t.datasets), x: text(t.sql) };
}

/** `sum(expr)` and friends: `expr` is a value per row (or a constant). */
function aggregate(name: string, agg: Atom["agg"], render: (x: string) => string, doc: string, example: string): FnDef {
  return {
    kind: "expr",
    name,
    signature: `${name}(expr)`,
    doc: `${doc} Example: ${example}`,
    check(call, cx) {
      const { dataset, x } = operand(call, cx);
      return { level: "aggregate", sql: [{ dataset, sql: render(x), agg }], datasets: [dataset] };
    },
  };
}

export const AGGREGATE_FUNCTIONS: readonly FnDef[] = [
  aggregate("sum", "sum", (x) => `SUM(${x})`, "Total of the values.", "sum(orders.total)"),
  {
    kind: "expr",
    name: "avg",
    signature: "avg(expr)",
    doc: "Average of the values. Example: avg(orders.total)",
    // a sum and a count, so that windows (running, year to date) add them up before dividing
    check(call, cx) {
      const { dataset, x } = operand(call, cx);
      const total: Atom = { dataset, sql: `SUM(${x})`, agg: "sum" };
      const count: Atom = { dataset, sql: `COUNT(${x})`, agg: "count" };
      return { level: "aggregate", sql: sql`(CAST(${[total]} AS DOUBLE) / NULLIF(${[count]}, 0))`, datasets: [dataset] };
    },
  },
  aggregate("min", "min", (x) => `MIN(${x})`, "Smallest value.", "min(orders.total)"),
  aggregate("max", "max", (x) => `MAX(${x})`, "Largest value.", "max(orders.total)"),
  aggregate("count", "count", (x) => `COUNT(${x})`, "How many rows have a value (empty values are not counted).", "count(orders.customer_id)"),
  aggregate("count_distinct", "count_distinct", (x) => `COUNT(DISTINCT ${x})`, "How many different values there are.", "count_distinct(orders.customer_id)"),
  {
    kind: "expr",
    name: "count_rows",
    signature: "count_rows(dataset)",
    doc: "How many rows the dataset has. Example: count_rows(orders)",
    check(call, cx) {
      const { dataset } = bind(call, { params: ["dataset"], required: 1, positional: 1 });
      const name = cx.dataset(dataset);
      return { level: "aggregate", sql: [{ dataset: name, sql: "COUNT(*)", agg: "count" }], datasets: [name] };
    },
  },
];
