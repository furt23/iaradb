/** What checking, clicking or dropping a field does to a widget: on the widget itself, or on one of a chart's wells (pure). */

import { asValues, usesRows, valueName } from "@/lib/dashboards/chartFields";
import type { ChartWidget, ValueAgg, ValueField, Widget } from "@/lib/dashboards/types";
import { isNumericType } from "@/lib/format";

import type { FieldRef } from "../canvas/fieldDrag";
import { maxValues } from "./chartLooks";
import { restyled, withMeasure, withoutMeasure } from "./measureWidgets";

/** How a value's name is written (`t` in the editor). */
export type Word = Parameters<typeof valueName>[2];

/** How a field shows for a widget: a checkbox (it is on the chart or the table, or can go there), or nothing when the widget does not take the field. */
export type FieldState = { checked: boolean } | null;

/** The column as a chart or table names it: bare in its own dataset, `dataset.column` in another. */
const nameIn = (dataset: string, field: FieldRef): string => (field.dataset === dataset ? field.name : `${field.dataset}.${field.name}`);

const isValueOf = (v: ValueField, field: FieldRef) => v.dataset === field.dataset && v.column === field.name;

/** A name not taken on the chart: the column's dataset tells two of the same name apart. */
function freeName(chart: ChartWidget, name: string, dataset: string): string {
  const taken = new Set([...(chart.measures ?? []), ...(chart.values ?? []).map((v) => v.name)]);
  if (!taken.has(name)) return name;
  const own = `${name} (${dataset})`;
  let free = own;
  for (let n = 2; taken.has(free); n++) free = `${own} ${n}`;
  return free;
}

/** The chart with the column as a value, in the aggregation its type suggests: a sum of numbers, a count of the rest. */
export function addValue(chart: ChartWidget, field: Pick<FieldRef, "dataset" | "name" | "type">, word?: Word): ChartWidget {
  const c = asValues(chart, word);
  const agg: ValueAgg = field.type && isNumericType(field.type) ? "sum" : "count";
  const value: ValueField = { name: freeName(c, valueName(agg, field.name, word), field.dataset), dataset: field.dataset, column: field.name, agg };
  return appended(c, value);
}

/** The chart counting a dataset's rows. */
export function addRowCount(chart: ChartWidget, dataset: string, word?: Word): ChartWidget {
  const c = asValues(chart, word);
  return appended(c, { name: freeName(c, valueName("count", undefined, word), dataset), dataset, agg: "count" });
}

/** The value after the others, or in place of the chart's only value when it draws one (a card). */
function appended(c: ChartWidget, value: ValueField): ChartWidget {
  if (maxValues(c.spec.kind, c.style?.look) === 1) {
    const { measures: _m, ...bare } = c;
    return { ...bare, values: [value] };
  }
  return { ...c, values: [...(c.values ?? []), value] };
}

/** The chart without the value (no `values` key when it was the last). */
export function removeValue(chart: ChartWidget, name: string): ChartWidget {
  const { values, ...bare } = restyled(chart, name);
  const rest = (values ?? []).filter((v) => v.name !== name);
  return rest.length ? { ...bare, values: rest } : bare;
}

export function setX(chart: ChartWidget, x: string, word?: Word): ChartWidget {
  const c = asValues(chart, word);
  return { ...c, spec: { ...c.spec, x, ...(c.spec.group === x && { group: null }) } };
}

export function setGroup(chart: ChartWidget, group: string | null, word?: Word): ChartWidget {
  const c = asValues(chart, word);
  return { ...c, spec: { ...c.spec, group } };
}

/** The x a column names on the chart. */
export const fieldName = (chart: ChartWidget, field: FieldRef): string => nameIn(chart.dataset, field);

export function fieldState(widget: Widget | undefined, field: FieldRef): FieldState {
  if (widget?.kind === "chart") {
    if (usesRows(widget)) {
      return field.kind === "column" && field.dataset === widget.dataset ? { checked: widget.spec.x === field.name } : null;
    }
    const c = asValues(widget);
    if (field.kind === "measure") return { checked: !!c.measures?.includes(field.name) };
    const name = fieldName(c, field);
    return { checked: c.spec.x === name || c.spec.group === name || !!c.values?.some((v) => isValueOf(v, field)) };
  }
  if (widget?.kind === "table" && field.kind === "column") {
    const name = nameIn(widget.dataset, field);
    // no list: every column of its dataset is shown
    return { checked: widget.columns?.length ? widget.columns.includes(name) : field.dataset === widget.dataset };
  }
  return null;
}

const isOn = (state: FieldState): boolean => state?.checked === true;

/** The chart with the column on it, where its type puts it: a number is a value; the rest is the x, then the legend, then a new x; a card counts it. */
function placeColumn(chart: ChartWidget, field: FieldRef, word?: Word): ChartWidget {
  const c = asValues(chart, word);
  if (c.spec.kind === "counter" || (field.type && isNumericType(field.type))) return addValue(c, field, word);
  const name = fieldName(c, field);
  if (!c.spec.x) return setX(c, name, word);
  return !c.spec.group && c.spec.kind !== "pie" ? setGroup(c, name, word) : setX(c, name, word);
}

/** The chart with the column off, wherever it is. */
function takeColumn(chart: ChartWidget, field: FieldRef, word?: Word): ChartWidget {
  const c = asValues(chart, word);
  const name = fieldName(c, field);
  if (c.spec.x === name) return setX(c, "", word);
  if (c.spec.group === name) return setGroup(c, null, word);
  return (c.values ?? []).filter((v) => isValueOf(v, field)).reduce((out, v) => removeValue(out, v.name), c);
}

/**
 * The widget after a click on the field's checkbox: a measure or a column goes on the chart or comes off,
 * a table column is shown or hidden. Null when nothing changes. `columns`: the names of the table's dataset, in
 * order (hiding one column of an unlisted table lists the rest).
 */
export function toggleField(widget: Widget, field: FieldRef, columns: readonly string[] = [], word?: Word): Widget | null {
  const state = fieldState(widget, field);
  if (!state) return null;
  if (widget.kind === "chart") {
    if (usesRows(widget)) return isOn(state) ? null : { ...widget, spec: { ...widget.spec, x: field.name } };
    if (field.kind === "measure") return isOn(state) ? withoutMeasure(widget, field.name) : withMeasure(widget, field.name, word);
    return isOn(state) ? takeColumn(widget, field, word) : placeColumn(widget, field, word);
  }
  if (widget.kind !== "table") return null;
  const name = nameIn(widget.dataset, field);
  const shown = widget.columns?.length ? widget.columns : columns;
  const next = isOn(state) ? shown.filter((c) => c !== name) : [...shown, name];
  // the last column stays, and one the list does not know cannot be hidden
  if (!next.length || (isOn(state) && next.length === shown.length)) return null;
  // a list of every column in order is the same as none
  const all = next.length === columns.length && next.every((c, i) => c === columns[i]);
  const { columns: _old, ...bare } = widget;
  return all ? bare : { ...bare, columns: next };
}

/** The widget after the field is dropped on it: as if it were checked, and never unchecked. */
export function dropField(widget: Widget, field: FieldRef, columns: readonly string[] = [], word?: Word): Widget | null {
  return isOn(fieldState(widget, field)) ? null : toggleField(widget, field, columns, word);
}
