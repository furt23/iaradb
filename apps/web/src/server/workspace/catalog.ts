import "server-only";

import { parse } from "smol-toml";

import {
  type CatalogSchema,
  type CatalogTable,
  displayName,
  isIdentifier,
  MAIN_SCHEMA,
  parseTableName,
  removeSchemaSection,
  removeTableSection,
  schemaEntry,
  schemasOf,
  tablesOf,
  validLocation,
} from "@/lib/catalogToml";

import { discoverTables } from "./discovery";
import { appendConfigEntry, readConfigText, writeConfigText } from "./sources";

/** `read` over iara.toml's text (empty when there is none), a broken file reported to the catalog panel. */
async function catalogOf<T>(read: (text: string) => T | Promise<T>): Promise<T> {
  const text = (await readConfigText()) ?? "";
  try {
    return await read(text);
  } catch (e) {
    throw new Error(`iara.toml could not be read: ${(e as Error).message}`);
  }
}

/** Declared tables and the discovered ones (declared ones win), with each schema's discovery error. */
async function readCatalog(): Promise<{ tables: CatalogTable[]; schemas: CatalogSchema[] }> {
  return catalogOf(async (text) => {
    const cfg = parse(text);
    const declared = tablesOf(cfg);
    const schemas = schemasOf(text);
    const names = new Set(declared.map((t) => t.name));
    const tables = [...declared];
    const found = await Promise.all(
      schemas.map(async (s) => (s.location ? { s, d: await discoverTables(s.name, s.location, cfg) } : null)),
    );
    for (const f of found) {
      if (!f) continue;
      if (f.d.error) f.s.discoveryError = f.d.error;
      for (const t of f.d.tables) if (!names.has(t.name)) tables.push(t);
    }
    return { tables: tables.sort((a, b) => a.name.localeCompare(b.name)), schemas };
  });
}

/** The tables of iara.toml plus those discovered under schema locations: no kernel (nor cluster) needed. */
export async function catalogTables(): Promise<CatalogTable[]> {
  return (await readCatalog()).tables;
}

/** The schemas of iara.toml: `main` first, then declared and used ones. */
export async function catalogSchemas(): Promise<CatalogSchema[]> {
  return (await readCatalog()).schemas;
}

/** Remove a table from iara.toml (its data is not touched). */
export async function removeCatalogTable(name: string): Promise<void> {
  const found = (await catalogTables()).find((t) => t.name === displayName(parseTableName(name) ?? { schema: MAIN_SCHEMA, table: name }));
  if (found?.discovered) {
    throw new Error(
      `${found.name} is the folder ${found.path} under schema ${found.schema}'s location: delete the folder to remove the table`,
    );
  }
  const text = await readConfigText();
  const next = text === null ? null : removeTableSection(text, name);
  if (next === null) throw new Error(`iara.toml has no [tables.${name}] section`);
  await writeConfigText(next);
}

/** Declare a schema in iara.toml. */
export async function addCatalogSchema(name: string, description: string | null, location?: string | null): Promise<void> {
  if (!isIdentifier(name)) throw new Error("schema names are letters, digits and underscores");
  const schema = name.toLowerCase();
  if (schema === MAIN_SCHEMA) throw new Error("main is always there: name the schema another way");
  const place = location?.trim() || null;
  if (place && !validLocation(place)) throw new Error("a location is an s3:// URL or a folder without `..`");
  if ((await catalogSchemas()).some((s) => s.name === schema)) throw new Error(`schema ${schema} already exists`);
  await appendConfigEntry(schemaEntry(schema, description, place));
}

/** Remove an empty schema's declaration from iara.toml. */
export async function removeCatalogSchema(name: string): Promise<void> {
  const schema = name.toLowerCase();
  if (schema === MAIN_SCHEMA) throw new Error("main cannot be removed");
  const { tables: all, schemas } = await readCatalog();
  const found = all.filter((t) => t.schema === schema);
  const place = schemas.find((s) => s.name === schema)?.location;
  if (place && found.some((t) => t.discovered)) {
    throw new Error(`schema ${schema} has tables that are folders under its location ${place}: delete the folders first`);
  }
  if (found.length) throw new Error(`schema ${schema} has ${found.length} ${found.length === 1 ? "table" : "tables"}: remove them first`);
  const text = (await readConfigText()) ?? "";
  const next = removeSchemaSection(text, schema);
  if (next === null) throw new Error(`schema ${schema} is not declared in iara.toml`);
  await writeConfigText(next);
}
