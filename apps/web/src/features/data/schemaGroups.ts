import { bySchemaOrder, MAIN_SCHEMA, type CatalogSchema, type CatalogTable } from "@/lib/catalogToml";

/** A schema of the catalog tree, with its tables (shown ones only). */
export interface SchemaGroup {
  schema: string;
  description: string | null;
  location?: string;
  discoveryError?: string;
  tables: CatalogTable[];
}

/**
 * The catalog by schema: `main` first, then the others by name, each with its
 * tables by name. Schemas without tables are kept (they are declared).
 */
export function schemaGroups(schemas: CatalogSchema[], tables: CatalogTable[]): SchemaGroup[] {
  const known = new Map<string, CatalogSchema>([[MAIN_SCHEMA, { name: MAIN_SCHEMA, description: null }]]);
  for (const s of schemas) known.set(s.name, s);
  for (const t of tables) if (!known.has(t.schema)) known.set(t.schema, { name: t.schema, description: null });
  return [...known.keys()].sort(bySchemaOrder).map((schema) => ({
    schema,
    description: known.get(schema)?.description ?? null,
    location: known.get(schema)?.location,
    discoveryError: known.get(schema)?.discoveryError,
    tables: tables.filter((t) => t.schema === schema).sort((a, b) => a.table.localeCompare(b.table)),
  }));
}
