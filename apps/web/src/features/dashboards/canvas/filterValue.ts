/** What the filter controls show and hand over (pure). */

import type { CellValue, QueryParamType } from "@iara/protocol";

import type { FilterValue, FilterWidget } from "@/lib/dashboards/types";

/** An option as the text a viewer reads (and a multi filter holds). */
export function optionText(option: CellValue): string {
  return typeof option === "object" && option !== null ? JSON.stringify(option) : String(option);
}

/** The value of a select filter for the option the viewer picked: a number when the filter's values are numbers. */
export function pickedValue(filter: Pick<FilterWidget, "value_type">, text: string): string | number {
  const n = Number(text);
  return filter.value_type === "number" && text.trim() !== "" && Number.isFinite(n) ? n : text;
}

/** The text a filter's value shows in a field (null: nothing picked). */
export function shownText(value: FilterValue | undefined): string | null {
  return (typeof value === "string" || typeof value === "number") && value !== "" ? String(value) : null;
}

/** The value of what was typed, by the type of the input (undefined: empty, or not a number). */
export function textValue(type: QueryParamType | undefined, text: string): string | number | undefined {
  if (text === "") return undefined;
  if (type !== "number") return text;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/** A date range with one end changed (undefined: both ends are empty, so the filter narrows nothing). */
export function withRangeEnd(value: FilterValue | undefined, end: "from" | "to", date: string): FilterValue | undefined {
  const next: { from?: string; to?: string } = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  if (date) next[end] = date;
  else delete next[end];
  return next.from || next.to ? next : undefined;
}
