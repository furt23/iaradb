"use server";

import type { CellOutput, TableInfo, TableRef } from "@workhouse/protocol";

import { type CatalogSchema, displayName, MAIN_SCHEMA, parseTableName, tableEntry } from "@/lib/catalogToml";

import { kernels } from "../kernel/manager";
import { WORKSPACE_KERNEL } from "../kernel/keys";
import { attempt, type ActionResult } from "../result";
import { addCatalogSchema, catalogSchemas, catalogTables, removeCatalogSchema, removeCatalogTable } from "../workspace/catalog";
import { appendConfigEntry, readConfigText } from "../workspace/sources";

export async function tableInfo(name: string): Promise<ActionResult<TableInfo>> {
  return attempt(() => kernels.workspace().request("catalog.table", { name }));
}

export async function catalogSchema(): Promise<ActionResult<Record<string, { name: string; type: string }[]>>> {
  return attempt(() => kernels.workspace().request("catalog.schema", {}));
}

export async function previewTable(name: string, limit = 200): Promise<ActionResult<CellOutput>> {
  return attempt(() => kernels.workspace().request("catalog.preview", { name, limit }));
}

/** The schemas of workhouse.toml (`main` first). */
export async function listSchemas(): Promise<ActionResult<CatalogSchema[]>> {
  return attempt(() => catalogSchemas());
}

/** `name` is `table` (in main) or `schema.table`; the schema must exist. */
export async function addTable(name: string, path: string, format?: "parquet" | "csv"): Promise<ActionResult<TableRef>> {
  return attempt(async () => {
    const target = parseTableName(name);
    if (!target) throw new Error("table names are letters, digits and underscores, optionally schema.table");
    if (target.schema !== MAIN_SCHEMA && !(await catalogSchemas()).some((s) => s.name === target.schema)) {
      throw new Error(`schema ${target.schema} does not exist: create it first`);
    }
    const display = displayName(target);
    const ref = await kernels.workspace().request("catalog.add", { name: display, path, format, persist: false });
    await appendConfigEntry(tableEntry(display, ref.path, format));
    return { name: display, path: ref.path, format: ref.format };
  });
}

/** A running workspace kernel re-reads workhouse.toml (none is started for it). */
async function syncRunningKernel(): Promise<void> {
  const kernel = kernels.existing(WORKSPACE_KERNEL);
  if (kernel) await kernel.request("workspace.configure", { toml: await readConfigText() });
}

/** Remove a table from workhouse.toml; a running workspace kernel forgets it too. */
export async function removeTable(name: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await removeCatalogTable(name);
    await syncRunningKernel();
    return null;
  });
}

/** Declare a schema in workhouse.toml; a running workspace kernel sees it too. */
export async function createSchema(name: string, description?: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await addCatalogSchema(name.trim(), description?.trim() || null);
    await syncRunningKernel();
    return null;
  });
}

/** Remove an empty schema from workhouse.toml. */
export async function removeSchema(name: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await removeCatalogSchema(name);
    await syncRunningKernel();
    return null;
  });
}

/** workhouse.toml may have changed on disk: its tables, also for a running workspace kernel. */
export async function syncCatalog(): Promise<ActionResult<TableRef[]>> {
  return attempt(async () => {
    await syncRunningKernel();
    return catalogTables();
  });
}
