/** Conditional formatting of table cells: a column's rules and color scale, as tints (pure). */

import type { CellValue } from "@iara/protocol";

import type { ColorRule, ColumnFormat, Tone } from "./types";

export interface Tint {
  tone: Tone;
  /** 0 < strength <= 1 */
  strength: number;
}

/** CSS colors of the tones; they are mixed into transparency, so one color serves both schemes */
export const TONE_COLORS: Record<Tone, string> = {
  green: "#0ca30c",
  amber: "#fab219",
  orange: "#ec835a",
  red: "#d03b3b",
  blue: "#2a78d6",
};

/** A finite number, or a numeric string (as `num()` in chartSpec reads one). */
function numeric(v: CellValue | undefined): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** The lowest and highest numeric value of column `index` in `rows` (null: none). */
export function columnRange(rows: CellValue[][], index: number): { min: number; max: number } | null {
  let range: { min: number; max: number } | null = null;
  for (const row of rows) {
    const n = numeric(row[index]);
    if (n !== null) range = range ? { min: Math.min(range.min, n), max: Math.max(range.max, n) } : { min: n, max: n };
  }
  return range;
}

/** Whether a rule holds for a cell: numbers compare as numbers, text by its characters. */
function matches(rule: ColorRule, value: CellValue): boolean {
  const v = numeric(value);
  const r = numeric(rule.value);
  if (rule.op === "=" || rule.op === "!=") {
    const equal = v !== null && r !== null ? v === r : String(value) === String(rule.value);
    return rule.op === "=" ? equal : !equal;
  }
  if (v === null || r === null) return false;
  switch (rule.op) {
    case ">":
      return v > r;
    case ">=":
      return v >= r;
    case "<":
      return v < r;
    case "<=":
      return v <= r;
  }
}

/** How a cell is tinted, or null: the first rule it matches (full strength), else its place on the column's scale. */
export function cellTint(format: ColumnFormat | undefined, value: CellValue, range: { min: number; max: number } | null): Tint | null {
  if (!format || value === null) return null;
  const rule = format.rules?.find((r) => matches(r, value));
  if (rule) return { tone: rule.tone, strength: 1 };
  const n = numeric(value);
  if (!format.scale || n === null || !range) return null;
  // clamped: a value outside the range given keeps the strength in (0, 1]
  const t = range.max === range.min ? 1 : Math.min(1, Math.max(0, (n - range.min) / (range.max - range.min)));
  const { high, low } = format.scale;
  if (!low) return t === 0 ? null : { tone: high, strength: t };
  if (t === 0.5) return null;
  return t < 0.5 ? { tone: low, strength: (0.5 - t) * 2 } : { tone: high, strength: (t - 0.5) * 2 };
}

/** The background of a tinted cell: the tone mixed into transparency, at most 40%. */
export function tintBackground(t: Tint): string {
  return `color-mix(in srgb, ${TONE_COLORS[t.tone]} ${Math.round(t.strength * 40)}%, transparent)`;
}
