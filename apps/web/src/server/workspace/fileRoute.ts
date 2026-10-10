import "server-only";

import fs from "node:fs/promises";

import { redirect } from "next/navigation";

import { fileRoute, isFileId } from "@/features/workbench/fileIdRegistry";

import { normalizeRelative } from "../kernel/keys";
import { idsFor, pathOf } from "./fileIds";
import { resolveWorkspacePath } from "./files";

export interface RoutedFile {
  id: string;
  path: string;
}

async function isFile(rel: string): Promise<boolean> {
  try {
    return (await fs.stat(resolveWorkspacePath(rel))).isFile();
  } catch {
    return false;
  }
}

/** The workspace path a path-style URL names (null: not a notebook or SQL file of the workspace). */
function pathFromSegments(segments: string[]): string | null {
  try {
    const rel = normalizeRelative(segments.map(decodeURIComponent).join("/"));
    return /\.(py|sql)$/i.test(rel) ? rel : null;
  } catch {
    return null;
  }
}

/**
 * The file a `/notebooks/…` or `/queries/…` URL names. An id URL resolves to
 * its file; a path URL (older links, files the page does not know the id of
 * yet) redirects to the id URL, assigning an id to the file if it has none.
 * Null: there is no such file.
 */
export async function resolveFileRoute(route: "notebooks" | "queries", segments: string[]): Promise<RoutedFile | null> {
  if (segments.length === 1 && isFileId(segments[0])) {
    const id = segments[0];
    const path = pathOf(id);
    if (!path || !(await isFile(path))) return null;
    if (fileRoute(path) !== route) redirect(`/${fileRoute(path)}/${id}`);
    return { id, path };
  }
  const path = pathFromSegments(segments);
  if (!path || !(await isFile(path))) return null;
  return redirect(`/${fileRoute(path)}/${idsFor([path])[path]}`);
}
