/** `layout.json`: where each widget sits on the 12-column grid (pure). */

import { ID } from "./config";
import type { LayoutItem } from "./types";

export const GRID_COLUMNS = 12;
export const MAX_ROWS = 40;

function whole(v: unknown, min: number, max: number): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
}

/** The layout of a value of any kind (the parsed file, or an action's input): checked, duplicate widgets dropped (the first stays). */
export function checkLayout(value: unknown): LayoutItem[] {
  if (!Array.isArray(value)) throw new Error("the layout is a list");
  const seen = new Set<string>();
  const items: LayoutItem[] = [];
  value.forEach((raw: Record<string, unknown> | null, i) => {
    const what = `layout item ${i + 1}`;
    if (!raw || typeof raw !== "object") throw new Error(`${what} is an object`);
    const { widget, x, y, w, h } = raw;
    if (typeof widget !== "string" || !ID.test(widget)) throw new Error(`${what}: widget is a widget id`);
    if (!whole(x, 0, GRID_COLUMNS - 1) || !whole(w, 1, GRID_COLUMNS) || x + w > GRID_COLUMNS) {
      throw new Error(`${what}: x and w are whole numbers inside the ${GRID_COLUMNS} columns`);
    }
    if (!whole(y, 0, Number.MAX_SAFE_INTEGER)) throw new Error(`${what}: y is a whole number from 0`);
    if (!whole(h, 1, MAX_ROWS)) throw new Error(`${what}: h is a whole number from 1 to ${MAX_ROWS}`);
    if (seen.has(widget)) return;
    seen.add(widget);
    items.push({ widget, x, y, w, h });
  });
  return items;
}

/** The layout of a `layout.json`. */
export function parseLayout(json: string): LayoutItem[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (e) {
    throw new Error(`not valid JSON: ${(e as Error).message}`);
  }
  return checkLayout(value);
}

export function layoutJson(items: LayoutItem[]): string {
  return `${JSON.stringify(
    items.map(({ widget, x, y, w, h }) => ({ widget, x, y, w, h })),
    null,
    2,
  )}\n`;
}

/** Where a new widget goes: below everything, at the left edge. */
export function placeNew(layout: LayoutItem[], widgetId: string, w = 6, h = 8): LayoutItem {
  return { widget: widgetId, x: 0, y: Math.max(0, ...layout.map((i) => i.y + i.h)), w, h };
}
