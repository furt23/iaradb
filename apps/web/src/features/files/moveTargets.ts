import { parentOf } from "@/lib/paths";
import type { FileNode } from "@/server/workspace/files";

/** Every folder of the tree, depth first. */
function folders(nodes: FileNode[]): string[] {
  return nodes.flatMap((n) => (n.kind === "dir" ? [n.path, ...folders(n.children ?? [])] : []));
}

/** The folders an entry at `path` can move into: the root ("") and every folder, but its own folder (pure). */
export function moveTargets(tree: FileNode[], path: string): string[] {
  return ["", ...folders(tree)].filter((folder) => folder !== parentOf(path));
}
