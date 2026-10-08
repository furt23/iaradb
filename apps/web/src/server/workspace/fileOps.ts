import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { copyName, isWithin } from "@/lib/paths";

import { normalizeRelative } from "../kernel/keys";
import { isNotebook, resolveWorkspacePath } from "./files";

/** File-tree operations on the workspace (rename / move, duplicate, folders, delete). */

function guarded(rel: string): string {
  const p = normalizeRelative(rel);
  if (!p) throw new Error("the workspace root cannot be changed");
  if (p.split("/").includes(".git")) throw new Error("Git's own files cannot be changed here");
  return p;
}

async function exists(rel: string): Promise<boolean> {
  return fs.access(resolveWorkspacePath(rel)).then(
    () => true,
    () => false,
  );
}

export async function renameEntry(from: string, to: string): Promise<{ from: string; to: string }> {
  const [a, b] = [guarded(from), guarded(to)];
  if (a === b) return { from: a, to: b };
  if (isWithin(b, a)) throw new Error(`cannot move ${a} into itself`);
  if (await exists(b)) throw new Error(`${b} already exists`);
  const target = resolveWorkspacePath(b);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.rename(resolveWorkspacePath(a), target);
  return { from: a, to: b };
}

/** Copy a file or folder next to itself (`x_copy.py`, `x_copy2.py`, ...). */
export async function duplicateEntry(rel: string): Promise<string> {
  const src = guarded(rel);
  const folder = (await fs.stat(resolveWorkspacePath(src))).isDirectory();
  for (let n = 1; n < 1000; n++) {
    const dst = copyName(src, n, folder);
    if (await exists(dst)) continue;
    await fs.cp(resolveWorkspacePath(src), resolveWorkspacePath(dst), { recursive: true, errorOnExist: true, force: false });
    return dst;
  }
  throw new Error(`too many copies of ${src}`);
}

export async function createFolder(rel: string): Promise<string> {
  const p = guarded(rel);
  if (await exists(p)) throw new Error(`${p} already exists`);
  await fs.mkdir(resolveWorkspacePath(p), { recursive: true });
  return p;
}

export async function deleteEntry(rel: string): Promise<string> {
  const p = guarded(rel);
  await fs.rm(resolveWorkspacePath(p), { recursive: true, force: false });
  return p;
}

export interface EntryInfo {
  path: string;
  folder: boolean;
  /** files inside (1 for a file) */
  files: number;
  /** marimo notebooks among them, by path */
  notebooks: string[];
}

/** What deleting or moving an entry touches. */
export async function entryInfo(rel: string): Promise<EntryInfo> {
  const p = guarded(rel);
  const root = resolveWorkspacePath(p);
  const stat = await fs.stat(root);
  if (!stat.isDirectory()) {
    const nb = p.endsWith(".py") && (await isNotebook(root));
    return { path: p, folder: false, files: 1, notebooks: nb ? [p] : [] };
  }
  const entries = await fs.readdir(root, { recursive: true, withFileTypes: true });
  const files = entries.filter((e) => e.isFile());
  const notebooks: string[] = [];
  for (const f of files) {
    const abs = path.join(f.parentPath, f.name);
    if (f.name.endsWith(".py") && (await isNotebook(abs))) notebooks.push(`${p}/${path.relative(root, abs).replaceAll("\\", "/")}`);
  }
  return { path: p, folder: true, files: files.length, notebooks };
}
