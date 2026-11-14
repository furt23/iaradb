"use server";

import type { CellOutput, DeltaCommit, TableInfo, TableRef } from "@iara/protocol";

import { SYSTEM_CATALOG } from "@/lib/catalogConfig";
import { type CatalogInfo, type CatalogSchema, displayName, inCatalog, parseTableName, tableEntry, withCatalogNames } from "@/lib/catalogToml";

import { requireUser } from "../auth/session";
import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";
import {
  addCatalog,
  addCatalogSchema,
  catalogList,
  catalogSchemas,
  catalogTables,
  defaultCatalog,
  removeCatalog as dropCatalog,
  removeCatalogSchema,
  removeCatalogTable,
} from "../workspace/catalog";
import { syncWorkspaceKernel } from "../workspace/catalogChanges";
import { reloadCatalog } from "../workspace/catalogStore";
import { invalidateDiscovery } from "../workspace/discovery";
import { appendConfigEntry } from "../workspace/sources";

export async function tableInfo(name: string): Promise<ActionResult<TableInfo>> {
  return attempt(async () => {
    await requireUser();
    return kernels.metadata("catalog.table", { name });
  });
}

export async function tableHistory(name: string, limit = 100): Promise<ActionResult<DeltaCommit[]>> {
  return attempt(async () => {
    await requireUser();
    return kernels.metadata("catalog.history", { table: name, limit });
  });
}

/** The columns of every table, under its display name and, for the default catalog's tables, its full name too (for SQL completion). */
export async function catalogSchema(): Promise<ActionResult<Record<string, { name: string; type: string }[]>>> {
  return attempt(async () => {
    await requireUser();
    const columns = await kernels.metadata("catalog.schema", {});
    return withCatalogNames(columns, await defaultCatalog());
  });
}

export async function previewTable(name: string, limit = 200): Promise<ActionResult<CellOutput>> {
  return attempt(async () => {
    await requireUser();
    return kernels.workspace().request("catalog.preview", { name, limit });
  });
}

/** The catalogs of the workspace: the default one first, then the others by name. */
export async function listCatalogs(): Promise<ActionResult<CatalogInfo[]>> {
  return attempt(async () => {
    await requireUser();
    return catalogList();
  });
}

/** The schemas of the catalog (`catalog`: the default one when none is given), `main` first. */
export async function listSchemas(catalog?: string): Promise<ActionResult<CatalogSchema[]>> {
  return attempt(async () => {
    await requireUser();
    return catalogSchemas(catalog?.trim().toLowerCase() || (await defaultCatalog()));
  });
}

/**
 * `name` is `table` or `schema.table` in `catalog` (the default catalog when none is
 * given); the schema must exist. The table is named `catalog.schema.table` in another catalog.
 */
export async function addTable(
  name: string,
  path: string,
  format?: "parquet" | "csv" | "json",
  catalog?: string,
): Promise<ActionResult<TableRef>> {
  return attempt(async () => {
    await requireUser();
    const d = await defaultCatalog();
    const c = catalog?.trim().toLowerCase() || d;
    const target = parseTableName(c === d ? name : inCatalog(name, c), d);
    if (!target) throw new Error("table names are letters, digits and underscores, optionally schema.table");
    const schemas = await catalogSchemas(target.catalog);
    if (!schemas.length) throw new Error(`catalog ${target.catalog} does not exist`);
    if (!schemas.some((s) => s.name === target.schema)) throw new Error(`schema ${target.schema} does not exist: create it first`);
    const display = displayName(target, d);
    const ref = await kernels.workspace().request("catalog.add", { name: display, path, format, persist: false });
    await kernels.exclusive(() => appendConfigEntry(tableEntry(name, ref.path, format, c === d ? undefined : c)));
    return { name: display, path: ref.path, format: ref.format, catalog: target.catalog, full: ref.full };
  });
}

// catalog edits go through kernels.exclusive, as catalog changes from runs and jobs do: no edit is lost

/** Remove a table from the catalog; a running workspace kernel forgets it too. */
export async function removeTable(name: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    await kernels.exclusive(() => removeCatalogTable(name));
    await syncWorkspaceKernel();
    return null;
  });
}

/** Declare a catalog; a running workspace kernel sees it too. */
export async function createCatalog(name: string, description?: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    if (name.trim().toLowerCase() === SYSTEM_CATALOG) throw new Error("system is the Studio's own catalog: pick another name");
    await kernels.exclusive(() => addCatalog(name.trim(), description?.trim() || null));
    await syncWorkspaceKernel();
    return null;
  });
}

/** Remove an empty catalog (no tables, no schemas besides main) from the catalog. */
export async function removeCatalog(name: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    await kernels.exclusive(() => dropCatalog(name));
    await syncWorkspaceKernel();
    return null;
  });
}

/** Declare a schema in a catalog (`catalog`: the default one when none is given); a running workspace kernel sees it too. */
export async function createSchema(name: string, description?: string, location?: string, catalog?: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    const target = catalog?.trim().toLowerCase() || (await defaultCatalog());
    await kernels.exclusive(() => addCatalogSchema(target, name.trim(), description?.trim() || null, location?.trim() || null));
    await syncWorkspaceKernel();
    return null;
  });
}

/** Remove an empty schema from the catalog: `name` is `schema`, or `catalog.schema` in another catalog. */
export async function removeSchema(name: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    await kernels.exclusive(() => removeCatalogSchema(name));
    await syncWorkspaceKernel();
    return null;
  });
}

/** Read the catalog and the schema locations again (the listing is cached for 30 s). */
export async function refreshCatalog(): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    reloadCatalog();
    invalidateDiscovery();
    return null;
  });
}

/** The catalog may have changed in the store: its tables, also for a running workspace kernel. */
export async function syncCatalog(): Promise<ActionResult<TableRef[]>> {
  return attempt(async () => {
    await requireUser();
    reloadCatalog();
    await syncWorkspaceKernel();
    return catalogTables();
  });
}
