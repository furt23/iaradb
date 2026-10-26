/**
 * Layout of a tree as boxes on a grid (pure), drawn the way the rows flow: the
 * deepest nodes (the scans) on top, the root at the bottom. Leaves take
 * consecutive slots from left to right; a parent sits centered under its first
 * and last child; each depth is one row. Boxes on a row never overlap.
 */

/** A tree node: its children are nodes of the same type. */
export interface TreeNode<T = unknown> {
  children: T[];
}

export interface BoxSize {
  width: number;
  height: number;
  /** between boxes on a row */
  gapX: number;
  /** between rows */
  gapY: number;
}

export const BOX: BoxSize = { width: 220, height: 76, gapX: 20, gapY: 36 };

/** A node's box; `left` and `top` are its top-left corner. */
export interface Placed<T> {
  /** "0" for the root, "0.2" for the root's third child, and so on */
  id: string;
  node: T;
  depth: number;
  left: number;
  top: number;
}

/** A link from a child's bottom center to its parent's top center: the way its rows go. */
export interface Link {
  from: string;
  to: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface TreeLayout<T> {
  boxes: Placed<T>[];
  links: Link[];
  width: number;
  height: number;
}

export function layoutTree<T extends TreeNode<T>>(root: T, size: BoxSize = BOX): TreeLayout<T> {
  const boxes: Placed<T>[] = [];
  const edges: [child: string, parent: string][] = [];
  const step = size.width + size.gapX;
  const row = size.height + size.gapY;
  let slots = 0;

  /** Places a subtree; returns the node's left edge. */
  const place = (node: T, id: string, depth: number): number => {
    const lefts = node.children.map((child, i) => place(child, `${id}.${i}`, depth + 1));
    const left = lefts.length === 0 ? slots++ * step : (lefts[0] + lefts[lefts.length - 1]) / 2;
    boxes.push({ id, node, depth, left, top: 0 });
    node.children.forEach((_, i) => edges.push([`${id}.${i}`, id]));
    return left;
  };

  place(root, "0", 0);
  const depth = Math.max(...boxes.map((b) => b.depth));
  for (const b of boxes) b.top = (depth - b.depth) * row;
  const at = new Map(boxes.map((b) => [b.id, b]));
  const links = edges.map(([from, to]): Link => {
    const child = at.get(from) as Placed<T>;
    const parent = at.get(to) as Placed<T>;
    return { from, to, x1: child.left + size.width / 2, y1: child.top + size.height, x2: parent.left + size.width / 2, y2: parent.top };
  });
  return {
    boxes,
    links,
    width: slots * step - size.gapX,
    height: (depth + 1) * size.height + depth * size.gapY,
  };
}
