import type { SQLNamespace } from "@codemirror/lang-sql";

/**
 * The completion namespace of the catalog (pure). A table is named by a path of
 * names: `t`, `s.t` (default catalog), `c.s.t` (another catalog); `main.t` is `t`.
 * A name a path goes through is a namespace (an object), the last name of a path
 * completes the table's columns. A namespace wins a name clash with a table.
 */
export function sqlNamespace(tables: Record<string, { name: string }[]>): SQLNamespace {
  const root: NamespaceNode = {};
  for (const [name, columns] of Object.entries(tables)) {
    const parts = name.split(".");
    const path = parts.length === 2 && parts[0] === "main" ? parts.slice(1) : parts;
    place(root, path, columns.map((c) => c.name));
  }
  return root as SQLNamespace;
}

type NamespaceNode = { [name: string]: NamespaceNode | string[] };

function isNode(v: NamespaceNode | string[] | undefined): v is NamespaceNode {
  return v !== undefined && !Array.isArray(v);
}

/** Put a table's columns at its path, creating the namespaces on the way. */
function place(node: NamespaceNode, path: string[], columns: string[]): void {
  const [head, ...rest] = path;
  const current = node[head];
  if (rest.length === 0) {
    if (!isNode(current)) node[head] = columns;
    return;
  }
  const child = isNode(current) ? current : {};
  node[head] = child;
  place(child, rest, columns);
}
