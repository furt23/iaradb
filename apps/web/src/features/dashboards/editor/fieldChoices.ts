/** What a well's list offers, by dataset, for what was searched (pure). The search itself is the Fields pane's. */

import type { FieldRef } from "../canvas/fieldDrag";
import type { FieldTree } from "./fieldTree";

/** What a list of fields hands back: a column or a measure, or a dataset's row count. */
export type Picked = FieldRef | { kind: "rows"; dataset: string };

export interface Choice {
  key: string;
  label: string;
  /** a column's type; absent for a measure or the rows */
  type?: string;
  picked: Picked;
}

export interface ChoiceGroup {
  name: string;
  /** its columns are still being read */
  loading: boolean;
  choices: Choice[];
}

/**
 * The groups of `tree`. `values`: a value can also be a measure or a dataset's row count (`rows` names that).
 * A calendar's columns carry no type: they are for the axes, never a value by themselves.
 */
export function fieldChoices(tree: FieldTree, query: string, { values, rows }: { values: boolean; rows: string }): ChoiceGroup[] {
  const q = query.trim().toLowerCase();
  const groups = tree.nodes.map((node): ChoiceGroup => {
    const measures: Choice[] = values ? node.measures.map((m) => ({ key: `m:${m.name}`, label: m.name, picked: { kind: "measure", dataset: node.name, name: m.name } })) : [];
    const count: Choice[] = values && node.kind === "dataset" && (!q || node.name.toLowerCase().includes(q) || rows.toLowerCase().includes(q)) ? [{ key: `r:${node.name}`, label: rows, picked: { kind: "rows", dataset: node.name } }] : [];
    const columns: Choice[] = (Array.isArray(node.columns) ? node.columns : []).map((c) => ({
      key: `c:${node.name}.${c.name}`,
      label: c.name,
      type: c.type,
      picked: { kind: "column", dataset: node.name, name: c.name, ...(node.kind === "dataset" && { type: c.type }) },
    }));
    return { name: node.name, loading: node.columns === null, choices: [...measures, ...count, ...columns] };
  });
  const loose: Choice[] = values ? tree.loose.map((m) => ({ key: `m:${m.name}`, label: m.name, picked: { kind: "measure", dataset: "", name: m.name } })) : [];
  return [...groups.filter((g) => g.choices.length || g.loading), ...(loose.length ? [{ name: "", loading: false, choices: loose }] : [])];
}
