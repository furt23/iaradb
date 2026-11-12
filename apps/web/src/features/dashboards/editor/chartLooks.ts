/** The visuals a chart widget can be: a kind of data and a look to draw it in (pure). One line here adds one to the gallery. */

import type { ChartKind, ColumnInfo } from "@iara/protocol";

import { asValues, drawnNames, type valueName } from "@/lib/dashboards/chartFields";
import type { ChartLook, ChartWidget } from "@/lib/dashboards/types";
import { isNumericType } from "@/lib/format";

export type LookId = "column" | "stacked" | "percent" | "hbar" | "hbar_stacked" | "hbar_percent" | "combo" | "line" | "area" | "area_stacked" | "pie" | "donut" | "treemap" | "funnel" | "waterfall" | "heatmap" | "matrix" | "counter" | "gauge" | "scatter" | "histogram";

export interface LookDef {
  id: LookId;
  kind: ChartKind;
  look?: ChartLook;
  /** an English key for `t` */
  label: string;
}

export const CHART_LOOKS: readonly LookDef[] = [
  { id: "column", kind: "bar", label: "Columns" },
  { id: "stacked", kind: "bar", look: "stacked", label: "Stacked columns" },
  { id: "percent", kind: "bar", look: "percent", label: "100% columns" },
  { id: "hbar", kind: "bar", look: "hbar", label: "Bars" },
  { id: "hbar_stacked", kind: "bar", look: "hbar_stacked", label: "Stacked bars" },
  { id: "hbar_percent", kind: "bar", look: "hbar_percent", label: "100% bars" },
  { id: "line", kind: "line", label: "Line" },
  { id: "area", kind: "area", label: "Area" },
  { id: "area_stacked", kind: "area", look: "area_stacked", label: "Stacked area" },
  { id: "combo", kind: "bar", look: "combo", label: "Columns and line" },
  { id: "pie", kind: "pie", label: "Pie" },
  { id: "donut", kind: "pie", look: "donut", label: "Donut" },
  { id: "treemap", kind: "pie", look: "treemap", label: "Treemap" },
  { id: "funnel", kind: "pie", look: "funnel", label: "Funnel" },
  { id: "waterfall", kind: "bar", look: "waterfall", label: "Waterfall" },
  { id: "heatmap", kind: "bar", look: "heatmap", label: "Heatmap" },
  { id: "matrix", kind: "bar", look: "matrix", label: "Matrix" },
  { id: "counter", kind: "counter", label: "Card" },
  { id: "gauge", kind: "counter", look: "gauge", label: "Gauge" },
  { id: "scatter", kind: "scatter", label: "Scatter" },
  { id: "histogram", kind: "histogram", label: "Histogram" },
];

export const lookIdOf = (w: ChartWidget): LookId | undefined => CHART_LOOKS.find((l) => l.kind === w.spec.kind && l.look === w.style?.look)?.id;

/** The most values a kind of visual draws (null: as many as the chart holds). */
export function maxValues(kind: ChartKind, look: ChartLook | undefined): number | null {
  return kind === "counter" ? (look === "gauge" ? 2 : 1) : null;
}

const categoryOf = (columns: ColumnInfo[]): string => (columns.find((c) => !isNumericType(c.type)) ?? columns[0])?.name ?? "";

/** The chart without the fields of another kind of chart. */
function withoutFields(w: ChartWidget): ChartWidget {
  const { measures: _m, values: _v, sort: _s, top: _t, ...bare } = w;
  return bare;
}

/**
 * The chart as this visual, keeping what fits it. `columns`: those of its dataset. A scatter or a histogram reads
 * raw rows of its own dataset, so only that dataset's value columns go with it; going back gets a category for x.
 */
export function withLook(w: ChartWidget, def: LookDef, columns: ColumnInfo[], word?: Parameters<typeof valueName>[2]): ChartWidget {
  const { look: _look, ...others } = w.style ?? {};
  const rest = { ...others, ...(def.look && { look: def.look }) };
  const style = Object.keys(rest).length ? { style: rest } : {};
  const { style: _style, ...plain } = w;
  const c = asValues(plain, word);
  if (def.kind === "scatter" || def.kind === "histogram") {
    const numeric = columns.filter((col) => isNumericType(col.type)).map((col) => col.name);
    const own = (c.values ?? []).flatMap((v) => (v.dataset === w.dataset && v.column && numeric.includes(v.column) ? [v.column] : []));
    const picked = [...own, ...numeric.filter((n) => !own.includes(n))];
    const group = c.spec.group && columns.some((col) => col.name === c.spec.group) ? c.spec.group : null;
    const spec =
      def.kind === "histogram"
        ? { ...c.spec, kind: def.kind, x: picked[0] ?? "", y: [], agg: "count" as const, group }
        : { ...c.spec, kind: def.kind, x: numeric.includes(c.spec.x) ? c.spec.x : (picked[0] ?? ""), y: own.length ? own : picked.slice(1, 2), agg: "none" as const, group };
    return { ...withoutFields(c), spec, ...style };
  }
  const wasRows = w.spec.kind === "scatter" || w.spec.kind === "histogram";
  const x = def.kind === "counter" ? "" : c.spec.x && !wasRows ? c.spec.x : categoryOf(columns);
  const group = def.kind === "pie" || def.kind === "counter" ? null : (c.spec.group ?? null);
  const spec = { ...c.spec, kind: def.kind, x, group };
  const max = maxValues(def.kind, def.look);
  if (max === null || drawnNames(c).length <= max) return { ...c, spec, ...style };
  const measures = (c.measures ?? []).slice(0, max);
  const values = (c.values ?? []).slice(0, max - measures.length);
  return { ...withoutFields(c), ...(measures.length && { measures }), ...(values.length && { values }), spec, ...style };
}
