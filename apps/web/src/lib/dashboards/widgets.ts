/** Widget files: `widgets/<id>.json` (chart, table, filter) and `widgets/<id>.md` (text) (pure). */

import type { ChartAgg, ChartSpec } from "@iara/protocol";

import { ID, randomId } from "./config";
import type { ChartWidget, FilterControl, FilterField, FilterWidget, TableWidget, TextWidget, Widget } from "./types";
import { checkChartStyle, checkColumnFormats } from "./widgetStyle";

export const newWidgetId = randomId;

/** "counter" (one number) and "pie" are drawn by the dashboard; the kernel aggregates them like the rest. */
const CHART_KINDS: readonly string[] = ["bar", "line", "area", "scatter", "histogram", "counter", "pie"];
const CHART_AGGS: readonly string[] = ["sum", "avg", "count", "min", "max", "none"];
export const FILTER_CONTROLS: readonly FilterControl[] = ["select", "multi", "date_range", "text"];
const VALUE_TYPES: readonly string[] = ["text", "number", "date"];
const PLACEHOLDER = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
    case "chart":
      return {
        id,
        kind: "chart",
        ...optionalTitle(c.title),
        dataset: text(c.dataset, "dataset"),
        spec: chartSpec(c.spec),
        ...(c.style !== undefined && { style: checkChartStyle(c.style) }),
      };
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
      ? { kind: w.kind, title: w.title, dataset: w.dataset, spec: w.spec, style: w.style }
      : w.kind === "table"
        ? { kind: w.kind, title: w.title, dataset: w.dataset, columns: w.columns, formats: w.formats }
        : { kind: w.kind, title: w.title, control: w.control, fields: w.fields, value_type: w.value_type, param: w.param };
  return `${JSON.stringify(fields, null, 2)}\n`;
}

export function textWidget(id: string, markdown: string): TextWidget {
  return { id, kind: "text", markdown };
}
