import { bySchemaOrder, type CatalogInfo, type CatalogSchema, type CatalogTable, MAIN_SCHEMA } from "@/lib/catalogToml";

/** A schema of the catalog tree, with its tables (shown ones only). */
export interface SchemaGroup {
  catalog: string;
  schema: string;
  /** the schema's name as the Studio names it: `s` in the default catalog, `c.s` in another */
  name: string;
  description: string | null;
  location?: string;
  discoveryError?: string;
  tables: CatalogTable[];
}

/** A catalog of the tree, with its schemas. */
export interface CatalogGroup {
  name: string;
  isDefault: boolean;
  description: string | null;
  schemas: SchemaGroup[];
}

/**
 * The schemas of one catalog: `main` first, then the others by name, each with its
 * tables by name. Schemas without tables are kept (they are declared).
 */
export function schemaGroups(catalog: CatalogInfo, schemas: CatalogSchema[], tables: CatalogTable[]): SchemaGroup[] {
  const own = tables.filter((t) => t.catalog === catalog.name);
  const known = new Map<string, CatalogSchema>([[MAIN_SCHEMA, { name: MAIN_SCHEMA, catalog: catalog.name, description: null }]]);
  for (const s of schemas) if (s.catalog === catalog.name) known.set(s.name, s);
  for (const t of own) if (!known.has(t.schema)) known.set(t.schema, { name: t.schema, catalog: catalog.name, description: null });
  return [...known.keys()].sort(bySchemaOrder).map((schema) => ({
    catalog: catalog.name,
    schema,
    name: catalog.isDefault ? schema : `${catalog.name}.${schema}`,
    description: known.get(schema)?.description ?? null,
    location: known.get(schema)?.location,
    discoveryError: known.get(schema)?.discoveryError,
    tables: own.filter((t) => t.schema === schema).sort((a, b) => a.table.localeCompare(b.table)),
  }));
}

/** The catalogs of the tree, the default first, each with its schemas. */
export function catalogGroups(catalogs: CatalogInfo[], schemas: CatalogSchema[], tables: CatalogTable[]): CatalogGroup[] {
  return catalogs.map((c) => ({
    name: c.name,
    isDefault: c.isDefault,
    description: c.description,
    schemas: schemaGroups(c, schemas, tables),
  }));
}
