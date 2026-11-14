/**
 * Extracts of a dashboard (pure): a dataset's result stored as a Parquet file
 * that renders read instead of running the query. The manifest lists the
 * current file of each dataset; a file is never rewritten, so swapping a
 * version is writing the manifest. Where the files live is in
 * server/dashboards/extractStore.ts.
 */

import type { ColumnInfo } from "@iara/protocol";

import { detectParams } from "@/features/queries/queryParams";

import { DATASET_NAME } from "./query";
import type { Dataset } from "./types";

/** `20261028T231500Z-a1b2`: the file name of a version, so it is safe in a path or URL */
export const VERSION = /^\d{8}T\d{6}Z-[a-z0-9]+$/;

/** one dataset's stored result, as the manifest lists it */
export interface ExtractEntry {
  version: string;
  /** the version before it, kept for renders that started before the swap */
  previous?: string;
  rows: number;
  bytes: number;
  columns: ColumnInfo[];
  /** the catalog tables it was read from, `catalog.schema.table`, lowercase */
  sources: string[];
  /** the Delta version read of each base table, by name; absent when one of them has none */
  versions?: Record<string, number>;
  /** datasetHash of the dataset definition it was built from */
  hash: string;
  /** unix milliseconds */
  refreshed_at: number;
}

/** `_iara/extracts/<dashboard-id>/manifest.json` */
export interface ExtractManifest {
  datasets: Record<string, ExtractEntry>;
}

export function emptyManifest(): ExtractManifest {
  return { datasets: {} };
}

type Obj = Record<string, unknown>;

function object(v: unknown, what: string): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} is an object`);
  return v as Obj;
}

function count(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error(`${what} is a number, 0 or more`);
  return v;
}

function whole(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`${what} is a whole number, 0 or more`);
  return v;
}

function text(v: unknown, what: string): string {
  if (typeof v !== "string") throw new Error(`${what} is text`);
  return v;
}

function version(v: unknown, what: string): string {
  if (typeof v !== "string" || !VERSION.test(v)) throw new Error(`${what} is not a version`);
  return v;
}

function list(v: unknown, what: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${what} is a list`);
  return v;
}

function versionsOf(v: unknown, what: string): Record<string, number> {
  // fromEntries: a table called `__proto__` stays a key
  return Object.fromEntries(Object.entries(object(v, what)).map(([table, n]) => [table, whole(n, `${what}: ${table}`)]));
}

function entryOf(v: unknown, name: string): ExtractEntry {
  const at = `dataset ${name}`;
  const e = object(v, at);
  const columns = list(e.columns, `${at}: columns`).map((c, i): ColumnInfo => {
    const col = object(c, `${at}: column ${i + 1}`);
    return { name: text(col.name, `${at}: column ${i + 1} name`), type: text(col.type, `${at}: column ${i + 1} type`) };
  });
  return {
    version: version(e.version, `${at}: version`),
    ...(e.previous === undefined ? {} : { previous: version(e.previous, `${at}: previous`) }),
    rows: count(e.rows, `${at}: rows`),
    bytes: count(e.bytes, `${at}: bytes`),
    columns,
    sources: list(e.sources, `${at}: sources`).map((s, i) => text(s, `${at}: source ${i + 1}`)),
    ...(e.versions === undefined ? {} : { versions: versionsOf(e.versions, `${at}: versions`) }),
    hash: text(e.hash, `${at}: hash`),
    refreshed_at: count(e.refreshed_at, `${at}: refreshed_at`),
  };
}

/** A manifest from a parsed file (a trust boundary): checked, rebuilt with the known keys only. Names and versions end up in paths, so they are checked too. */
export function checkManifest(v: unknown): ExtractManifest {
  const datasets = object(object(v, "a manifest").datasets, "datasets");
  return {
    // fromEntries: a dataset called `__proto__` stays a key, not a prototype
    datasets: Object.fromEntries(
      Object.entries(datasets).map(([name, e]) => {
        if (!DATASET_NAME.test(name)) throw new Error(`${name} is not a dataset name`);
        return [name, entryOf(e, name)];
      }),
    ),
  };
}

/** `20261028T231500Z-a1b2`: the UTC time, then `random` ([a-z0-9]+) so two refreshes in one second differ. */
export function newVersion(now: number, random: string): string {
  if (!/^[a-z0-9]+$/.test(random)) throw new Error("the random part of a version is [a-z0-9]+");
  return `${new Date(now).toISOString().replace(/\.\d+Z$/, "Z").replace(/[-:]/g, "")}-${random}`;
}

/** Whether a dataset is served from an extract: not "live" and no params of its own (a param changes the query, and an extract holds one result). */
export function wantsExtract(d: Dataset): boolean {
  return d.mode !== "live" && Object.keys(d.params).length === 0 && detectParams(d.sql).length === 0;
}

/** Whether an allow list covers `catalog.schema.table`: null/undefined is unchecked (true); entries are `*`, `c`, `c.s` or `c.s.t`, compared lowercase (the engine's ReadPolicy rules). */
export function covers(allow: string[] | null | undefined, table: string): boolean {
  if (!allow) return true;
  const t = table.toLowerCase();
  return allow.some((a) => {
    const prefix = a.trim().toLowerCase();
    return prefix === "*" || prefix === t || t.startsWith(`${prefix}.`);
  });
}

/** The entry a render may read: present and built from `hash` (else null: missing or stale, so the dataset runs live). */
export function freshEntry(m: ExtractManifest | null, name: string, hash: string): ExtractEntry | null {
  const e = m && Object.hasOwn(m.datasets, name) ? m.datasets[name] : null;
  return e && e.hash === hash ? e : null;
}

/** The first source `allow` does not cover (null: all covered). */
export function uncovered(entry: ExtractEntry, allow: string[] | null | undefined): string | null {
  return entry.sources.find((s) => !covers(allow, s)) ?? null;
}
