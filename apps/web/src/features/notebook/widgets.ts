/** Pure helpers of the widget bar (see iara.widgets). */

import type { WidgetDefinition, WidgetValue } from "@iara/protocol";

/** How long typing in a text or number widget waits before the value is sent. */
export const WIDGET_DEBOUNCE_MS = 400;

/** The number a number widget's text holds, clamped to its bounds (null: not a number yet, e.g. empty or "-"). */
export function parseNumber(text: string, def: Pick<WidgetDefinition, "min" | "max">): number | null {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  const lo = def.min ?? -Infinity;
  const hi = def.max ?? Infinity;
  return Math.min(hi, Math.max(lo, n));
}

/** The value to send for what a widget's input holds (null: nothing to send yet). */
export function valueToSend(def: WidgetDefinition, input: string): WidgetValue | null {
  if (def.kind === "number") return parseNumber(input, def);
  return input;
}

/** The text a text, number or date input shows for a widget value. */
export function inputText(value: WidgetValue | undefined): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(", ");
  return String(value);
}

/** Widget values equal as the kernel would see them (lists compared by content). */
export function sameValue(a: WidgetValue | undefined, b: WidgetValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

/** A dropdown's option as a string (choices may be numbers). */
export function choiceKey(choice: string | number): string {
  return String(choice);
}

/** The choice a picked string stands for (keeps a number choice a number). */
export function pickChoice(def: Pick<WidgetDefinition, "choices">, picked: string): string | number {
  return def.choices?.find((c) => choiceKey(c) === picked) ?? picked;
}
