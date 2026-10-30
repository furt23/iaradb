/** Checking the line the formula bar holds, for a new measure and for one being edited (pure). */

import type { NumberFormat } from "@/lib/dashboards/types";
import { checkModel } from "@/lib/model/check";
import type { Model, Schema } from "@/lib/model/types";

import { appendLines, checkAdded } from "./measureLine";

export interface DraftCheck {
  /** the problems found in the line, positioned in it */
  diagnostics: { from: number; to: number; severity: "error" | "warning"; message: string }[];
  /** the measure the line defines */
  name: string | undefined;
  format: NumberFormat | undefined;
  /** it checks and defines a measure */
  ok: boolean;
}

export const NO_CHECK: DraftCheck = { diagnostics: [], name: undefined, format: undefined, ok: false };

/** The name a line `name = expression` gives. */
export function nameOf(text: string): string | undefined {
  return /^\s*([A-Za-z_]\w*)\s*=(?!=)/.exec(text)?.[1];
}

/** Checks `text` as a line added after the source. */
export function checkNew(source: string, text: string, schema: Schema): DraftCheck {
  const added = checkAdded(source, text, schema);
  if (!added.ok) return { ...NO_CHECK, diagnostics: added.diagnostics, name: added.measure };
  const measure = checkModel(appendLines(source, [text]), schema).model.measures.find((m) => m.name === added.measure);
  return { diagnostics: added.diagnostics, name: added.measure, format: measure?.format, ok: true };
}

/**
 * Checks `text` standing where a measure was: `next` is the source with the statement that began at `start`
 * replaced by it. Only the problems found in the text count, the rest of the source is not the edit's.
 */
export function checkReplaced(next: string, start: number, text: string, schema: Schema): DraftCheck {
  const end = start + text.length;
  const { model, diagnostics } = checkModel(next, schema);
  const found = diagnostics
    .filter((d) => d.from >= start && d.from <= end)
    .map(({ from, to, severity, message }) => ({ from: from - start, to: Math.min(to, end) - start, severity, message }));
  const measure = model.measures.find((m) => m.span.from === start);
  return { diagnostics: found, name: measure?.name, format: measure?.format, ok: !!measure && !found.some((d) => d.severity === "error") };
}

/** The names the model uses besides the measure `except`: another measure, calendar or param cannot be given its name. */
export function takenNames(model: Pick<Model, "measures" | "calendars" | "params">, except?: string): string[] {
  return [...model.measures, ...model.calendars, ...model.params].map((x) => x.name).filter((n) => n !== except);
}
