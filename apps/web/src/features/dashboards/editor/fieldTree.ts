/** The tree of the Fields pane: datasets and calendars with their columns and measures, and the parameters (pure). */

import type { ColumnInfo } from "@iara/protocol";

import { isTemporalType } from "@/features/results/chart/chartSpec";
import type { Dataset } from "@/lib/dashboards/types";
import { isNumericType } from "@/lib/format";
import type { Measure, Model, Param } from "@/lib/model/types";

import { CALENDAR_COLUMN_INFO, isCalendar } from "./calendarColumns";
import type { FoundColumns } from "./useDatasetColumns";

export interface FieldNode {
  kind: "dataset" | "calendar";
  name: string;
  /** null: not read yet; a string: why it could not be */
  columns: ColumnInfo[] | string | null;
  /** the measures whose first dataset this is */
  measures: Measure[];
  /** a search match is inside: shown open */
  open: boolean;
}

export interface FieldTree {
  nodes: FieldNode[];
  /** measures that read no dataset the dashboard has */
  loose: Measure[];
  params: Param[];
}

/** A short mark for a column's type: `123`, `Aa`, a date, a switch. */
export function typeGlyph(type: string): string {
  if (isNumericType(type)) return "123";
  if (isTemporalType(type)) return "31";
  return /^bool/i.test(type) ? "T/F" : "Aa";
}

/**
 * What the pane lists. `query`: part of a name, any case; a dataset whose name matches keeps everything in it,
 * else only what matches, open. The columns of a dataset not read yet cannot match.
 */
export function buildFieldTree({
  datasets,
  model,
  found,
  query,
}: {
  datasets: readonly Dataset[];
  model: Pick<Model, "measures" | "calendars" | "params">;
  found: FoundColumns;
  query: string;
}): FieldTree {
  const q = query.trim().toLowerCase();
  const match = (name: string) => name.toLowerCase().includes(q);
  const names = [...datasets.map((d) => d.name), ...model.calendars.map((c) => c.name)];
  const home = (m: Measure) => m.datasets[0];

  const nodes: FieldNode[] = [];
  for (const name of names) {
    const kind = isCalendar(model.calendars, name) ? "calendar" : "dataset";
    const read = kind === "calendar" ? CALENDAR_COLUMN_INFO : found[name];
    const columns = read === undefined ? null : read;
    const own = model.measures.filter((m) => home(m) === name);
    if (!q) {
      nodes.push({ kind, name, columns, measures: own, open: false });
      continue;
    }
    const columnHits = Array.isArray(columns) ? columns.filter((c) => match(c.name)) : [];
    const measureHits = own.filter((m) => match(m.name));
    if (!match(name) && !columnHits.length && !measureHits.length) continue;
    const all = match(name);
    nodes.push({
      kind,
      name,
      columns: Array.isArray(columns) && !all ? columnHits : columns,
      measures: all ? own : measureHits,
      open: columnHits.length + measureHits.length > 0,
    });
  }
  const loose = model.measures.filter((m) => !names.includes(home(m)) && match(m.name));
  return { nodes, loose, params: model.params.filter((p) => match(p.name)) };
}
