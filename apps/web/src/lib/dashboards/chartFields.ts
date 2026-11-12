/** What a chart draws, whether its fields are the kernel's aggregation of `spec.y`, the model's measures or values of its own (pure). */

import type { CellValue } from "@iara/protocol";

import type { ChartWidget, ValueAgg, ValueField } from "./types";

const AGG_WORDS: Record<ValueAgg, string> = { sum: "Sum", avg: "Average", count: "Count", count_distinct: "Distinct count", min: "Min", max: "Max" };

/** The name a value is drawn under, in the author's language: `word` gives it (`t` in the editor). */
export function valueName(agg: ValueAgg, column: string | undefined, word: (key: string, vars: { column: string }) => string = (key, { column: c }) => key.replace("{{column}}", c)): string {
  // `:` would read as a parameter in the SQL it names
  return word(column === undefined ? "Rows" : `${AGG_WORDS[agg]} of {{column}}`, { column: (column ?? "").replaceAll(":", " ") });
}

/** The kinds drawn from raw rows by the kernel (they have no value fields). */
export const usesRows = (w: ChartWidget): boolean => w.spec.kind === "scatter" || w.spec.kind === "histogram";

/** The chart draws from a query of its own, through the model. */
export const isModelChart = (w: ChartWidget): boolean => !!w.measures?.length || !!w.values?.length;

/**
 * The chart with what the kernel would aggregate (`spec.y`, `spec.agg`) as value fields, the form the editor
 * works on: a chart written before value fields existed draws the same once edited. Raw rows become a sum.
 */
export function asValues(w: ChartWidget, word?: Parameters<typeof valueName>[2]): ChartWidget {
  if (usesRows(w) || w.measures?.length || w.values?.length) return w;
  const { y, agg } = w.spec;
  const fieldAgg: ValueAgg = agg === "none" ? "sum" : agg;
  const values: ValueField[] =
    agg === "count"
      ? [{ name: valueName("count", undefined, word), dataset: w.dataset, agg: "count" }]
      : y.map((column) => ({ name: valueName(fieldAgg, column, word), dataset: w.dataset, column, agg: fieldAgg }));
  return { ...w, spec: { ...w.spec, y: [], agg: "sum" }, ...(values.length && { values }) };
}

/** The names of what the chart draws, as the result's columns. */
export const drawnNames = (w: ChartWidget): string[] => [...(w.measures ?? []), ...(w.values ?? []).map((v) => v.name)];

/** What the chart still needs before it can draw anything (an English key for `t`), or null. */
export function chartMissing(w: ChartWidget): string | null {
  if (usesRows(w)) return null;
  if (!drawnNames(asValues(w)).length) return "Add a value from the Fields pane";
  return w.spec.kind !== "counter" && !w.spec.x ? "Add a column to the X axis" : null;
}

/** The rows of the first `top` values of the column at `x`, in the order they come. */
export function firstCategories(rows: CellValue[][], x: number, top: number): CellValue[][] {
  const seen = new Set<CellValue>();
  return rows.filter((r) => {
    if (!seen.has(r[x]) && seen.size >= top) return false;
    seen.add(r[x]);
    return true;
  });
}
