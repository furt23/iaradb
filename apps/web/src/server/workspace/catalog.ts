import "server-only";

import { parse } from "smol-toml";

import {
  type CatalogInfo,
  type CatalogSchema,
  type CatalogTable,
  catalogEntry,
  catalogsOf,
  defaultCatalogOf,
  displayName,
  isIdentifier,
  MAIN_SCHEMA,
  parseTableName,
  removeCatalogSections,
  removeSchemaSection,
  removeTableSection,
  schemaDisplayName,
  schemaEntry,
  schemasOf,
  tablesOf,
  validLocation,
} from "@/lib/catalogToml";

import { discoverTables } from "./discovery";
import { appendConfigEntry, kernelConfigText, readConfigText, writeConfigText } from "./sources";

/** `read` over the catalog's text as the kernels read it, a broken catalog reported to the catalog panel. */
async function catalogOf<T>(read: (text: string) => T | Promise<T>): Promise<T> {
  const text = await kernelConfigText("local");
  try {
    return await read(text);
  } catch (e) {
    throw new Error(`the catalog could not be read: ${(e as Error).message}`);
  }
}

interface CatalogState {
  catalogs: CatalogInfo[];
  tables: CatalogTable[];
  schemas: CatalogSchema[];
}

/**
 * The catalogs, their tables (declared ones, and the discovered ones unless a
 * declared table has the name) and schemas, each schema with its discovery error.
 */
async function readCatalog(): Promise<CatalogState> {
  return catalogOf(async (text) => {
    const cfg = parse(text);
    const declared = tablesOf(cfg);
    const schemas = schemasOf(text);
    const names = new Set(declared.map((t) => t.name));
    const tables = [...declared];
    const found = await Promise.all(
      schemas.map(async (s) => (s.location ? { s, d: await discoverTables(s, s.location, cfg) } : null)),
    );
    for (const f of found) {
      if (!f) continue;
      if (f.d.error) f.s.discoveryError = f.d.error;
      for (const t of f.d.tables) if (!names.has(t.name)) tables.push(t);
    }
    return { catalogs: catalogsOf(text), tables: tables.sort((a, b) => a.name.localeCompare(b.name)), schemas };
  });
}

/** The tables of every catalog plus those discovered under schema locations: no kernel (nor cluster) needed. */
export async function catalogTables(): Promise<CatalogTable[]> {
  return (await readCatalog()).tables;
}

/** The schemas of the catalog, or of one catalog: each catalog's `main` first, then declared and used ones. */
export async function catalogSchemas(catalog?: string): Promise<CatalogSchema[]> {
  const { schemas } = await readCatalog();
  return catalog === undefined ? schemas : schemas.filter((s) => s.catalog === catalog);
}

/** The catalogs: the default one first, then the declared ones by name. */
export async function catalogList(): Promise<CatalogInfo[]> {
  return (await readCatalog()).catalogs;
}

/** The default catalog's name, read from the catalog text (no discovery: cheap enough for every page). */
export async function defaultCatalog(): Promise<string> {
  return catalogOf((text) => defaultCatalogOf(parse(text)));
}

/** Remove a table from the catalog (its data is not touched). `name` is its display name. */
export async function removeCatalogTable(name: string): Promise<void> {
  const { catalogs, tables } = await readCatalog();
  const defaultName = catalogs[0].name;
  const parsed = parseTableName(name, defaultName);
  if (!parsed) throw new Error(`invalid table name ${name}`);
  const display = displayName(parsed, defaultName);
  const found = tables.find((t) => t.name === display);
  if (found?.discovered) {
    throw new Error(
      `${found.name} is the folder ${found.path} under schema ${schemaDisplayName({ catalog: found.catalog, name: found.schema }, defaultName)}'s location: delete the folder to remove the table`,
    );
  }
  const next = removeTableSection(await readConfigText(), display);
  if (next === null) throw new Error(`${display} is not declared in the catalog`);
  await writeConfigText(next);
}

