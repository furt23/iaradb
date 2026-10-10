/** The workspace tree without its datasets (pure): data lives in the Data section. */

export interface TreeNode {
  name: string;
  path: string;
  kind: string;
  children?: TreeNode[];
}

/**
 * The tree without data files, nor folders that held only data; `hidden`
 * counts the entries dropped at the top of each removed branch.
 */
export function withoutData<T extends TreeNode>(nodes: T[]): { nodes: T[]; hidden: number } {
  let hidden = 0;
  const walk = (list: T[]): T[] =>
    list.flatMap((n) => {
      if (n.kind === "data") {
        hidden++;
        return [];
      }
      if (n.kind !== "dir" || !n.children?.length) return [n];
      const before = hidden;
      const children = walk(n.children as T[]);
      if (children.length) return [{ ...n, children }];
      // a folder of data only goes as one entry
      hidden = before + 1;
      return [];
    });
  return { nodes: walk(nodes), hidden };
}
