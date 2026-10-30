/** A field dragged from the Fields pane onto a widget of the canvas (pure). */

/** the dataTransfer type of a dragged field */
export const FIELD_MIME = "application/x-iara-field";

/** A measure or a column. `dataset`: the measure's first dataset ("" when it reads none), or the column's own. */
export interface FieldRef {
  kind: "measure" | "column";
  dataset: string;
  name: string;
}

export const encodeField = (field: FieldRef): string => JSON.stringify(field);

/** The field a drag carries; null for anything else. */
export function parseField(raw: string): FieldRef | null {
  try {
    const v = JSON.parse(raw) as Partial<FieldRef> | null;
    if (!v || (v.kind !== "measure" && v.kind !== "column") || typeof v.dataset !== "string" || typeof v.name !== "string" || !v.name) return null;
    return { kind: v.kind, dataset: v.dataset, name: v.name };
  } catch {
    return null;
  }
}

/** Whether a drag over a widget carries a field (its data is only readable once dropped, its types are not). */
export const carriesField = (types: readonly string[]): boolean => Array.from(types).includes(FIELD_MIME);
