/** What a new widget starts as, and where it goes on the canvas (pure). */

import type { ColumnInfo } from "@iara/protocol";

import { defaultSpec, isTemporalType } from "@/features/results/chart/chartSpec";
import { placeNew } from "@/lib/dashboards/layout";
import type { FilterControl, FilterWidget, LayoutItem, Widget } from "@/lib/dashboards/types";
import { textWidget } from "@/lib/dashboards/widgets";
import { isNumericType } from "@/lib/format";

/** what the Add menu offers; a counter is a chart widget of kind "counter" */
export type NewKind = "chart" | "counter" | "table" | "text" | "filter";

type ValueType = NonNullable<FilterWidget["value_type"]>;

/** How a filter types the values of a column. */
export function valueTypeOf(columnType: string): ValueType {
  return isNumericType(columnType) ? "number" : isTemporalType(columnType) ? "date" : "text";
}

/** The value type of a field filter: a date range and a text search force theirs. */
export function filterValueType(control: FilterControl, columnType: string): ValueType {
  return control === "date_range" ? "date" : control === "text" ? "text" : valueTypeOf(columnType);
}

/** The fields of a filter over the first text column of a dataset (the first column when there is none); null when it has none. */
export function filterOver(dataset: string, columns: ColumnInfo[]): Pick<FilterWidget, "fields" | "value_type"> | null {
  const column = columns.find((c) => valueTypeOf(c.type) === "text") ?? columns[0];
  return column ? { fields: [{ dataset, column: column.name }], value_type: valueTypeOf(column.type) } : null;
}

/** A new widget over `dataset` (null: a filter, and the dataset has no column to narrow). */
export function newWidget(kind: NewKind, id: string, dataset: string, columns: ColumnInfo[]): Widget | null {
  switch (kind) {
    case "text":
      return textWidget(id, "## Title\n\nWrite here.");
    case "table":
      return { id, kind: "table", dataset };
    case "counter":
      return { id, kind: "chart", dataset, spec: { kind: "counter", x: "", y: [], agg: "count", group: null } };
    case "chart":
      return { id, kind: "chart", dataset, spec: defaultSpec(columns) ?? { kind: "bar", x: "", y: [], agg: "count", group: null } };
    case "filter": {
      const over = filterOver(dataset, columns);
      return over && { id, kind: "filter", control: "select", ...over };
    }
  }
}

/** Below everything, in the size that suits the widget. */
export function newLayoutItem(layout: LayoutItem[], widget: Widget): LayoutItem {
  const counter = widget.kind === "chart" && widget.spec.kind === "counter";
  const [w, h] = counter ? [3, 4] : widget.kind === "filter" ? [3, 3] : widget.kind === "text" ? [6, 4] : [6, 8];
  return placeNew(layout, widget.id, w, h);
}

/** Whether two layouts place the same widgets in the same boxes. */
export function sameLayout(a: LayoutItem[], b: LayoutItem[]): boolean {
  return a.length === b.length && a.every((x, i) => x.widget === b[i].widget && x.x === b[i].x && x.y === b[i].y && x.w === b[i].w && x.h === b[i].h);
}

/** What a widget is called when it has no title (an English key for `t`). */
export function widgetLabel(widget: Widget): string {
  if (widget.kind === "chart") return widget.spec.kind === "counter" ? "Counter" : "Chart";
  return widget.kind === "table" ? "Table" : widget.kind === "text" ? "Text" : "Filter";
}
