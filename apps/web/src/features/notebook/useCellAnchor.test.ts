import { beforeEach, describe, expect, it } from "vitest";

import { setFileIds } from "@/features/workbench/fileIdRegistry";

import { cellIdFromHash, cellLink } from "./useCellAnchor";

describe("cellIdFromHash", () => {
  it("reads #cell-<id>", () => {
    expect(cellIdFromHash("#cell-a1b2c3d4")).toBe("a1b2c3d4");
    expect(cellIdFromHash("#cell-setup")).toBe("setup");
    expect(cellIdFromHash("#cell-intro_1-x")).toBe("intro_1-x");
  });

  it("ignores anything else", () => {
    expect(cellIdFromHash("")).toBeNull();
    expect(cellIdFromHash("#top")).toBeNull();
    expect(cellIdFromHash("#cell-")).toBeNull();
    expect(cellIdFromHash('#cell-a"]')).toBeNull();
    expect(cellIdFromHash(`#cell-${"x".repeat(33)}`)).toBeNull();
  });
});

describe("cellLink", () => {
  beforeEach(() => setFileIds({ "notebooks/a.py": "k3j9x0aq" }));

  it("is the file's URL (by id) plus the cell", () => {
    expect(cellLink("notebooks/a.py", "c1d2e3f4", "http://localhost:3870")).toBe("http://localhost:3870/notebooks/k3j9x0aq#cell-c1d2e3f4");
  });

  it("falls back to the path URL while the id is unknown", () => {
    expect(cellLink("notebooks/new.py", "c1d2e3f4", "http://h")).toBe("http://h/notebooks/notebooks/new.py#cell-c1d2e3f4");
  });

  it("round-trips through cellIdFromHash", () => {
    const url = new URL(cellLink("notebooks/a.py", "c1d2e3f4", "http://h"));
    expect(cellIdFromHash(url.hash)).toBe("c1d2e3f4");
  });
});
