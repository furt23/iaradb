/** Datasets as the editor creates and reads them (pure). */

import type { ParamSpec } from "@/features/queries/queryHeader";
import { detectParams, mergeSpecs } from "@/features/queries/queryParams";
import type { Dataset } from "@/lib/dashboards/types";

/**
 * The tables of a catalog schema, each once: the schema also lists the default
 * catalog's tables under their full `catalog.schema.table` name, dropped here
 * when the short name (`schema.table`, or `table` in `main`) is listed too.
 */
export function tableNames(schema: Record<string, unknown>): string[] {
  return Object.keys(schema).filter((name) => {
    const parts = name.split(".");
    if (parts.length !== 3) return true;
    const [, s, t] = parts;
    return !(`${s}.${t}` in schema || (s === "main" && t in schema));
  });
}

/** A dataset name for a table: its last part in the characters a name allows, not taken yet. */
export function datasetNameFor(table: string, taken: string[]): string {
  const base =
    (table.split(".").pop() ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 56) || "dataset";
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}_${n}`;
  return name;
}

/** The file of a dataset that is a whole table. */
export function tableQuery(table: string): string {
  return `SELECT * FROM ${table}\n`;
}

/** The `:names` the datasets declare, in order of first appearance. */
export function paramNames(datasets: Dataset[]): string[] {
  return [...new Set(datasets.flatMap((d) => detectParams(d.sql)))];
}

/** How the first dataset that declares `:name` asks for it. */
export function paramSpecOf(datasets: Dataset[], name: string): ParamSpec | undefined {
  for (const d of datasets) {
    const names = detectParams(d.sql);
    if (names.includes(name)) return mergeSpecs(names, d.params)[name];
  }
  return undefined;
}

/** The names of a select's options, with the current value kept when it is not among them (a column or dataset that went away). */
export function withCurrent(names: string[], current: string | undefined): string[] {
  return current && !names.includes(current) ? [current, ...names] : names;
}
