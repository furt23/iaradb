/** What a measure added, renamed or deleted does to the widgets that draw it (pure). */

import { asValues } from "@/lib/dashboards/chartFields";
import type { ChartStyle, ChartWidget, Widget } from "@/lib/dashboards/types";

/** The chart widgets that draw the measure. */
export const widgetsUsing = (widgets: readonly Widget[], name: string): ChartWidget[] =>
  widgets.filter((w): w is ChartWidget => w.kind === "chart" && !!w.measures?.includes(name));

/** The chart's style with the series style of `from` moved to `to`, or dropped when there is no `to`. */
export function restyled(chart: ChartWidget, from: string, to?: string): ChartWidget {
  const series = chart.style?.series;
  if (!chart.style || !series || !Object.hasOwn(series, from)) return chart;
  const { [from]: moved, ...rest } = series;
  const next = to === undefined ? rest : { ...rest, [to]: moved };
  const { series: _old, ...others } = chart.style;
  const style: ChartStyle = Object.keys(next).length ? { ...others, series: next } : others;
  const { style: _style, ...bare } = chart;
  return Object.keys(style).length ? { ...bare, style } : bare;
}

/** The chart drawing the measure too, after what it already draws (a card draws one: the measure takes its place). */
export function withMeasure(chart: ChartWidget, name: string, word?: Parameters<typeof asValues>[1]): ChartWidget {
  if (chart.measures?.includes(name)) return chart;
  const c = asValues(chart, word);
  if (c.spec.kind === "counter" && c.style?.look !== "gauge") {
    const { values: _v, ...bare } = c;
    return { ...bare, measures: [name] };
  }
  return { ...c, measures: [...(c.measures ?? []), name] };
}

/** The chart without the measure (no `measures` key when it was the last). */
export function withoutMeasure(chart: ChartWidget, name: string): ChartWidget {
  const { measures, ...bare } = restyled(chart, name);
  const rest = (measures ?? []).filter((m) => m !== name);
  return rest.length ? { ...bare, measures: rest } : bare;
}

/** The charts that draw `from`, drawing `to` in its place: only these changed. */
export function renameInWidgets(widgets: readonly Widget[], from: string, to: string): ChartWidget[] {
  return widgetsUsing(widgets, from).map((w) => ({ ...restyled(w, from, to), measures: [...new Set(w.measures!.map((m) => (m === from ? to : m)))] }));
}

/** The charts that drew `name`, without it: only these changed. */
export const removeFromWidgets = (widgets: readonly Widget[], name: string): ChartWidget[] => widgetsUsing(widgets, name).map((w) => withoutMeasure(w, name));
