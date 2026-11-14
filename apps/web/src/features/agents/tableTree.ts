/** The agent's tables as a tree by catalog and schema (pure). Full names are catalog.schema.table; identifiers have no dots. */

/** Tables rendered at once: a search over a 15k catalog must not render every row. */
export const MAX_SHOWN = 300;

export interface TreeSchema {
  schema: string;
  /** every matching table, sorted, as full names */
  tables: string[];
}

export interface TreeCatalog {
  catalog: string;
  schemas: TreeSchema[];
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The catalog.schema key of a schema (a table's full name without its table). */
export const schemaKeyOf = (full: string) => full.split(".").slice(0, 2).join(".");

/** A table's short name, within its schema. */
export const tableNameOf = (full: string) => full.split(".").slice(2).join(".");

/**
 * The names grouped by catalog and schema, sorted. A query matches anywhere in the full name
 * (case-insensitive); `onlyIncluded` keeps just those names (null keeps all).
 */
export function groupTables(names: string[], query: string, onlyIncluded: Set<string> | null): TreeCatalog[] {
  const needle = query.trim().toLowerCase();
  const catalogs = new Map<string, Map<string, string[]>>();
  for (const name of new Set(names)) {
    if (onlyIncluded && !onlyIncluded.has(name)) continue;
    if (needle && !name.toLowerCase().includes(needle)) continue;
    const [catalog, schema] = name.split(".");
    let schemas = catalogs.get(catalog);
    if (!schemas) catalogs.set(catalog, (schemas = new Map()));
    let tables = schemas.get(schema);
    if (!tables) schemas.set(schema, (tables = []));
    tables.push(name);
  }
  return [...catalogs]
    .sort(([a], [b]) => byText(a, b))
    .map(([catalog, schemas]) => ({
      catalog,
      schemas: [...schemas].sort(([a], [b]) => byText(a, b)).map(([schema, tables]) => ({ schema, tables: tables.sort(byText) })),
    }));
}

/**
 * The tables to render: those of the open schemas, in order, up to `limit` in all.
 * `truncated` when some open table is left out.
 */
export function visibleTables(catalogs: TreeCatalog[], isOpen: (key: string) => boolean, limit = MAX_SHOWN): { visible: Set<string>; truncated: boolean } {
  const visible = new Set<string>();
  let truncated = false;
  for (const c of catalogs) {
    for (const s of c.schemas) {
      if (!isOpen(`${c.catalog}.${s.schema}`)) continue;
      for (const name of s.tables) {
        if (visible.size < limit) visible.add(name);
        else truncated = true;
      }
    }
  }
  return { visible, truncated };
}
