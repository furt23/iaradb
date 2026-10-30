/** What checking, clicking or dropping a field of the Fields pane does to the selected widget (pure). */

import type { ChartWidget, Widget } from "@/lib/dashboards/types";

import type { FieldRef } from "../canvas/fieldDrag";
import { withMeasure, withoutMeasure } from "./measureWidgets";

/**
 * How a field shows for a widget: a checkbox (`check`: a measure of a chart, a column of a table),
 * a column the chart's x can be (`pick`), or nothing when the widget does not take the field.
 */
export type FieldState = { control: "check"; checked: boolean } | { control: "pick"; picked: boolean } | null;

/** The x of a chart for a column: bare in the chart's own dataset, `dataset.column` in a related one. */
const xOf = (chart: ChartWidget, field: FieldRef): string => (field.dataset === chart.dataset ? field.name : `${field.dataset}.${field.name}`);

export function fieldState(widget: Widget | undefined, field: FieldRef): FieldState {
  if (widget?.kind === "chart") {
    if (field.kind === "measure") return { control: "check", checked: !!widget.measures?.includes(field.name) };
    // a counter has no x
    return widget.spec.kind === "counter" ? null : { control: "pick", picked: widget.spec.x === xOf(widget, field) };
  }
  if (widget?.kind === "table" && field.kind === "column" && field.dataset === widget.dataset) {
    // no list: every column is shown
    return { control: "check", checked: !widget.columns?.length || widget.columns.includes(field.name) };
  }
  return null;
}

const isOn = (state: FieldState): boolean => (state?.control === "check" ? state.checked : state?.picked === true);

/**
 * The widget after a click on the field's checkbox or row: a measure is added or removed, the column becomes
 * the chart's x, a table column is shown or hidden. Null when nothing changes. `columns`: the names of the
 * table's dataset, in order (hiding one column of an unlisted table lists the rest).
 */
export function toggleField(widget: Widget, field: FieldRef, columns: readonly string[] = []): Widget | null {
  const state = fieldState(widget, field);
  if (!state) return null;
  if (widget.kind === "chart") {
    if (field.kind === "measure") return state.control === "check" && state.checked ? withoutMeasure(widget, field.name) : withMeasure(widget, field.name);
    return isOn(state) ? null : { ...widget, spec: { ...widget.spec, x: xOf(widget, field) } };
  }
  if (widget.kind !== "table") return null;
  const shown = widget.columns?.length ? widget.columns : columns;
  const next = isOn(state) ? shown.filter((c) => c !== field.name) : [...shown, field.name];
  // the last column stays, and one the list does not know cannot be hidden
  if (!next.length || (isOn(state) && next.length === shown.length)) return null;
  // a list of every column in order is the same as none
  const all = next.length === columns.length && next.every((c, i) => c === columns[i]);
  const { columns: _old, ...bare } = widget;
  return all ? bare : { ...bare, columns: next };
}

/** The widget after the field is dropped on it: as if it were checked, and never unchecked. */
export function dropField(widget: Widget, field: FieldRef, columns: readonly string[] = []): Widget | null {
  return isOn(fieldState(widget, field)) ? null : toggleField(widget, field, columns);
}
