/** Widget files: `widgets/<id>.json` (chart, table, filter) and `widgets/<id>.md` (text) (pure). */

import type { ChartAgg, ChartSpec } from "@iara/protocol";

import { ID, randomId } from "./config";
import type { ChartSort, ChartWidget, FilterControl, FilterField, FilterWidget, TableWidget, TextWidget, ValueAgg, ValueField, Widget } from "./types";
import { checkChartStyle, checkColumnFormats, checkNumberFormat } from "./widgetStyle";

export const newWidgetId = randomId;

/** "counter" (one number) and "pie" are drawn by the dashboard; the kernel aggregates them like the rest. */
const CHART_KINDS: readonly string[] = ["bar", "line", "area", "scatter", "histogram", "counter", "pie"];
const CHART_AGGS: readonly string[] = ["sum", "avg", "count", "min", "max", "none"];
export const FILTER_CONTROLS: readonly FilterControl[] = ["select", "multi", "date_range", "text"];
const VALUE_TYPES: readonly string[] = ["text", "number", "date"];
const PLACEHOLDER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_MEASURES = 10;
const VALUE_AGGS: readonly string[] = ["sum", "avg", "count", "count_distinct", "min", "max"];
const CHART_SORTS: readonly string[] = ["x", "x_desc", "value", "value_asc"];
const MAX_VALUE_NAME = 120;
const MAX_TOP = 1000;

type Obj = Record<string, unknown>;

function object(v: unknown, what: string): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} is an object`);
  return v as Obj;
}

function text(v: unknown, what: string): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${what} is missing`);
  return v;
}

function optionalTitle(v: unknown): { title?: string } {
  if (v === undefined) return {};
  if (typeof v !== "string") throw new Error("title is text");
  return v.trim() ? { title: v } : {};
}

