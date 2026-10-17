/**
 * The catalog in `iara.toml` (pure): its catalogs, tables and schemas, read
 * without a kernel, and changed in the file while keeping the rest of it
 * (comments included). A table's name is `table` (main of the default catalog),
 * `schema.table` (the default catalog) or `catalog.schema.table` (another catalog,
 * `main` included). The default catalog is named after the workspace. Writers
 * emit `[tables.tpch.lineitem]`; readers also take `[tables."tpch.lineitem"]`.
 */

import type { CatalogChange, TableRef } from "@iara/protocol";
import { parse } from "smol-toml";

export const MAIN_SCHEMA = "main";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A table of a catalog; `name` is its display name (`orders`, `tpch.lineitem`, `sales.main.orders`). */
export interface CatalogTable extends Omit<TableRef, "format"> {
  /** `json` covers NDJSON and JSON-array files. */
  format: TableRef["format"] | "json";
  /** the catalog's name (the default catalog's too) */
  catalog: string;
  schema: string;
  table: string;
  /** found in a schema's `location`, not declared in `[tables]` */
  discovered?: boolean;
}

/** A schema: declared with `[schemas.<name>]` (or `[catalogs.<c>.schemas.<name>]`), or used by a table. */
export interface CatalogSchema {
  name: string;
  /** the catalog it is in (the default catalog's name for the default one) */
  catalog: string;
  description: string | null;
  /** an `s3://` URL or a folder: each of its subfolders is a table */
  location?: string;
  /** why listing the location failed (set by the server) */
  discoveryError?: string;
}

/** A catalog: the default one (named after the workspace), or one declared with `[catalogs.<name>]`. */
export interface CatalogInfo {
  name: string;
  description: string | null;
  isDefault: boolean;
}

export interface TableName {
  catalog: string;
  schema: string;
  table: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isIdentifier(s: string): boolean {
  return IDENTIFIER.test(s);
}

/** The catalog name a workspace name gives: lowercase, other characters as `_`, `_` before a leading digit, `main` when empty. */
export function normalizeCatalogName(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!id) return MAIN_SCHEMA;
  return /^[0-9]/.test(id) ? `_${id}` : id;
}

/** The default catalog's name: the normalized `[workspace] name` of a parsed catalog. */
export function defaultCatalogOf(cfg: unknown): string {
  const workspace = isRecord(cfg) && isRecord(cfg.workspace) ? cfg.workspace : {};
  return normalizeCatalogName(typeof workspace.name === "string" ? workspace.name : "");
}

/** A schema's name as the Studio's changes and actions name it: `s` in the default catalog, `c.s` in another. */
export function schemaDisplayName(schema: { catalog: string; name: string }, defaultCatalog: string): string {
  return schema.catalog === defaultCatalog ? schema.name : `${schema.catalog}.${schema.name}`;
}

/**
 * The display name of a table: its bare name in main of the default catalog,
 * `schema.table` in the other schemas of the default catalog, `catalog.schema.table`
 * in another catalog.
 */
export function displayName({ catalog, schema, table }: TableName, defaultCatalog: string): string {
  if (catalog !== defaultCatalog) return `${catalog}.${schema}.${table}`;
  return schema === MAIN_SCHEMA ? table : `${schema}.${table}`;
}

/**
 * A table name as its parts, lowercased: `orders` is main of the default catalog,
 * `s.t` a table of the default catalog, `c.s.t` a table of catalog `c`. Null when a
 * part is not an identifier.
 */
export function parseTableName(name: string, defaultCatalog: string): TableName | null {
  const parts = name.toLowerCase().split(".");
  let names: TableName;
  if (parts.length === 1) names = { catalog: defaultCatalog, schema: MAIN_SCHEMA, table: parts[0] };
  else if (parts.length === 2) names = { catalog: defaultCatalog, schema: parts[0], table: parts[1] };
  else if (parts.length === 3) names = { catalog: parts[0], schema: parts[1], table: parts[2] };
  else return null;
  return isIdentifier(names.catalog) && isIdentifier(names.schema) && isIdentifier(names.table) ? names : null;
}

/** `name`, a table of `catalog` (`t` or `s.t`), as `catalog.schema.table`. */
export function inCatalog(name: string, catalog: string): string {
  const parts = name.toLowerCase().split(".");
  const schemaAndTable = parts.length === 1 ? [MAIN_SCHEMA, parts[0]] : parts;
  return [catalog.toLowerCase(), ...schemaAndTable].join(".");
}

