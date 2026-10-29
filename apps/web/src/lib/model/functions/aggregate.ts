/** Aggregations: they collapse the rows of a dataset into one value. */

import { bind, fail, type FnDef } from "./def";

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
      return { level: "aggregate", sql: render(x.sql), datasets: x.datasets };
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
      return { level: "aggregate", sql: "COUNT(*)", datasets: [cx.dataset(dataset)] };
    },
  },
];
