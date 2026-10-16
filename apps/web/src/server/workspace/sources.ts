import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { parse } from "smol-toml";

import { config } from "../config";
import { resolveWorkspacePath } from "./files";

/**
 * The workspace files the Studio owns and sends to kernels (protocol 2):
 * notebooks and `iara.toml`.
 */

export const CONFIG_NAME = "iara.toml";

export async function readNotebookSource(rel: string): Promise<string> {
  try {
    return await fs.readFile(resolveWorkspacePath(rel), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`notebook ${rel} does not exist`);
    throw e;
  }
}

/** Replace a file atomically (a crash never leaves half a notebook). */
async function writeAtomic(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export async function writeNotebookSource(rel: string, source: string): Promise<void> {
  await writeAtomic(resolveWorkspacePath(rel), source);
}

/** The text of `iara.toml` (null when the workspace has none). */
export async function readConfigText(): Promise<string | null> {
  try {
    return await fs.readFile(path.join(config.workspace, CONFIG_NAME), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
}

/** The workspace's name: `[workspace] name` of iara.toml, else its folder's name. */
export async function workspaceName(): Promise<string> {
  try {
    const cfg = parse((await readConfigText()) ?? "") as { workspace?: { name?: unknown } };
    if (typeof cfg.workspace?.name === "string" && cfg.workspace.name) return cfg.workspace.name;
  } catch {
    // a broken file: the folder's name
  }
  return path.basename(config.workspace);
}

export async function writeConfigText(text: string): Promise<void> {
  await writeAtomic(path.join(config.workspace, CONFIG_NAME), text);
}

/** Append a `[tables.x]` section (creating the file with a `[workspace]` header). */
export async function appendConfigEntry(entry: string): Promise<void> {
  const current = await readConfigText();
  const header = `[workspace]\nname = ${JSON.stringify(path.basename(config.workspace))}\n`;
  await writeAtomic(path.join(config.workspace, CONFIG_NAME), (current ?? header) + entry);
}