const JSON_EXTENSIONS = [".json", ".ndjson", ".jsonl"];

/** The format the kernel infers from a path's extension. */
function formatOfPath(path: string): CatalogTable["format"] {
  const p = path.toLowerCase();
  if (p.endsWith(".csv")) return "csv";
  return JSON_EXTENSIONS.some((e) => p.endsWith(e)) ? "json" : "parquet";
}

function catalogTable(name: TableName, path: string, format: unknown, defaultCatalog: string): CatalogTable {
  const fmt = format === "csv" || format === "parquet" || format === "delta" || format === "json" ? format : formatOfPath(path);
  return {
    name: displayName(name, defaultCatalog),
    catalog: name.catalog,
    schema: name.schema,
    table: name.table,
    path,
    format: fmt,
  };
}

/** The TOML section of a table by its display name: `tables.t`, `tables.s.t`, or `catalogs.c.tables.s.t` in another catalog. */
function tableSection(name: string): string {
  const parts = name.toLowerCase().split(".");
  const catalog = parts.length === 3 ? parts[0] : null;
  const [schema, table] = parts.length === 1 ? [MAIN_SCHEMA, parts[0]] : parts.slice(-2);
  const key = `tables.${schema === MAIN_SCHEMA ? table : `${schema}.${table}`}`;
  return catalog === null ? key : `catalogs.${catalog}.${key}`;
}

/** A table section: its own keys are scalars, so an object below it is a sub-table, which is an error. */
function tableOf(name: TableName, spec: Record<string, unknown>, path: string, defaultCatalog: string): CatalogTable {
  if (Object.values(spec).some(isRecord)) throw new Error(`${tableSection(displayName(name, defaultCatalog))} is both a table and a schema`);
  return catalogTable(name, path, spec.format, defaultCatalog);
}

/** The schema and the table of a `[tables]` key (`orders`, `tpch.lineitem`), lowercased. */
function schemaAndTable(key: string): { schema: string; table: string } {
  const lower = key.toLowerCase();
  const dot = lower.indexOf(".");
  return dot > 0 ? { schema: lower.slice(0, dot), table: lower.slice(dot + 1) } : { schema: MAIN_SCHEMA, table: lower };
}

/** The tables under one key of a `tables` table: a table, or the tables of a schema. */
function entriesOf(catalog: string, key: string, spec: unknown, defaultCatalog: string): CatalogTable[] {
  if (!isRecord(spec)) return [];
  if (typeof spec.path === "string") return [tableOf({ catalog, ...schemaAndTable(key) }, spec, spec.path, defaultCatalog)];
  return Object.entries(spec).flatMap(([table, child]) => {
    if (!isRecord(child) || typeof child.path !== "string") return [];
    return [tableOf({ catalog, schema: key.toLowerCase(), table: table.toLowerCase() }, child, child.path, defaultCatalog)];
  });
}

/** The tables of one catalog, from its `tables` table (`catalog` is its name). */
function tablesIn(catalog: string, tables: unknown, defaultCatalog: string): CatalogTable[] {
  if (!isRecord(tables)) return [];
  return Object.entries(tables).flatMap(([key, spec]) => entriesOf(catalog, key, spec, defaultCatalog));
}

/**
 * The catalogs declared with `[catalogs.<name>]`, by name (lowercased and checked),
 * sorted by name. The default catalog's name, and a name declared twice, are errors.
 */
