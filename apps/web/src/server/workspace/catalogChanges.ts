import "server-only";

import type { CatalogChange } from "@workhouse/protocol";

import { removeSchemaSection, removeTableSection } from "@/lib/catalogToml";

import { WORKSPACE_KERNEL } from "../kernel/keys";
import { kernels } from "../kernel/manager";
import type { KernelClient } from "../kernel/client";
import { readConfigText, workspaceName, writeConfigText } from "./sources";

function appendEntry(text: string, entry: string | null): string {
  if (!entry) return text;
  return `${text.replace(/\s*$/, "\n")}${entry}`;
}

/** `text` with the change's section replaced by its entry (or removed). */
function withChange(text: string, change: CatalogChange): string {
  if (change.kind !== "schema") return appendEntry(removeTableSection(text, change.name) ?? text, change.entry);
  const declared = removeSchemaSection(text, change.name);
  // CREATE SCHEMA IF NOT EXISTS on a declared schema keeps its description
  if (change.entry && declared !== null) return text;
  return appendEntry(declared ?? text, change.entry);
}

/**
 * Apply what a run's statements did to the catalog (`CREATE TABLE ... AS`,
 * `DROP TABLE`, `CREATE SCHEMA`, `DROP SCHEMA`) to workhouse.toml, which the
 * Studio owns; the workspace kernel (catalog, SQL editor) re-reads it unless
 * it made the changes.
 */
export async function applyCatalogChanges(changes: CatalogChange[], from: KernelClient | null): Promise<void> {
  if (!changes.length) return;
  const toml = await kernels.exclusive(async () => {
    let text = (await readConfigText()) ?? `[workspace]\nname = ${JSON.stringify(await workspaceName())}\n`;
    for (const c of changes) text = withChange(text, c);
    await writeConfigText(text);
    return text;
  });
  const workspace = kernels.existing(WORKSPACE_KERNEL);
  if (workspace && workspace !== from) await workspace.request("workspace.configure", { toml });
}
