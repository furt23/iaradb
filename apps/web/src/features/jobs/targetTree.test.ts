import { describe, expect, it } from "vitest";

import { foldersOf, targetTree, treeRows } from "./targetTree";

const targets = ["queries/b.sql", "notebooks/etl/load.py", "notebooks/a.py", "top.sql", "notebooks/etl/Clean.py"];
const shown = (open: string[]) => treeRows(targetTree(targets), new Set(open)).map((r) => `${"  ".repeat(r.depth)}${r.name}${r.folder ? `/ (${r.count})` : ""}`);

describe("targetTree", () => {
  it("shows the top level closed: folders first with their counts, then files", () => {
    expect(shown([])).toEqual(["notebooks/ (3)", "queries/ (1)", "top.sql"]);
  });

  it("shows what is in open folders, by name whatever the case", () => {
    expect(shown(["notebooks", "notebooks/etl"])).toEqual(["notebooks/ (3)", "  etl/ (2)", "    Clean.py", "    load.py", "  a.py", "queries/ (1)", "top.sql"]);
    // a folder inside a closed one stays hidden
    expect(shown(["notebooks/etl"])).toEqual(["notebooks/ (3)", "queries/ (1)", "top.sql"]);
  });

  it("keeps the full path of each row", () => {
    expect(treeRows(targetTree(targets), new Set(["notebooks", "notebooks/etl"])).filter((r) => !r.folder).map((r) => r.path)).toEqual([
      "notebooks/etl/Clean.py",
      "notebooks/etl/load.py",
      "notebooks/a.py",
      "top.sql",
    ]);
  });

  it("knows the folders to open to show a path", () => {
    expect(foldersOf("notebooks/etl/load.py")).toEqual(["notebooks", "notebooks/etl"]);
    expect(foldersOf("top.sql")).toEqual([]);
  });
});
