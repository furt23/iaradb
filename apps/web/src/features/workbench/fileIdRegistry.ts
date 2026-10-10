import { movedPath } from "@/lib/paths";

/**
 * Notebooks and saved queries are addressed by a stable id in URLs
 * (`/notebooks/<id>`, `/queries/<id>`), not by their path. The server knows
 * the ids; the workbench provider hands them to this registry, which turns
 * paths into URLs and URLs back into paths (pure, module-level).
 */

const ID_PATTERN = /^[a-z0-9]{8}$/;

let idByPath = new Map<string, string>();
let pathById = new Map<string, string>();

/** A URL segment that is a file id (files end in `.py` or `.sql`, so a path is never one). */
export function isFileId(segment: string): boolean {
  return ID_PATTERN.test(segment);
}

/** Replace what is known: `ids` maps each file path to its id. */
export function setFileIds(ids: Record<string, string>): void {
  idByPath = new Map(Object.entries(ids));
  pathById = new Map(Object.entries(ids).map(([path, id]) => [id, path]));
}

/** Learn one file's id (a route that resolved it). */
export function rememberFileId(path: string, id: string): void {
  idByPath.set(path, id);
  pathById.set(id, path);
}

/** A file or folder moved: its files keep their ids under the new paths. */
export function renameFileIds(from: string, to: string): void {
  const moved = [...idByPath].flatMap(([path, id]) => {
    const now = movedPath(path, from, to);
    return now === null ? [] : [{ path, id, now }];
  });
  for (const m of moved) {
    idByPath.delete(m.path);
    pathById.delete(m.id);
  }
  for (const m of moved) rememberFileId(m.now, m.id);
}

export function fileIdOf(path: string): string | null {
  return idByPath.get(path) ?? null;
}

/** Where a file is shown: SQL files under `/queries`, notebooks under `/notebooks`. */
export function fileRoute(path: string): "queries" | "notebooks" {
  return path.toLowerCase().endsWith(".sql") ? "queries" : "notebooks";
}

/** The URL of a file: by id when it is known, else by path (the server redirects it to the id URL). */
export function fileHref(path: string): string {
  const id = idByPath.get(path);
  const rest = id ?? path.split("/").map(encodeURIComponent).join("/");
  return `/${fileRoute(path)}/${rest}`;
}

/** The file a pathname shows (`/notebooks/<id>`, `/queries/<id>` or the older `/…/<path>`), if any. */
export function fileFromPathname(pathname: string): string | null {
  const m = /^\/(?:notebooks|queries)\/(.+)$/.exec(pathname);
  if (!m) return null;
  const parts = m[1].split("/");
  if (parts.length === 1 && isFileId(parts[0])) return pathById.get(parts[0]) ?? null;
  return parts.map(decodeURIComponent).join("/");
}

interface IdNode {
  path: string;
  id?: string;
  children?: IdNode[];
}

/** `{ path: id }` for the notebooks and queries of a file tree. */
export function idsOfTree(nodes: IdNode[]): Record<string, string> {
  return Object.fromEntries(nodes.flatMap((n) => [...(n.id ? [[n.path, n.id]] : []), ...Object.entries(idsOfTree(n.children ?? []))]));
}
