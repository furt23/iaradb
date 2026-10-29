/** Aggregations: they collapse the rows of a dataset into one value (an atom). */

import type { Call } from "../ast";
import { text } from "../parts";
import { bind, fail, list, type FnDef } from "./def";

/** The one dataset an aggregation reads: a total of two datasets' rows side by side has no meaning. */
function readsOne(call: Call, datasets: readonly string[]): string {
  if (datasets.length === 0) fail(call, `${call.func}() does not read any dataset: aggregate a column, e.g. sum(orders.total)`);
  if (datasets.length > 1) fail(call, `an aggregation reads one dataset: ${call.func}(...) reads ${list(datasets)}`);
  return datasets[0];
}

/** `sum(expr)` and friends: `expr` is a value per row (or a constant), never another aggregation. */
function aggregate(name: string, render: (x: string) => string, doc: string, example: string): FnDef {
  return {
    kind: "expr",
    name,
    signature: `${name}(expr)`,
    doc: `${doc} Example: ${example}`,
    check(call, cx) {
      const { expr } = bind(call, { params: ["expr"], required: 1, positional: 1 });
      const x = cx.expr(expr);
      if (x.level === "aggregate") fail(expr, `an aggregation inside another is not allowed: ${name}() takes a value per row`);
      const dataset = readsOne(call, x.datasets);
      return { level: "aggregate", sql: [{ dataset, sql: render(text(x.sql)) }], datasets: [dataset] };
    },
  };
}

export const AGGREGATE_FUNCTIONS: readonly FnDef[] = [
  aggregate("sum", (x) => `SUM(${x})`, "Total of the values.", "sum(orders.total)"),
  aggregate("avg", (x) => `AVG(${x})`, "Average of the values.", "avg(orders.total)"),
  aggregate("min", (x) => `MIN(${x})`, "Smallest value.", "min(orders.total)"),
  aggregate("max", (x) => `MAX(${x})`, "Largest value.", "max(orders.total)"),
  aggregate("count", (x) => `COUNT(${x})`, "How many rows have a value (empty values are not counted).", "count(orders.customer_id)"),
  aggregate("count_distinct", (x) => `COUNT(DISTINCT ${x})`, "How many different values there are.", "count_distinct(orders.customer_id)"),
  {
    kind: "expr",
    name: "count_rows",
    signature: "count_rows(dataset)",
    doc: "How many rows the dataset has. Example: count_rows(orders)",
    check(call, cx) {
      const { dataset } = bind(call, { params: ["dataset"], required: 1, positional: 1 });
      const name = cx.dataset(dataset);
      return { level: "aggregate", sql: [{ dataset: name, sql: "COUNT(*)" }], datasets: [name] };
    },
  },
];
