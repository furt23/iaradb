import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { config } from "../config";
import { normalizeRelative } from "../kernel/keys";
import { idsFor } from "./fileIds";

export type FileKind = "dir" | "notebook" | "python" | "sql" | "data" | "text" | "other";

export interface FileNode {
  name: string;
  /** workspace-relative, forward slashes */
  path: string;
  kind: FileKind;
  /** stable id of a notebook or SQL file: what its URL names (survives renames) */
  id?: string;
  children?: FileNode[];
}

const IGNORED = new Set([".git", "node_modules", ".venv", "__pycache__", ".iara", ".pytest_cache", ".next", ".ipynb_checkpoints"]);
const MAX_ENTRIES = 3000;
const MAX_DEPTH = 8;
const MAX_TEXT_BYTES = 1 << 20;

/** Absolute path of a workspace-relative one (escapes are refused). */
export function resolveWorkspacePath(rel: string): string {
  const p = path.resolve(config.workspace, normalizeRelative(rel));
  const root = path.resolve(config.workspace);
  if (p !== root && !p.startsWith(root + path.sep)) throw new Error(`path outside the workspace: ${rel}`);
  return p;
}

export async function isNotebook(file: string): Promise<boolean> {
  const handle = await fs.open(file, "r");
  try {
    const buf = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const head = buf.subarray(0, bytesRead).toString("utf8");
    return /^import marimo\b/m.test(head) && head.includes("marimo.App(");
  } finally {
    await handle.close();
  }
}

async function kindOf(file: string, name: string): Promise<FileKind> {
  const ext = path.extname(name).toLowerCase();
  if (ext === ".py") return (await isNotebook(file)) ? "notebook" : "python";
  if (ext === ".sql") return "sql";
  if ([".parquet", ".csv", ".arrow", ".feather", ".json"].includes(ext)) return "data";
  if ([".md", ".txt", ".toml", ".yaml", ".yml", ".cfg", ".ini"].includes(ext)) return "text";
  return "other";
}

async function walk(rel: string, depth: number, budget: { left: number }): Promise<FileNode[]> {
  const dir = resolveWorkspacePath(rel);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
  const out: FileNode[] = [];
  for (const e of entries) {
    if (budget.left-- <= 0) break;
    if (IGNORED.has(e.name) || (e.name.startsWith(".") && e.name !== ".gitignore")) continue;
    // the catalog's text is kept by the Studio (catalogStore): a leftover file at the root is not the workspace's
    if (!rel && e.name === "iara.toml") continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      const children = depth < MAX_DEPTH ? await walk(childRel, depth + 1, budget) : [];
      out.push({ name: e.name, path: childRel, kind: "dir", children });
    } else if (e.isFile()) {
      out.push({ name: e.name, path: childRel, kind: await kindOf(path.join(dir, e.name), e.name) });
    }
  }
  return out;
}

function withIds(nodes: FileNode[]): FileNode[] {
  return nodes.flatMap((n) => (n.kind === "notebook" || n.kind === "sql" ? [n] : n.children ? withIds(n.children) : []));
}

/** The workspace's files; notebooks and SQL files carry their stable `id`. */
export async function listTree(rel = ""): Promise<FileNode[]> {
  const tree = await walk(rel, 0, { left: MAX_ENTRIES });
  const files = withIds(tree);
  try {
    const ids = idsFor(files.map((n) => n.path));
    for (const n of files) n.id = ids[n.path];
  } catch {
    // the id index cannot be kept: files are opened by path (their URLs are redirected later)
  }
  return tree;
}

export async function readText(rel: string): Promise<{ text: string; truncated: boolean }> {
  const file = resolveWorkspacePath(rel);
  const stat = await fs.stat(file);
  const handle = await fs.open(file, "r");
  try {
    const size = Math.min(stat.size, MAX_TEXT_BYTES);
    const buf = Buffer.alloc(size);
    await handle.read(buf, 0, size, 0);
    return { text: buf.toString("utf8"), truncated: stat.size > MAX_TEXT_BYTES };
  } finally {
    await handle.close();
  }
}

export async function exists(rel: string): Promise<boolean> {
  try {
    await fs.access(resolveWorkspacePath(rel));
    return true;
  } catch {
    return false;
  }
}
