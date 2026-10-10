import { describe, expect, it } from "vitest";

import type { FileNode } from "@/server/workspace/files";

import { moveTargets } from "./moveTargets";

const tree: FileNode[] = [
  {
    name: "notebooks",
    path: "notebooks",
    kind: "dir",
    children: [
      { name: "tour.py", path: "notebooks/tour.py", kind: "notebook" },
      { name: "archive", path: "notebooks/archive", kind: "dir", children: [{ name: "old.py", path: "notebooks/archive/old.py", kind: "python" }] },
    ],
  },
  { name: "queries", path: "queries", kind: "dir", children: [] },
  { name: "top.sql", path: "top.sql", kind: "sql" },
];

describe("moveTargets", () => {
  it("lists the root and every folder, depth first", () => {
    expect(moveTargets(tree, "notebooks/tour.py")).toEqual(["", "notebooks/archive", "queries"]);
  });

  it("leaves out the folder the entry is in (the root too, for a file there)", () => {
    expect(moveTargets(tree, "notebooks/archive/old.py")).toEqual(["", "notebooks", "queries"]);
    expect(moveTargets(tree, "top.sql")).toEqual(["notebooks", "notebooks/archive", "queries"]);
    expect(moveTargets([], "top.sql")).toEqual([]);
  });
});
