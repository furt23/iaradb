import "server-only";

import fs from "node:fs/promises";

import { parse } from "smol-toml";

import { kernelConfig } from "@/lib/catalogConfig";
import { defaultCatalogOf, normalizeCatalogName } from "@/lib/catalogToml";

import { config } from "../config";
import { publishedTables, tableUrl } from "../system/store";
import { TABLES } from "../system/tables";
import { writeAtomic } from "./atomic";
import { catalogRegion, defaultWorkspaceName, readCatalogText, writeCatalogText } from "./catalogStore";
import { resolveWorkspacePath } from "./files";

/**
 * The workspace files the Studio owns and sends to kernels (protocol 2):
 * notebooks, and the catalog (kept by catalogStore, not in the workspace).
 */

export async function readNotebookSource(rel: string): Promise<string> {
  try {
    return await fs.readFile(resolveWorkspacePath(rel), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`notebook ${rel} does not exist`);
    throw e;
  }
}

export async function writeNotebookSource(rel: string, source: string): Promise<void> {
  await writeAtomic(resolveWorkspacePath(rel), source);
}

/** The text of the catalog (`iara.toml`'s format, as stored: no generated settings). */
export function readConfigText(): Promise<string> {
  return readCatalogText();
}

/** Who reads the catalog: the Studio and its local kernels, which reach the team bucket directly, or cluster kernels, which reach it through their machine's proxy. */
export type KernelTarget = "local" | "cluster";

/**
 * The catalog as the kernels read it: the stored text plus the settings generated for the team bucket.
 * Cluster kernels get no storage section for the bucket: their environment sends its requests to the
 * machine's proxy, and the bucket's endpoint is not for their code to read.
 */
export async function kernelConfigText(target: KernelTarget): Promise<string> {
  const published = new Set(await publishedTables());
  return kernelConfig(await readConfigText(), {
    name: defaultWorkspaceName(),
    bucket: config.bucket,
    endpoint: target === "cluster" ? null : config.storageEndpoint,
    region: catalogRegion(),
    system: TABLES.filter((t) => published.has(t.name)).map((t) => ({ name: t.name, path: tableUrl(t.name) })),
  });
}

/** The catalog for `kernel`, wherever it runs. */
export function kernelConfigFor(kernel: { remote: boolean }): Promise<string> {
  return kernelConfigText(kernel.remote ? "cluster" : "local");
}

/** The workspace's name as SQL names its default catalog (`[workspace] name`, normalized); a broken catalog gives `IARA_TEAM` or the folder's name. */
export async function workspaceName(): Promise<string> {
  try {
    return defaultCatalogOf(parse(await kernelConfigText("local")));
  } catch {
    return normalizeCatalogName(defaultWorkspaceName());
  }
}

export function writeConfigText(text: string): Promise<void> {
  return writeCatalogText(text);
}

/** Append a `[tables.x]` or `[schemas.x]` section to the catalog. */
export async function appendConfigEntry(entry: string): Promise<void> {
  await writeConfigText((await readConfigText()) + entry);
}
