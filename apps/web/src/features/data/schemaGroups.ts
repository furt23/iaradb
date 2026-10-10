import { bySchemaOrder, MAIN_SCHEMA, type CatalogSchema, type CatalogTable } from "@/lib/catalogToml";

/** A schema of the catalog tree, with its tables (shown ones only). */
export interface SchemaGroup {
  schema: string;
  description: string | null;
  tables: CatalogTable[];
}

/**
 * The catalog by schema: `main` first, then the others by name, each with its
 * tables by name. Schemas without tables are kept (they are declared).
 */
export function schemaGroups(schemas: CatalogSchema[], tables: CatalogTable[]): SchemaGroup[] {
  const known = new Map<string, string | null>([[MAIN_SCHEMA, null]]);
  for (const s of schemas) known.set(s.name, s.description);
  for (const t of tables) if (!known.has(t.schema)) known.set(t.schema, null);
  return [...known.keys()].sort(bySchemaOrder).map((schema) => ({
    schema,
    description: known.get(schema) ?? null,
    tables: tables.filter((t) => t.schema === schema).sort((a, b) => a.table.localeCompare(b.table)),
  }));
}
