import { beforeEach, describe, expect, it } from "vitest";

import { fileFromPathname, fileHref, fileIdOf, fileRoute, idsOfTree, isFileId, rememberFileId, renameFileIds, setFileIds } from "./fileIdRegistry";

beforeEach(() => {
  setFileIds({ "notebooks/a.py": "k3j9x0aq", "queries/q.sql": "zz00yy11", "notebooks/sub/b.py": "ab12cd34" });
});

describe("fileHref", () => {
  it("uses the id when it is known", () => {
    expect(fileHref("notebooks/a.py")).toBe("/notebooks/k3j9x0aq");
    expect(fileHref("queries/q.sql")).toBe("/queries/zz00yy11");
    expect(fileHref("QUERIES/Q.SQL")).toMatch(/^\/queries\//);
  });

  it("falls back to the encoded path for a file without a known id", () => {
    expect(fileHref("notebooks/new one.py")).toBe("/notebooks/notebooks/new%20one.py");
    expect(fileHref("q/x.sql")).toBe("/queries/q/x.sql");
  });
});

describe("fileFromPathname", () => {
  it("reads an id URL", () => {
    expect(fileFromPathname("/notebooks/k3j9x0aq")).toBe("notebooks/a.py");
    expect(fileFromPathname("/queries/zz00yy11")).toBe("queries/q.sql");
  });

  it("is null for an id nobody knows", () => {
    expect(fileFromPathname("/notebooks/nope1234")).toBeNull();
  });

  it("still understands path URLs", () => {
    expect(fileFromPathname("/notebooks/notebooks/sub/b.py")).toBe("notebooks/sub/b.py");
    expect(fileFromPathname("/queries/queries/my%20q.sql")).toBe("queries/my q.sql");
    // a file in the root named like an id is still a path (it has an extension)
    expect(fileFromPathname("/notebooks/abcdefgh.py")).toBe("abcdefgh.py");
  });

  it("is null outside the workbench routes", () => {
    expect(fileFromPathname("/notebooks")).toBeNull();
    expect(fileFromPathname("/jobs/k3j9x0aq")).toBeNull();
  });

  it("round-trips with fileHref", () => {
    for (const p of ["notebooks/a.py", "queries/q.sql", "notebooks/unknown file.py"]) expect(fileFromPathname(fileHref(p))).toBe(p);
  });
});

describe("renaming", () => {
  it("keeps the id of a renamed file, so its URL stays the same", () => {
    const before = fileHref("notebooks/a.py");
    renameFileIds("notebooks/a.py", "notebooks/renamed.py");
    expect(fileHref("notebooks/renamed.py")).toBe(before);
    expect(fileFromPathname(before)).toBe("notebooks/renamed.py");
    expect(fileIdOf("notebooks/a.py")).toBeNull();
  });

  it("moves the files of a folder", () => {
    renameFileIds("notebooks", "archive");
    expect(fileFromPathname("/notebooks/ab12cd34")).toBe("archive/sub/b.py");
    expect(fileFromPathname("/notebooks/k3j9x0aq")).toBe("archive/a.py");
    expect(fileIdOf("queries/q.sql")).toBe("zz00yy11");
  });

  it("does not confuse names that merely start alike", () => {
    renameFileIds("notebooks/a", "x");
    expect(fileIdOf("notebooks/a.py")).toBe("k3j9x0aq");
  });
});

describe("rememberFileId", () => {
  it("learns an id the server resolved", () => {
    rememberFileId("notebooks/c.py", "newid123");
    expect(fileFromPathname("/notebooks/newid123")).toBe("notebooks/c.py");
    expect(fileHref("notebooks/c.py")).toBe("/notebooks/newid123");
  });
});

describe("helpers", () => {
  it("recognizes ids", () => {
    expect(isFileId("k3j9x0aq")).toBe(true);
    expect(isFileId("K3J9X0AQ")).toBe(false);
    expect(isFileId("short")).toBe(false);
    expect(isFileId("a.py")).toBe(false);
  });

  it("routes by extension", () => {
    expect(fileRoute("a/b.sql")).toBe("queries");
    expect(fileRoute("a/b.py")).toBe("notebooks");
  });

  it("collects the ids of a tree", () => {
    const tree = [
      { path: "notebooks", children: [{ path: "notebooks/a.py", id: "k3j9x0aq" }, { path: "notebooks/data.csv" }] },
      { path: "q.sql", id: "zz00yy11" },
    ];
    expect(idsOfTree(tree)).toEqual({ "notebooks/a.py": "k3j9x0aq", "q.sql": "zz00yy11" });
  });
});
