import { describe, expect, it } from "vitest";

import { DAG_NODE, layoutDag } from "./dagLayout";
import { taskOf, type TaskSpec } from "./jobs";

const t = (key: string, dependsOn: string[] = []): TaskSpec => ({ ...taskOf(`${key}.py`, key), dependsOn });

const COL = DAG_NODE.width + DAG_NODE.layerGap;
const ROW = DAG_NODE.height + DAG_NODE.rowGap;

describe("layoutDag", () => {
  it("is empty for no tasks", () => {
    expect(layoutDag([])).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });

  it("puts a chain in a row of layers", () => {
    const layout = layoutDag([t("a"), t("b", ["a"]), t("c", ["b"])]);
    expect(layout.nodes).toEqual([
      { key: "a", layer: 0, index: 0, x: 0, y: 0 },
      { key: "b", layer: 1, index: 0, x: COL, y: 0 },
      { key: "c", layer: 2, index: 0, x: 2 * COL, y: 0 },
    ]);
    expect(layout.edges).toEqual([
      { from: "a", to: "b" },
      { from: "b", to: "c" },
    ]);
    expect(layout.width).toBe(3 * DAG_NODE.width + 2 * DAG_NODE.layerGap);
    expect(layout.height).toBe(DAG_NODE.height);
  });

  it("lays a diamond out with the shorter layers centred", () => {
    const layout = layoutDag([t("a"), t("b", ["a"]), t("c", ["a"]), t("d", ["b", "c"])]);
    const at = (key: string) => layout.nodes.find((n) => n.key === key);
    expect(at("b")).toMatchObject({ layer: 1, index: 0, x: COL, y: 0 });
    expect(at("c")).toMatchObject({ layer: 1, index: 1, x: COL, y: ROW });
    // one box in the last layer, centred between the two above it
    expect(at("d")).toMatchObject({ layer: 2, index: 0, x: 2 * COL, y: ROW / 2 });
    expect(at("a")).toMatchObject({ layer: 0, y: ROW / 2 });
    expect(layout.edges).toEqual([
      { from: "a", to: "b" },
      { from: "a", to: "c" },
      { from: "b", to: "d" },
      { from: "c", to: "d" },
    ]);
    expect(layout.width).toBe(3 * DAG_NODE.width + 2 * DAG_NODE.layerGap);
    expect(layout.height).toBe(2 * DAG_NODE.height + DAG_NODE.rowGap);
  });

  it("puts a task one layer under its deepest upstream task", () => {
    const layout = layoutDag([t("a"), t("b", ["a"]), t("c", ["a", "b"])]);
    expect(layout.nodes.find((n) => n.key === "c")?.layer).toBe(2);
  });

  it("keeps declaration order within a layer", () => {
    const layout = layoutDag([t("root"), t("z", ["root"]), t("m", ["root"]), t("a", ["root"])]);
    expect(layout.nodes.filter((n) => n.layer === 1).map((n) => [n.key, n.index])).toEqual([
      ["z", 0],
      ["m", 1],
      ["a", 2],
    ]);
  });

  it("is the same for the same tasks", () => {
    const tasks = [t("d", ["b", "c"]), t("c", ["a"]), t("b", ["a"]), t("a")];
    expect(layoutDag(tasks)).toEqual(layoutDag(tasks));
  });

  it("gives no position to tasks in a cycle", () => {
    const layout = layoutDag([t("a", ["b"]), t("b", ["a"])]);
    expect(layout).toEqual({ nodes: [], edges: [], width: 0, height: 0 });
  });
});
