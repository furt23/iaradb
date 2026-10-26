import { describe, expect, it } from "vitest";

import { BOX, layoutTree, type Placed, type TreeNode } from "./layout";

interface Named extends TreeNode<Named> {
  name: string;
}

const node = (name: string, ...children: Named[]): Named => ({ name, children });
const step = BOX.width + BOX.gapX;
const row = BOX.height + BOX.gapY;

function find(boxes: Placed<Named>[], name: string): Placed<Named> {
  const found = boxes.find((b) => b.node.name === name);
  if (!found) throw new Error(`no box ${name}`);
  return found;
}

describe("layoutTree", () => {
  it("places a single box at the origin", () => {
    const l = layoutTree(node("scan"));
    expect(l.boxes).toEqual([{ id: "0", node: node("scan"), depth: 0, left: 0, top: 0 }]);
    expect(l.links).toEqual([]);
    expect([l.width, l.height]).toEqual([BOX.width, BOX.height]);
  });

  it("puts leaves side by side and centers a parent under its children", () => {
    const l = layoutTree(node("join", node("probe"), node("build")));
    expect(find(l.boxes, "probe")).toMatchObject({ left: 0, top: 0 });
    expect(find(l.boxes, "build")).toMatchObject({ left: step, top: 0 });
    expect(find(l.boxes, "join")).toMatchObject({ left: step / 2, top: row });
  });

  it("draws the deepest nodes on top and the root on the bottom row", () => {
    // root -> [a -> [a1], b]: a1 on top, a and b on the middle row
    const l = layoutTree(node("root", node("a", node("a1")), node("b")));
    expect(find(l.boxes, "a1").top).toBe(0);
    expect(find(l.boxes, "a").top).toBe(row);
    expect(find(l.boxes, "b").top).toBe(row);
    expect(find(l.boxes, "root").top).toBe(2 * row);
  });

  it("gives leaves consecutive slots in order, whatever their depth", () => {
    // root -> [a -> [a1, a2], b]
    const l = layoutTree(node("root", node("a", node("a1"), node("a2")), node("b")));
    expect(find(l.boxes, "a1").left).toBe(0);
    expect(find(l.boxes, "a2").left).toBe(step);
    expect(find(l.boxes, "b").left).toBe(2 * step);
    expect(find(l.boxes, "a").left).toBe(step / 2);
    expect(find(l.boxes, "root").left).toBe((step / 2 + 2 * step) / 2);
  });

  it("gives every box a path id", () => {
    const l = layoutTree(node("root", node("a", node("a1")), node("b")));
    expect(l.boxes.map((b) => b.id).sort()).toEqual(["0", "0.0", "0.0.0", "0.1"]);
    expect(find(l.boxes, "a1").depth).toBe(2);
  });

  it("links each child's bottom to its parent's top", () => {
    const l = layoutTree(node("join", node("probe"), node("build")));
    expect(l.links).toEqual([
      { from: "0.0", to: "0", x1: BOX.width / 2, y1: BOX.height, x2: step / 2 + BOX.width / 2, y2: row },
      { from: "0.1", to: "0", x1: step + BOX.width / 2, y1: BOX.height, x2: step / 2 + BOX.width / 2, y2: row },
    ]);
  });

  it("has one link per child, so links = boxes - 1", () => {
    const l = layoutTree(node("r", node("a", node("a1"), node("a2"), node("a3")), node("b", node("b1")), node("c")));
    expect(l.links).toHaveLength(l.boxes.length - 1);
  });

  it("sizes the canvas to its boxes", () => {
    const l = layoutTree(node("root", node("a", node("a1")), node("b")));
    expect(l.width).toBe(2 * step - BOX.gapX);
    expect(l.height).toBe(3 * BOX.height + 2 * BOX.gapY);
  });

  it("never overlaps boxes on the same row", () => {
    const l = layoutTree(node("r", node("a", node("a1"), node("a2"), node("a3")), node("b", node("b1")), node("c")));
    for (const x of l.boxes) {
      for (const y of l.boxes) {
        if (x !== y && x.top === y.top) expect(x.left + BOX.width <= y.left || y.left + BOX.width <= x.left).toBe(true);
      }
    }
  });
});
