/** Workspace-relative paths (forward slashes), shared by client and server (pure). */

export function baseName(rel: string): string {
  return rel.slice(rel.lastIndexOf("/") + 1);
}

export function parentOf(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i < 0 ? "" : rel.slice(0, i);
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** `path` itself or something inside the folder `dir`. */
export function isWithin(path: string, dir: string): boolean {
  return path === dir || path.startsWith(`${dir}/`);
}

/** Where `path` ends up when `from` (a file or folder) moves to `to`; null if unaffected. */
export function movedPath(path: string, from: string, to: string): string | null {
  if (path === from) return to;
  return path.startsWith(`${from}/`) ? to + path.slice(from.length) : null;
}

/** The `n`th name for a copy: `a/b.py` -> `a/b_copy.py`, `a/b_copy2.py`; folders `a/x_copy`. */
export function copyName(rel: string, n: number, isFolder: boolean): string {
  const suffix = n <= 1 ? "_copy" : `_copy${n}`;
  const name = baseName(rel);
  const dot = isFolder ? -1 : name.lastIndexOf(".");
  const copy = dot > 0 ? `${name.slice(0, dot)}${suffix}${name.slice(dot)}` : `${name}${suffix}`;
  return joinPath(parentOf(rel), copy);
}

/** A file or folder name: no separators, no `.`/`..`, nothing a filesystem rejects. */
export function nameError(name: string): string | null {
  if (!name.trim()) return "the name is empty";
  if (/[\\/:*?"<>|]/.test(name)) return 'a name cannot contain \\ / : * ? " < > |';
  if (name === "." || name === "..") return "invalid name";
  return null;
}