function declaredCatalogs(cfg: unknown): { name: string; spec: unknown }[] {
  const defaultCatalog = defaultCatalogOf(cfg);
  const declared: Record<string, unknown> = isRecord(cfg) && isRecord(cfg.catalogs) ? cfg.catalogs : {};
  const names = new Set<string>();
  return Object.entries(declared)
    .map(([key, spec]) => {
      const name = key.toLowerCase();
      if (!isIdentifier(name)) throw new Error(`catalog names are letters, digits and underscores: ${key}`);
      if (name === defaultCatalog) throw new Error(`catalog ${name} has the name of the default catalog: name it another way`);
      if (names.has(name)) throw new Error(`catalog ${name} is defined twice`);
      names.add(name);
      return { name, spec };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The catalogs of an iara.toml text: the default catalog first, then the declared ones by name. */
export function catalogsOf(text: string): CatalogInfo[] {
  const cfg = parse(text);
  return [
    { name: defaultCatalogOf(cfg), description: null, isDefault: true },
    ...declaredCatalogs(cfg).map(({ name, spec }) => ({
      name,
      description: isRecord(spec) && typeof spec.description === "string" ? spec.description : null,
      isDefault: false,
    })),
  ];
}

/**
 * The tables of a parsed iara.toml, as the kernel reads them: `[tables.x]` is main
 * of the default catalog, `[tables.s.x]` (or `[tables."s.x"]`) is in schema `s`,
 * and `[catalogs.<c>.tables.…]` is in catalog `c`, with the same forms.
 */
export function tablesOf(cfg: unknown): CatalogTable[] {
  const defaultCatalog = defaultCatalogOf(cfg);
  const root = isRecord(cfg) ? cfg : {};
  const found = [
    ...tablesIn(defaultCatalog, root.tables, defaultCatalog),
    ...declaredCatalogs(cfg).flatMap(({ name, spec }) => tablesIn(name, isRecord(spec) ? spec.tables : undefined, defaultCatalog)),
  ];
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

/** The schemas of one catalog: `main`, the declared ones (with their description) and those used by its tables. */
function schemasIn(catalog: string, declared: unknown, tables: CatalogTable[]): CatalogSchema[] {
  const found = new Map<string, CatalogSchema>([[MAIN_SCHEMA, { name: MAIN_SCHEMA, catalog, description: null }]]);
  const decl: Record<string, unknown> = isRecord(declared) ? declared : {};
  for (const [name, spec] of Object.entries(decl)) {
    const schema: CatalogSchema = {
      name: name.toLowerCase(),
      catalog,
      description: isRecord(spec) && typeof spec.description === "string" ? spec.description : null,
    };
    if (isRecord(spec) && typeof spec.location === "string" && spec.location.trim()) schema.location = spec.location.trim();
    found.set(schema.name, schema);
  }
  for (const t of tables) if (!found.has(t.schema)) found.set(t.schema, { name: t.schema, catalog, description: null });
  return [...found.keys()].sort(bySchemaOrder).map((name) => found.get(name)!);
}

/** The schemas of an iara.toml text, catalog by catalog (the default first): each catalog's `main`, its declared schemas and the ones its tables use. */
export function schemasOf(text: string): CatalogSchema[] {
  const cfg = parse(text);
  const tables = tablesOf(cfg);
  const root = isRecord(cfg) ? cfg : {};
  const catalogs = [
    { name: defaultCatalogOf(cfg), declared: root.schemas },
    ...declaredCatalogs(cfg).map(({ name, spec }) => ({ name, declared: isRecord(spec) ? spec.schemas : undefined })),
  ];
  return catalogs.flatMap(({ name, declared }) => schemasIn(name, declared, tables.filter((t) => t.catalog === name)));
}

const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;

/** The dotted key of a `[header]` line, quotes removed and lowercased, or null. */
function headerKey(line: string): string | null {
  const m = HEADER.exec(line);
  return m ? m[1].replace(/\s*\.\s*/g, ".").replace(/["']/g, "").toLowerCase() : null;
}

/**
 * The text without the section at `key` and, unless `withSubsections` is false, its
 * sub-sections (`key.*`), or null when the text has no such section. Comments right
 * above a header belong to it; the blank lines around the removed part are collapsed.
 */
function removeSection(text: string, key: string, withSubsections = true): string | null {
  const lines = text.split(/\r?\n/);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const own = (k: string) => k === key || (withSubsections && k.startsWith(`${key}.`));
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

/** The text without the table's section (and its sub-sections), or null when there is none. `name` is a display name. */
export function removeTableSection(text: string, name: string): string | null {
  if (name.split(".").length > 3) return null;
  return removeSection(text, tableSection(name));
}

/** The section of a schema's name: `schemas.<s>`, or `catalogs.<c>.schemas.<s>` for `c.<s>`. */
function schemaSection(name: string): string | null {
  const parts = name.toLowerCase().split(".");
  if (parts.length === 1) return `schemas.${parts[0]}`;
  return parts.length === 2 ? `catalogs.${parts[0]}.schemas.${parts[1]}` : null;
}

/** The text without the schema's declaration (`name` is `s`, or `c.s` in another catalog), or null when there is none. */
export function removeSchemaSection(text: string, name: string): string | null {
  const section = schemaSection(name);
  return section === null ? null : removeSection(text, section);
}

/** The text without the catalog's `[catalogs.<name>]` section and everything below it (its tables and schemas), or null when there is none. */
export function removeCatalogSections(text: string, name: string): string | null {
  return removeSection(text, `catalogs.${name.toLowerCase()}`);
}

/** The text without the catalog's own `[catalogs.<name>]` section, its tables and schemas kept; null when there is none. */
export function removeCatalogHeader(text: string, name: string): string | null {
  return removeSection(text, `catalogs.${name.toLowerCase()}`, false);
}

/** The parts of a 1-3 part name (lowercased), or null when a part is not an identifier. */
function validParts(name: string): string[] | null {
  const parts = name.toLowerCase().split(".");
  return parts.length <= 3 && parts.every(isIdentifier) ? parts : null;
}

/**
 * The `[tables.<name>]` section of a table, as the catalog writes it (`path`, and
 * `format` when given). With `catalog`, `name` is a table of that catalog (`t` or
 * `s.t`), written under `[catalogs.<c>.tables]`.
 */
export function tableEntry(name: string, path: string, format?: string, catalog?: string): string {
  const full = catalog === undefined ? name : inCatalog(name, catalog);
  if (!validParts(full)) throw new Error(`invalid table name ${name}`);
  const lines = [`\n[${tableSection(full)}]`, `path = ${JSON.stringify(path)}`];
  if (format) lines.push(`format = ${JSON.stringify(format)}`);
  return `${lines.join("\n")}\n`;
}

/**
 * The `[schemas.<name>]` section of a schema, with its description and location when
 * it has them. With `catalog`, the schema is in that catalog (`[catalogs.<c>.schemas.<name>]`).
 */
export function schemaEntry(name: string, description?: string | null, location?: string | null, catalog?: string): string {
  if (!isIdentifier(name)) throw new Error(`invalid schema name ${name}`);
  if (catalog !== undefined && !isIdentifier(catalog.toLowerCase())) throw new Error(`invalid catalog name ${catalog}`);
  const section = catalog === undefined ? `schemas.${name.toLowerCase()}` : `catalogs.${catalog.toLowerCase()}.schemas.${name.toLowerCase()}`;
  const desc = description ? `description = ${JSON.stringify(description)}\n` : "";
  const loc = location ? `location = ${JSON.stringify(location)}\n` : "";
  return `\n[${section}]\n${desc}${loc}`;
}

/** The `[catalogs.<name>]` section of a catalog, with its description when it has one. */
export function catalogEntry(name: string, description?: string | null): string {
  if (!isIdentifier(name)) throw new Error(`invalid catalog name ${name}`);
  const desc = description ? `description = ${JSON.stringify(description)}\n` : "";
  return `\n[catalogs.${name.toLowerCase()}]\n${desc}`;
}

function appendEntry(text: string, entry: string | null): string {
  if (!entry) return text;
  return `${text.replace(/\s*$/, "\n")}${entry}`;
}

/**
 * `text` with the section a catalog change names replaced by its entry, or removed
 * (a null entry). An entry for a table or schema that is already declared keeps the
 * declared section (a `CREATE ... IF NOT EXISTS` keeps its description), as does one
 * for a catalog that is declared.
 */
export function withChange(text: string, change: CatalogChange): string {
  if (change.kind === "catalog") {
    if (!change.entry) return removeCatalogSections(text, change.name) ?? text;
    return removeCatalogHeader(text, change.name) !== null ? text : appendEntry(text, change.entry);
  }
  if (change.kind === "schema") {
    const declared = removeSchemaSection(text, change.name);
    if (change.entry && declared !== null) return text;
    return appendEntry(declared ?? text, change.entry);
  }
  return appendEntry(removeTableSection(text, change.name) ?? text, change.entry);
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

/**
 * The columns of each table under its full name too (`catalog.schema.table` for a
 * table of the default catalog), for SQL completion: `orders` is also `tpch.main.orders`.
 */
export function withCatalogNames<T>(columns: Record<string, T>, defaultCatalog: string): Record<string, T> {
  const out = { ...columns };
  for (const [name, value] of Object.entries(columns)) {
    const parts = parseTableName(name, defaultCatalog);
    if (parts && parts.catalog === defaultCatalog) out[`${parts.catalog}.${parts.schema}.${parts.table}`] = value;
  }
  return out;
}
