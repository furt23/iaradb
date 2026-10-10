import "server-only";

import { parse } from "smol-toml";

import {
  type CatalogSchema,
  type CatalogTable,
  isIdentifier,
  MAIN_SCHEMA,
  removeSchemaSection,
  removeTableSection,
  schemaEntry,
  schemasOf,
  tablesOf,
} from "@/lib/catalogToml";

import { appendConfigEntry, readConfigText, writeConfigText } from "./sources";

/** `read` over workhouse.toml's text (empty when there is none), a broken file reported to the catalog panel. */
async function catalogOf<T>(read: (text: string) => T): Promise<T> {
  const text = (await readConfigText()) ?? "";
  try {
    return read(text);
  } catch (e) {
    throw new Error(`workhouse.toml could not be read: ${(e as Error).message}`);
  }
}

/** The tables of workhouse.toml, read by the Studio: no kernel (nor cluster) needed. */
export async function catalogTables(): Promise<CatalogTable[]> {
  return catalogOf((text) => tablesOf(parse(text)).sort((a, b) => a.name.localeCompare(b.name)));
}

/** The schemas of workhouse.toml: `main` first, then declared and used ones. */
export async function catalogSchemas(): Promise<CatalogSchema[]> {
  return catalogOf(schemasOf);
}

/** Remove a table from workhouse.toml (its data is not touched). */
export async function removeCatalogTable(name: string): Promise<void> {
  const text = await readConfigText();
  const next = text === null ? null : removeTableSection(text, name);
  if (next === null) throw new Error(`workhouse.toml has no [tables.${name}] section`);
  await writeConfigText(next);
}

/** Declare a schema in workhouse.toml. */
export async function addCatalogSchema(name: string, description: string | null): Promise<void> {
  if (!isIdentifier(name)) throw new Error("schema names are letters, digits and underscores");
  const schema = name.toLowerCase();
  if (schema === MAIN_SCHEMA) throw new Error("main is always there: name the schema another way");
  if ((await catalogSchemas()).some((s) => s.name === schema)) throw new Error(`schema ${schema} already exists`);
  await appendConfigEntry(schemaEntry(schema, description));
}

/** Remove an empty schema's declaration from workhouse.toml. */
export async function removeCatalogSchema(name: string): Promise<void> {
  const schema = name.toLowerCase();
  if (schema === MAIN_SCHEMA) throw new Error("main cannot be removed");
  const text = (await readConfigText()) ?? "";
  const tables = tablesOf(parse(text)).filter((t) => t.schema === schema).length;
  if (tables) throw new Error(`schema ${schema} has ${tables} ${tables === 1 ? "table" : "tables"}: remove them first`);
  const next = removeSchemaSection(text, schema);
  if (next === null) throw new Error(`schema ${schema} is not declared in workhouse.toml`);
  await writeConfigText(next);
}