/** Declare a schema in a catalog: the default one (`[schemas.<name>]`), or another (`[catalogs.<c>.schemas.<name>]`). */
export async function addCatalogSchema(catalog: string, name: string, description: string | null, location?: string | null): Promise<void> {
  if (!isIdentifier(name)) throw new Error("schema names are letters, digits and underscores");
  const schema = name.toLowerCase();
  if (schema === MAIN_SCHEMA) throw new Error("main is always there: name the schema another way");
  const place = location?.trim() || null;
  if (place && !validLocation(place)) throw new Error("a location is an s3:// URL or a folder without `..`");
  const { catalogs, schemas } = await readCatalog();
  const target = catalogs.find((c) => c.name === catalog.toLowerCase());
  if (!target) throw new Error(`catalog ${catalog} does not exist`);
  if (schemas.some((s) => s.catalog === target.name && s.name === schema)) {
    throw new Error(`schema ${schemaDisplayName({ catalog: target.name, name: schema }, catalogs[0].name)} already exists`);
  }
  await appendConfigEntry(schemaEntry(schema, description, place, target.isDefault ? undefined : target.name));
}

/** Remove an empty schema's declaration from the catalog. `name` is `schema` (default catalog) or `catalog.schema`. */
export async function removeCatalogSchema(name: string): Promise<void> {
  const parts = name.toLowerCase().split(".");
  if (parts.length > 2) throw new Error(`invalid schema name ${name}`);
  const { catalogs, tables, schemas } = await readCatalog();
  const defaultName = catalogs[0].name;
  const catalog = parts.length === 2 ? parts[0] : defaultName;
  const schema = parts[parts.length - 1];
  const display = schemaDisplayName({ catalog, name: schema }, defaultName);
  if (schema === MAIN_SCHEMA) throw new Error("main cannot be removed");
  const found = tables.filter((t) => t.catalog === catalog && t.schema === schema);
  const place = schemas.find((s) => s.catalog === catalog && s.name === schema)?.location;
  if (place && found.some((t) => t.discovered)) {
    throw new Error(`schema ${display} has tables that are folders under its location ${place}: delete the folders first`);
  }
  if (found.length) throw new Error(`schema ${display} has ${found.length} ${found.length === 1 ? "table" : "tables"}: remove them first`);
  const next = removeSchemaSection(await readConfigText(), display);
  if (next === null) throw new Error(`schema ${display} is not declared in the catalog`);
  await writeConfigText(next);
}

/** Declare a catalog (`[catalogs.<name>]`). The default catalog's name and the names of declared catalogs are refused. */
export async function addCatalog(name: string, description: string | null): Promise<void> {
  const catalog = name.toLowerCase();
  if (!isIdentifier(catalog)) throw new Error("catalog names are letters, digits and underscores");
  const { catalogs } = await readCatalog();
  if (catalogs.some((c) => c.name === catalog)) {
    throw new Error(
      catalogs[0].name === catalog ? `${catalog} is the default catalog: name it another way` : `catalog ${catalog} already exists`,
    );
  }
  await appendConfigEntry(catalogEntry(catalog, description));
}

/** Remove an empty catalog: no tables, and no schemas besides main. The default catalog cannot be removed. */
export async function removeCatalog(name: string): Promise<void> {
  const catalog = name.toLowerCase();
  const { catalogs, tables, schemas } = await readCatalog();
  if (catalogs[0].name === catalog) throw new Error("the default catalog is the workspace's: it cannot be removed");
  if (!catalogs.some((c) => c.name === catalog)) throw new Error(`catalog ${catalog} does not exist`);
  const found = tables.filter((t) => t.catalog === catalog);
  if (found.some((t) => t.discovered)) {
    throw new Error(`catalog ${catalog} has tables that are folders under its schema locations: delete the folders first`);
  }
  if (found.length) throw new Error(`catalog ${catalog} has ${found.length} ${found.length === 1 ? "table" : "tables"}: remove them first`);
  const others = schemas.filter((s) => s.catalog === catalog && s.name !== MAIN_SCHEMA);
  if (others.length) throw new Error(`catalog ${catalog} has ${others.length} ${others.length === 1 ? "schema" : "schemas"} besides main: remove them first`);
  const next = removeCatalogSections(await readConfigText(), catalog);
  if (next === null) throw new Error(`catalog ${catalog} is not declared in the catalog`);
  await writeConfigText(next);
}
