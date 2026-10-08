"use server";

import type { CellOutput, TableInfo, TableRef } from "@workhouse/protocol";

import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";
import { appendConfigEntry, readConfigText } from "../workspace/sources";

export async function listTables(): Promise<ActionResult<TableRef[]>> {
  return attempt(() => kernels.workspace().request("catalog.list", {}));
}

export async function tableInfo(name: string): Promise<ActionResult<TableInfo>> {
  return attempt(() => kernels.workspace().request("catalog.table", { name }));
}

export async function catalogSchema(): Promise<ActionResult<Record<string, { name: string; type: string }[]>>> {
  return attempt(() => kernels.workspace().request("catalog.schema", {}));
}

export async function previewTable(name: string, limit = 200): Promise<ActionResult<CellOutput>> {
  return attempt(() => kernels.workspace().request("catalog.preview", { name, limit }));
}

export async function addTable(name: string, path: string, format?: "parquet" | "csv"): Promise<ActionResult<TableRef>> {
  return attempt(async () => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error("table names are letters, digits and underscores");
    const { entry, ...ref } = await kernels.workspace().request("catalog.add", { name, path, format, persist: false });
    await appendConfigEntry(entry);
    return ref;
  });
}

/** Re-read workhouse.toml into the workspace kernel. */
export async function reloadCatalog(): Promise<ActionResult<TableRef[]>> {
  return attempt(async () => (await kernels.workspace().request("workspace.configure", { toml: await readConfigText() })).tables);
}
