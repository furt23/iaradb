/** Relationships as the canvas makes them: what to suggest, which way they point, and what a chart still lacks (pure). */

import type { ColumnInfo } from "@iara/protocol";

import { asValues, usesRows } from "@/lib/dashboards/chartFields";
import { groupField } from "@/lib/dashboards/narrow";
import type { Widget } from "@/lib/dashboards/types";
import { checkModel } from "@/lib/model/check";
import { pathToOne } from "@/lib/model/graph";
import type { ColumnRef, Model, Relationship, Schema } from "@/lib/model/types";
import { isNumericType } from "@/lib/format";

import { appendLines } from "./measureLine";

/** two columns that look like the same key; which side is the "one" is told by their data, once picked */
export interface Suggestion {
  a: ColumnRef;
  b: ColumnRef;
}

const MAX_SUGGESTIONS = 12;
const KEY = /(^|_)(id|key|code|sk)$|(id|key)$/;

/** A column's name without a table's short prefix: `o_custkey` and `c_custkey` are both `custkey`. */
const stem = (name: string) => name.toLowerCase().replace(/^[a-z]{1,3}_/, "");

/** `customers`, `customer` → `customer`, as a foreign key spells it. */
const singular = (dataset: string) => dataset.toLowerCase().replace(/s$/, "");

/** Whether `column` of `dataset` is the plain `id` that `other` (say, `customer_id`) points at. */
const pointsAt = (dataset: string, column: string, other: string) => column.toLowerCase() === "id" && stem(other) === `${singular(dataset)}_id`;

const sameKind = (a: ColumnInfo, b: ColumnInfo) => isNumericType(a.type) === isNumericType(b.type);

function matches(aSet: string, a: ColumnInfo, bSet: string, b: ColumnInfo): boolean {
  if (!sameKind(a, b)) return false;
  const same = stem(a.name) === stem(b.name) && KEY.test(stem(a.name));
  return same || pointsAt(aSet, a.name, b.name) || pointsAt(bSet, b.name, a.name);
}

/**
 * Pairs of columns of two datasets that look like the same key, leaving out datasets already connected.
 * `focus`: only pairs that touch these datasets, or join them when there are two.
 */
export function suggestRelationships(columns: Record<string, ColumnInfo[]>, rels: readonly Relationship[], focus: readonly string[] = []): Suggestion[] {
  const names = Object.keys(columns);
  const out: Suggestion[] = [];
  names.forEach((aSet, i) => {
    for (const bSet of names.slice(i + 1)) {
      if (pathToOne(rels, aSet, bSet) || pathToOne(rels, bSet, aSet)) continue;
      if (focus.length >= 2 ? !(focus.includes(aSet) && focus.includes(bSet)) : focus.length === 1 && !focus.includes(aSet) && !focus.includes(bSet)) continue;
      for (const a of columns[aSet]) {
        for (const b of columns[bSet]) {
          if (matches(aSet, a, bSet, b)) out.push({ a: { dataset: aSet, column: a.name }, b: { dataset: bSet, column: b.name } });
        }
      }
    }
  });
  return out.slice(0, MAX_SUGGESTIONS);
}

/** Which way two columns point, by which of them is unique: the unique one is the "one" side. Null: neither is. */
export function orient(a: ColumnRef, b: ColumnRef, unique: readonly [boolean, boolean]): { many: ColumnRef; one: ColumnRef } | null {
  if (unique[1]) return { many: a, one: b };
  return unique[0] ? { many: b, one: a } : null;
}

export const relateLine = (many: ColumnRef, one: ColumnRef) => `relate(${many.dataset}.${many.column}, ${one.dataset}.${one.column})`;

/** Why the line cannot join the model (a cycle, a second path, a column it lacks), or null. */
export function relateProblem(source: string, line: string, schema: Schema): string | null {
  const before = source === "" || source.endsWith("\n") ? source : `${source}\n`;
  const found = checkModel(appendLines(source, [line]), schema).diagnostics;
  return found.find((d) => d.severity === "error" && d.from >= before.length)?.message ?? null;
}

/**
 * Two datasets the widget uses that nothing connects, or null: what the author must relate before it can draw.
 * Connected the other way round is left to the widget's own message: no new relationship would help.
 */
export function missingLink(model: Model, widget: Widget, datasets: readonly string[]): [string, string] | null {
  const rels = model.relationships;
  const known = [...datasets, ...model.calendars.map((c) => c.name)];
  const apart = (a: string, b: string) => !pathToOne(rels, a, b) && !pathToOne(rels, b, a);
  if (widget.kind === "table") {
    const other = widget.columns?.map((c) => groupField(widget.dataset, c, known).dataset).find((d) => d !== widget.dataset && apart(widget.dataset, d));
    return other ? [widget.dataset, other] : null;
  }
  if (widget.kind !== "chart" || usesRows(widget)) return null;
  const c = asValues(widget);
  const read = [...(c.values ?? []).map((v) => v.dataset), ...model.measures.filter((m) => c.measures?.includes(m.name)).flatMap((m) => m.datasets)];
  if (!read.length) return null;
  for (const text of [c.spec.x, c.spec.group]) {
    if (!text) continue;
    const { dataset } = groupField(c.dataset, text, known);
    if (read.every((d) => apart(d, dataset))) return [read[0], dataset];
  }
  return null;
}
