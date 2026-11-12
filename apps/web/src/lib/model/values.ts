/** A chart's value fields as measures: `sum(orders.total)` without a line in `model.py`, read as the checker reads the same line. */

import { quoteIdent } from "@/lib/dashboards/query";
import type { ValueField } from "@/lib/dashboards/types";

import type { Atom, Measure, Model, Template } from "./types";

const NO_SPAN = { from: 0, to: 0, line: 0, col: 0 };

function shape(v: ValueField): { atoms: Atom[]; expr: Template } {
  const { dataset } = v;
  const c = v.column === undefined ? "*" : quoteIdent(v.column);
  const one = (sql: string, agg: Atom["agg"]) => ({ atoms: [{ dataset, sql, agg }], expr: [{ atom: 0 }] });
  switch (v.agg) {
    case "sum":
      return one(`SUM(${c})`, "sum");
    case "min":
      return one(`MIN(${c})`, "min");
    case "max":
      return one(`MAX(${c})`, "max");
    case "count":
      return one(`COUNT(${c})`, "count");
    case "count_distinct":
      return one(`COUNT(DISTINCT ${c})`, "count_distinct");
    case "avg":
      return {
        atoms: [
          { dataset, sql: `SUM(${c})`, agg: "sum" },
          { dataset, sql: `COUNT(${c})`, agg: "count" },
        ],
        expr: ["(CAST(", { atom: 0 }, " AS DOUBLE) / NULLIF(", { atom: 1 }, ", 0))"],
      };
  }
}

export function valueMeasure(v: ValueField): Measure {
  return { name: v.name, datasets: [v.dataset], ...shape(v), ...(v.format && { format: v.format }), span: NO_SPAN };
}

/** The model with the chart's values among its measures; a value takes the place of a measure of its name. */
export function withValues(model: Model, values: readonly ValueField[] = []): Model {
  return values.length ? { ...model, measures: [...values.map(valueMeasure), ...model.measures] } : model;
}
