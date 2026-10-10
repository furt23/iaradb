import { describe, expect, it } from "vitest";

import { withoutData, type TreeNode } from "./fileFilter";

const file = (path: string, kind: string): TreeNode => ({ name: path.split("/").pop()!, path, kind });
const dir = (path: string, children: TreeNode[]): TreeNode => ({ name: path.split("/").pop()!, path, kind: "dir", children });

describe("withoutData", () => {
  const tree = [
    dir("data", [dir("data/tpch", [dir("data/tpch/lineitem", [file("data/tpch/lineitem/part-0.parquet", "data")]), file("data/tpch/orders.parquet", "data")])]),
    dir("notebooks", [file("notebooks/a.py", "notebook"), file("notebooks/sample.csv", "data")]),
    dir("empty", []),
    file("workhouse.toml", "text"),
  ];

  it("drops data files and folders of data only, keeping the rest", () => {
    const { nodes, hidden } = withoutData(tree);
    expect(nodes.map((n) => n.path)).toEqual(["notebooks", "empty", "workhouse.toml"]);
    expect(nodes[0].children!.map((n) => n.path)).toEqual(["notebooks/a.py"]);
    // the data folder (one entry) and the CSV beside the notebook
    expect(hidden).toBe(2);
  });

  it("leaves a tree without data alone", () => {
    const { nodes, hidden } = withoutData([file("a.py", "notebook")]);
    expect(nodes).toHaveLength(1);
    expect(hidden).toBe(0);
  });
});