function strings(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${what} is a list of text`);
  return v as string[];
}

function chartSpec(v: unknown): ChartSpec {
  const s = object(v, "spec");
  if (typeof s.kind !== "string" || !CHART_KINDS.includes(s.kind)) throw new Error(`spec kind is one of ${CHART_KINDS.join(", ")}`);
  if (typeof s.x !== "string") throw new Error("spec x is text");
  if (typeof s.agg !== "string" || !CHART_AGGS.includes(s.agg)) throw new Error(`spec agg is one of ${CHART_AGGS.join(", ")}`);
  if (s.group !== undefined && s.group !== null && typeof s.group !== "string") throw new Error("spec group is text");
  if (s.bins !== undefined && (typeof s.bins !== "number" || !Number.isInteger(s.bins) || s.bins < 1)) throw new Error("spec bins is a whole number");
  return {
    kind: s.kind as ChartSpec["kind"],
    x: s.x,
    y: strings(s.y, "spec y"),
    agg: s.agg as ChartAgg,
    ...(s.group !== undefined && { group: s.group as string | null }),
    ...(s.bins !== undefined && { bins: s.bins as number }),
  };
}

/** The measures a chart draws: 1 to 10 different names of the model (whether the model has them is checked when it runs). */
function measureNames(v: unknown): string[] {
  const names = strings(v, "measures");
  if (!names.length || names.length > MAX_MEASURES) throw new Error(`measures is a list of 1 to ${MAX_MEASURES} names`);
  const bad = names.find((n) => !PLACEHOLDER.test(n));
  if (bad !== undefined) throw new Error(`${JSON.stringify(bad)} is not a measure name`);
  if (new Set(names).size !== names.length) throw new Error("measures has a name twice");
  return names;
}

/** The columns a chart aggregates: a name is a result column, so it stays out of the way of `:param` scanning. */
function valueFields(v: unknown, measures: readonly string[] = []): ValueField[] {
  if (!Array.isArray(v) || !v.length || v.length + measures.length > MAX_MEASURES) throw new Error(`values is a list of 1 to ${MAX_MEASURES} fields, with the measures`);
  const fields = v.map((item): ValueField => {
    const f = object(item, "a value");
    const name = text(f.name, "value name");
    if (name.length > MAX_VALUE_NAME || /[:\0]/.test(name)) throw new Error(`${JSON.stringify(name)} is not a value name`);
    if (typeof f.agg !== "string" || !VALUE_AGGS.includes(f.agg)) throw new Error(`value agg is one of ${VALUE_AGGS.join(", ")}`);
    if (f.column === undefined && f.agg !== "count") throw new Error("a value without a column counts rows");
    return { name, dataset: text(f.dataset, "value dataset"), ...(f.column !== undefined && { column: text(f.column, "value column") }), agg: f.agg as ValueAgg, ...(f.format !== undefined && { format: checkNumberFormat(f.format, name) }) };
  });
  const names = [...measures, ...fields.map((f) => f.name)];
  if (new Set(names).size !== names.length) throw new Error("values has a name twice");
  return fields;
}

function chartSort(v: unknown): ChartSort {
  if (typeof v !== "string" || !CHART_SORTS.includes(v)) throw new Error(`sort is one of ${CHART_SORTS.join(", ")}`);
  return v as ChartSort;
}

function chartTop(v: unknown): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > MAX_TOP) throw new Error(`top is a whole number from 1 to ${MAX_TOP}`);
  return v;
}

function field(v: unknown): FilterField {
  const f = object(v, "a field");
  return { dataset: text(f.dataset, "field dataset"), column: text(f.column, "field column") };
}

function filterFields(c: Obj): Pick<FilterWidget, "fields" | "value_type" | "param"> {
  const hasFields = c.fields !== undefined;
  if (hasFields === (c.param !== undefined)) throw new Error("a filter has either fields or a param");
  if (!hasFields) {
    if (typeof c.param !== "string" || !PLACEHOLDER.test(c.param)) throw new Error("param is the name of a :placeholder");
    return { param: c.param };
  }
  if (!Array.isArray(c.fields) || !c.fields.length) throw new Error("fields is a list of fields");
  if (typeof c.value_type !== "string" || !VALUE_TYPES.includes(c.value_type)) throw new Error(`value_type is one of ${VALUE_TYPES.join(", ")}`);
  return { fields: c.fields.map(field), value_type: c.value_type as FilterWidget["value_type"] };
}

/**
 * A widget from a value of any kind (the parsed file, or an action's input,
 * which is a trust boundary): checked, and rebuilt with the known keys only.
 */
export function checkWidget(id: string, value: unknown): Widget {
  if (!ID.test(id)) throw new Error(`invalid widget id ${id}`);
  const c = object(value, "a widget");
  switch (c.kind) {
    case "text":
      if (typeof c.markdown !== "string") throw new Error("markdown is text");
      return textWidget(id, c.markdown);
    case "chart": {
      const measures = c.measures !== undefined ? measureNames(c.measures) : undefined;
      return {
        id,
        kind: "chart",
        ...optionalTitle(c.title),
        dataset: text(c.dataset, "dataset"),
        spec: chartSpec(c.spec),
        ...(measures && { measures }),
        ...(c.values !== undefined && { values: valueFields(c.values, measures) }),
        ...(c.sort !== undefined && { sort: chartSort(c.sort) }),
        ...(c.top !== undefined && { top: chartTop(c.top) }),
        ...(c.style !== undefined && { style: checkChartStyle(c.style) }),
      };
    }
    case "table":
      return {
        id,
        kind: "table",
        ...optionalTitle(c.title),
        dataset: text(c.dataset, "dataset"),
        ...(c.columns !== undefined && { columns: strings(c.columns, "columns") }),
        ...(c.formats !== undefined && { formats: checkColumnFormats(c.formats) }),
      };
    case "filter":
      if (typeof c.control !== "string" || !FILTER_CONTROLS.includes(c.control as FilterControl)) {
        throw new Error(`control is one of ${FILTER_CONTROLS.join(", ")}`);
      }
      return { id, kind: "filter", ...optionalTitle(c.title), control: c.control as FilterControl, ...filterFields(c) };
    default:
      throw new Error("kind is one of chart, table, filter, text");
  }
}

/** A widget from its `.json` file (text widgets are `.md` files). */
export function parseWidget(id: string, json: string): Widget {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    throw new Error(`not valid JSON: ${(e as Error).message}`);
  }
  if (object(value, "a widget").kind === "text") throw new Error("a text widget is a .md file");
  return checkWidget(id, value);
}

/** The `.json` file of a widget: its fields without the id (the file name), in a stable order. */
export function widgetJson(w: ChartWidget | TableWidget | FilterWidget): string {
  const fields =
    w.kind === "chart"
      ? { kind: w.kind, title: w.title, dataset: w.dataset, spec: w.spec, measures: w.measures, values: w.values, sort: w.sort, top: w.top, style: w.style }
      : w.kind === "table"
        ? { kind: w.kind, title: w.title, dataset: w.dataset, columns: w.columns, formats: w.formats }
        : { kind: w.kind, title: w.title, control: w.control, fields: w.fields, value_type: w.value_type, param: w.param };
  return `${JSON.stringify(fields, null, 2)}\n`;
}

export function textWidget(id: string, markdown: string): TextWidget {
  return { id, kind: "text", markdown };
}
