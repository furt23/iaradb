/** What a task can run, as folders to browse (pure): folders first, then files, each by name. */

export interface TargetFolder {
  folders: Map<string, TargetFolder>;
  files: string[];
  /** targets under it, at any depth */
  count: number;
}

export interface TargetRow {
  /** the folder's path, or the target's */
  path: string;
  name: string;
  depth: number;
  folder: boolean;
  /** folders: targets under it */
  count: number;
}

export function targetTree(targets: string[]): TargetFolder {
  const root: TargetFolder = { folders: new Map(), files: [], count: 0 };
  for (const target of targets) {
    const parts = target.split("/");
    let at = root;
    at.count += 1;
    for (const name of parts.slice(0, -1)) {
      let next = at.folders.get(name);
      if (!next) at.folders.set(name, (next = { folders: new Map(), files: [], count: 0 }));
      next.count += 1;
      at = next;
    }
    at.files.push(parts[parts.length - 1]);
  }
  return root;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { sensitivity: "base" });

/** The rows shown: the top level, and what is in each open folder. */
export function treeRows(root: TargetFolder, open: ReadonlySet<string>): TargetRow[] {
  const rows: TargetRow[] = [];
  const walk = (f: TargetFolder, prefix: string, depth: number) => {
    for (const name of [...f.folders.keys()].sort(byName)) {
      const path = prefix + name;
      const sub = f.folders.get(name)!;
      rows.push({ path, name, depth, folder: true, count: sub.count });
      if (open.has(path)) walk(sub, `${path}/`, depth + 1);
    }
    for (const name of [...f.files].sort(byName)) rows.push({ path: prefix + name, name, depth, folder: false, count: 0 });
  };
  walk(root, "", 0);
  return rows;
}

/** The folders that hold a path, outermost first: what to open to show it. */
export function foldersOf(path: string): string[] {
  const parts = path.split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}
