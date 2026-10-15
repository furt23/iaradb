/**
 * The catalog in `iara.toml` (pure): its tables and schemas, read without
 * a kernel, and changed in the file while keeping the rest of it (comments
 * included). A name is `table` (schema `main`) or `schema.table`. Writers emit
 * `[tables.tpch.lineitem]`; readers also take `[tables."tpch.lineitem"]`.
 */

import type { TableRef } from "@iara/protocol";
import { parse } from "smol-toml";

export const MAIN_SCHEMA = "main";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A table of the catalog; `name` is its display name (`orders`, `tpch.lineitem`). */
export interface CatalogTable extends Omit<TableRef, "format"> {
  /** `json` covers NDJSON and JSON-array files. */
  format: TableRef["format"] | "json";
  schema: string;
  table: string;
  /** found in a schema's `location`, not declared in `[tables]` */
  discovered?: boolean;
}

/** A schema: declared with `[schemas.<name>]`, or used by a table. */
export interface CatalogSchema {
  name: string;
  description: string | null;
  /** an `s3://` URL or a folder: each of its subfolders is a table */
  location?: string;
  /** why listing the location failed (set by the server) */
  discoveryError?: string;
}

export interface TableName {
  schema: string;
  table: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isIdentifier(s: string): boolean {
  return IDENTIFIER.test(s);
}

/** The schema and table a name stands for (lowercased, not validated). */
function splitName(name: string): TableName {
  const lower = name.toLowerCase();
  const dot = lower.indexOf(".");
  return dot > 0 ? { schema: lower.slice(0, dot), table: lower.slice(dot + 1) } : { schema: MAIN_SCHEMA, table: lower };
}

/** `orders`, `main.orders` or `tpch.lineitem` as a schema and a table (lowercased), or null when a part is not an identifier. */
export function parseTableName(name: string): TableName | null {
  const parts = splitName(name);
  return isIdentifier(parts.schema) && isIdentifier(parts.table) ? parts : null;
}

/** The display name: the bare table name in `main`, else `schema.table`. */
export function displayName({ schema, table }: TableName): string {
  return schema === MAIN_SCHEMA ? table : `${schema}.${table}`;
}

const JSON_EXTENSIONS = [".json", ".ndjson", ".jsonl"];

/** The format the kernel infers from a path's extension. */
function formatOfPath(path: string): CatalogTable["format"] {
  const p = path.toLowerCase();
  if (p.endsWith(".csv")) return "csv";
  return JSON_EXTENSIONS.some((e) => p.endsWith(e)) ? "json" : "parquet";
}

function catalogTable(name: TableName, path: string, format: unknown): CatalogTable {
  const fmt = format === "csv" || format === "parquet" || format === "delta" || format === "json" ? format : formatOfPath(path);
  return { name: displayName(name), schema: name.schema, table: name.table, path, format: fmt };
}

/** A table section: its own keys are scalars, so an object below it is a sub-table, which is an error. */
function tableOf(name: TableName, spec: Record<string, unknown>, path: string): CatalogTable {
  if (Object.values(spec).some(isRecord)) throw new Error(`tables.${displayName(name)} is both a table and a schema`);
  return catalogTable(name, path, spec.format);
}

/** The tables under one key of `[tables]`: a table, or the tables of a schema. */
function entriesOf(key: string, spec: unknown): CatalogTable[] {
  if (!isRecord(spec)) return [];
  if (typeof spec.path === "string") return [tableOf(splitName(key), spec, spec.path)];
  return Object.entries(spec).flatMap(([table, child]) => {
    if (!isRecord(child) || typeof child.path !== "string") return [];
    return [tableOf({ schema: key.toLowerCase(), table: table.toLowerCase() }, child, child.path)];
  });
}

/**
 * The tables of a parsed iara.toml, as the kernel reads them: `[tables.x]`
 * is in main, `[tables.s.x]` (or `[tables."s.x"]`) is in schema `s`.
 */
export function tablesOf(cfg: unknown): CatalogTable[] {
  const tables = isRecord(cfg) && isRecord(cfg.tables) ? cfg.tables : {};
  const found = Object.entries(tables).flatMap(([key, spec]) => entriesOf(key, spec));
  const names = new Set<string>();
  for (const t of found) {
    if (names.has(t.name)) throw new Error(`table ${t.name} is defined twice`);
    names.add(t.name);
  }
  return found;
}

/** `main` first, then the schemas by name. */
export function bySchemaOrder(a: string, b: string): number {
  if (a === b) return 0;
  if (a === MAIN_SCHEMA) return -1;
  if (b === MAIN_SCHEMA) return 1;
  return a.localeCompare(b);
}

/** The schemas of a iara.toml text: declared ones (with their description) and those used by a table. */
export function schemasOf(text: string): CatalogSchema[] {
  const cfg = parse(text);
  const declared = isRecord(cfg.schemas) ? cfg.schemas : {};
  const found = new Map<string, CatalogSchema>([[MAIN_SCHEMA, { name: MAIN_SCHEMA, description: null }]]);
  for (const [name, spec] of Object.entries(declared)) {
    const description = isRecord(spec) && typeof spec.description === "string" ? spec.description : null;
    const schema: CatalogSchema = { name: name.toLowerCase(), description };
    if (isRecord(spec) && typeof spec.location === "string" && spec.location.trim()) schema.location = spec.location.trim();
    found.set(schema.name, schema);
  }
  for (const t of tablesOf(cfg)) if (!found.has(t.schema)) found.set(t.schema, { name: t.schema, description: null });
  return [...found.keys()].sort(bySchemaOrder).map((name) => found.get(name)!);
}

const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;

/** The dotted key of a `[header]` line, quotes removed and lowercased, or null. */
function headerKey(line: string): string | null {
  const m = HEADER.exec(line);
  return m ? m[1].replace(/\s*\.\s*/g, ".").replace(/["']/g, "").toLowerCase() : null;
}

/**
 * The text without the section at `key` and its sub-sections (`key.*`), or
 * null when the text has no such section. Comments right above a header
 * belong to it; the blank lines around the removed part are collapsed.
 */
function removeSection(text: string, key: string): string | null {
  const lines = text.split(/\r?\n/);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const own = (k: string) => k === key || k.startsWith(`${key}.`);
  // the section each line belongs to ("" before the first header)
  const owner: string[] = [];
  let section = "";
  lines.forEach((line, i) => {
    const header = headerKey(line);
    if (header !== null) {
      section = header;
      for (let j = i - 1; j >= 0 && /^\s*#/.test(lines[j]); j--) owner[j] = header;
    }
    owner[i] = section;
  });
  if (!owner.some(own)) return null;
  return lines
    .filter((_, i) => !own(owner[i]))
    .join(eol)
    .replace(/(\r?\n){3,}/g, eol + eol);
}

/** The text without the table's section (and its sub-sections), or null when there is none. */
export function removeTableSection(text: string, name: string): string | null {
  return removeSection(text, `tables.${displayName(splitName(name))}`);
}

/** The text without the schema's `[schemas.<name>]` section, or null when there is none. */
export function removeSchemaSection(text: string, name: string): string | null {
  return removeSection(text, `schemas.${name.toLowerCase()}`);
}

/** The `[tables.<name>]` section of a table, as the catalog writes it (`path`, and `format` when given). */
export function tableEntry(name: string, path: string, format?: string): string {
  const parts = parseTableName(name);
  if (!parts) throw new Error(`invalid table name ${name}`);
  const lines = [`\n[tables.${displayName(parts)}]`, `path = ${JSON.stringify(path)}`];
  if (format) lines.push(`format = ${JSON.stringify(format)}`);
  return `${lines.join("\n")}\n`;
}

/** The `[schemas.<name>]` section of a schema, with its description and location when it has them. */
export function schemaEntry(name: string, description?: string | null, location?: string | null): string {
  if (!isIdentifier(name)) throw new Error(`invalid schema name ${name}`);
  const desc = description ? `description = ${JSON.stringify(description)}\n` : "";
  const loc = location ? `location = ${JSON.stringify(location)}\n` : "";
  return `\n[schemas.${name.toLowerCase()}]\n${desc}${loc}`;
}

/** A table name for a dataset path: its last part, without extension, as an identifier. */
export function suggestTableName(path: string): string {
  // a glob names its folder
  const parts = path.split(/[\\/]/).filter((p) => p && !p.includes("*"));
  const base = (parts.pop() ?? "").replace(/\.(parquet|csv|tsv|txt|json|ndjson|jsonl)$/i, "");
  const id = base.toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
  return /^[0-9]/.test(id) ? `t_${id}` : id;
}

/** A schema location: an `s3://` URL or a folder, without `..` segments. */
export function validLocation(location: string): boolean {
  const l = location.trim();
  if (!l) return false;
  return !l.split(/[\/]/).includes("..");
}
