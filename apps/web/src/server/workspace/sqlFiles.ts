import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { normalizeRelative } from "../kernel/keys";
import { exists, readText, resolveWorkspacePath } from "./files";

/** SQL files of the workspace: saved queries, edited and run in the workbench. */

const MAX_SQL_BYTES = 1 << 20;

function sqlPath(rel: string): string {
  const p = normalizeRelative(rel);
  if (!p.toLowerCase().endsWith(".sql")) throw new Error(`${rel} is not a .sql file`);
  if (p.split("/").includes(".git")) throw new Error("Git's own files cannot be changed here");
  return p;
}

export async function readSqlFile(rel: string): Promise<{ path: string; text: string }> {
  const p = sqlPath(rel);
  const { text, truncated } = await readText(p);
  if (truncated) throw new Error(`${p} is larger than 1 MB: open it in an editor`);
  return { path: p, text };
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, text, "utf8");
  try {
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

/** Save an existing SQL file (a file that moved or was deleted meanwhile is not recreated). */
export async function writeSqlFile(rel: string, text: string): Promise<{ path: string }> {
  const p = sqlPath(rel);
  if (Buffer.byteLength(text, "utf8") > MAX_SQL_BYTES) throw new Error("a query file is limited to 1 MB");
  if (!(await exists(p))) throw Object.assign(new Error(`${p} no longer exists`), { type: "NotFound" });
  await writeAtomic(resolveWorkspacePath(p), text);
  return { path: p };
}

export async function createSqlFile(rel: string, text: string): Promise<{ path: string }> {
  const p = sqlPath(rel.trim().toLowerCase().endsWith(".sql") ? rel : `${rel.trim()}.sql`);
  if (await exists(p)) throw new Error(`${p} already exists`);
  const file = resolveWorkspacePath(p);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await writeAtomic(file, text);
  return { path: p };
}
