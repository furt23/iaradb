/**
 * Layout of a tree as boxes on a top-down grid (pure). Leaves take consecutive
 * slots from left to right; a parent sits centered over its first and last
 * child; each depth is one row. Boxes on a row never overlap.
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

export const BOX: BoxSize = { width: 240, height: 96, gapX: 32, gapY: 56 };

/** A node's box; `left` and `top` are its top-left corner. */
export interface Placed<T> {
  /** "0" for the root, "0.2" for the root's third child, and so on */
  id: string;
  node: T;
  depth: number;
  left: number;
  top: number;
}

/** A link from a parent's bottom center to a child's top center. */
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
  const links: Link[] = [];
  const step = size.width + size.gapX;
  const row = size.height + size.gapY;
  let slots = 0;

  /** Places a subtree; returns the node's left edge. */
  const place = (node: T, id: string, depth: number): number => {
    const lefts = node.children.map((child, i) => place(child, `${id}.${i}`, depth + 1));
    const left = lefts.length === 0 ? slots++ * step : (lefts[0] + lefts[lefts.length - 1]) / 2;
    const top = depth * row;
    boxes.push({ id, node, depth, left, top });
    node.children.forEach((_, i) =>
      links.push({ from: id, to: `${id}.${i}`, x1: left + size.width / 2, y1: top + size.height, x2: lefts[i] + size.width / 2, y2: top + row }),
    );
    return left;
  };

  place(root, "0", 0);
  const depth = Math.max(...boxes.map((b) => b.depth));
  return {
    boxes,
    links,
    width: slots * step - size.gapX,
    height: (depth + 1) * size.height + depth * size.gapY,
  };
}
