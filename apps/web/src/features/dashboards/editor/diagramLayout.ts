/** The geometry of the model's diagram: where tables start, where a relationship's line ends, and its curve (pure). */

import type { ModelLayout } from "@/lib/dashboards/modelLayout";
import type { Relationship } from "@/lib/model/types";

export const CARD_WIDTH = 230;
export const HEADER_HEIGHT = 38;
export const ROW_HEIGHT = 26;
/** how many columns a table shows before it scrolls */
export const MAX_VISIBLE_ROWS = 10;
const GAP_X = 110;
const GAP_Y = 36;
const MARGIN = 24;
/** how far a line leaves a table before it curves */
const BEND = 60;

export const bodyHeight = (rows: number) => Math.min(rows, MAX_VISIBLE_ROWS) * ROW_HEIGHT;
export const cardHeight = (rows: number) => HEADER_HEIGHT + bodyHeight(rows);

/**
 * Where tables start: each one column to the right of those that point at it, so facts sit on the left and what they
 * point at on the right, with tables nothing connects in the first column. `rows`: each table's number of columns.
 */
export function autoLayout(tables: readonly string[], rels: readonly Pick<Relationship, "many" | "one">[], rows: (name: string) => number): ModelLayout {
  const depth = new Map(tables.map((t) => [t, 0]));
  // one pass per table is enough for the longest chain; a cycle stops growing there too
  for (let pass = 0; pass < tables.length; pass++) {
    for (const { many, one } of rels) {
      const next = (depth.get(many.dataset) ?? 0) + 1;
      if (depth.has(one.dataset) && next > depth.get(one.dataset)! && next < tables.length) depth.set(one.dataset, next);
    }
  }
  const nextY = new Map<number, number>();
  return Object.fromEntries(
    tables.map((t) => {
      const column = depth.get(t) ?? 0;
      const y = nextY.get(column) ?? MARGIN;
      nextY.set(column, y + cardHeight(rows(t)) + GAP_Y);
      return [t, { x: MARGIN + column * (CARD_WIDTH + GAP_X), y }];
    }),
  );
}

/** The layout with a place for every table: the saved one, and the new tables after them, in the automatic place's column. */
export function withPlaces(saved: ModelLayout, tables: readonly string[], rels: readonly Pick<Relationship, "many" | "one">[], rows: (name: string) => number): ModelLayout {
  const auto = autoLayout(tables, rels, rows);
  const bottom = Math.max(0, ...tables.flatMap((t) => (saved[t] ? [saved[t].y + cardHeight(rows(t)) + GAP_Y] : [])));
  return Object.fromEntries(tables.map((t) => [t, saved[t] ?? (bottom ? { x: auto[t].x, y: Math.max(auto[t].y, bottom) } : auto[t])]));
}

/** How far down a column's row sits on the canvas, held inside its table when it is scrolled out of sight. */
export function columnY(top: number, rows: number, index: number, scrollTop = 0): number {
  const body = bodyHeight(rows);
  const y = (index + 0.5) * ROW_HEIGHT - scrollTop;
  return top + HEADER_HEIGHT + Math.max(0, Math.min(body, y));
}

export interface Point {
  x: number;
  y: number;
}

/** What a column's row says about itself on the page (its `data-*` attributes). */
export interface RowMark {
  table?: string;
  column?: string;
  calendar?: string;
}

/** The column a drag from `from` can be dropped on, from the row under the pointer: another table's, and not a calendar's. Null: not here. */
export function dropTarget(from: { dataset: string }, row: RowMark | undefined): { dataset: string; column: string } | null {
  if (!row?.table || !row.column || row.calendar || row.table === from.dataset) return null;
  return { dataset: row.table, column: row.column };
}

/** Which sides of two tables a line joins: facing sides, or the right of both when they overlap across. */
export function linkEnds(aX: number, bX: number): { a: "left" | "right"; b: "left" | "right" } {
  if (aX + CARD_WIDTH <= bX) return { a: "right", b: "left" };
  if (bX + CARD_WIDTH <= aX) return { a: "left", b: "right" };
  return { a: "right", b: "right" };
}

/** The SVG path of a line that leaves `a` and reaches `b` straight out of their sides. */
export function linkPath(a: Point, aSide: "left" | "right", b: Point, bSide: "left" | "right"): string {
  const out = (side: "left" | "right") => (side === "right" ? BEND : -BEND);
  return `M ${a.x} ${a.y} C ${a.x + out(aSide)} ${a.y}, ${b.x + out(bSide)} ${b.y}, ${b.x} ${b.y}`;
}
