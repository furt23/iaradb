import "server-only";

import type { CatalogChange } from "@iara/protocol";

import { schemaDisplayName, withChange } from "@/lib/catalogToml";

import { WORKSPACE_KERNEL } from "../kernel/keys";
import { kernels } from "../kernel/manager";
import type { KernelClient } from "../kernel/client";
import { catalogSchemas, defaultCatalog } from "./catalog";
import { invalidateDiscovery } from "./discovery";
import { kernelConfigFor, readConfigText, writeConfigText } from "./sources";

/** A schema's location got new data: its listing is read again (the catalog is not touched). */
async function invalidateSchemas(names: string[]): Promise<void> {
  try {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    const d = await defaultCatalog();
    const places = (await catalogSchemas()).filter((s) => s.location && wanted.has(schemaDisplayName(s, d)));
    if (places.length) for (const s of places) invalidateDiscovery(s.location);
    else invalidateDiscovery();
  } catch {
    invalidateDiscovery();
  }
}

/**
 * Apply what a run's statements did to the catalog (`CREATE TABLE ... AS`,
 * `DROP TABLE`, `CREATE SCHEMA`, `DROP SCHEMA`, `CREATE CATALOG`, ...) to the catalog
 * the Studio stores; the workspace kernel (catalog, SQL editor) re-reads it unless
 * it made the changes.
 */
export async function applyCatalogChanges(all: CatalogChange[], from: KernelClient | null): Promise<void> {
  const refreshed = all.filter((c) => c.kind === "refresh");
  if (refreshed.length) await invalidateSchemas(refreshed.map((c) => c.name));
  const changes = all.filter((c) => c.kind !== "refresh");
  if (!changes.length) return;
  await kernels.exclusive(async () => {
    let text = await readConfigText();
    for (const c of changes) text = withChange(text, c);
    await writeConfigText(text);
  });
  const workspace = kernels.existing(WORKSPACE_KERNEL);
  if (workspace && workspace !== from) await workspace.request("workspace.configure", { toml: await kernelConfigFor(workspace) });
}
