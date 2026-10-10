import { describe, expect, it } from "vitest";

import { section, sectionOf } from "./sections";

describe("sections", () => {
  it("maps routes to sections", () => {
    expect(sectionOf("/")).toBe("workspace");
    expect(sectionOf("/notebooks")).toBe("workspace");
    expect(sectionOf("/notebooks/a/b.py")).toBe("workspace");
    expect(sectionOf("/queries/q.sql")).toBe("workspace");
    expect(sectionOf("/files/x.txt")).toBe("workspace");
    expect(sectionOf("/data")).toBe("data");
    expect(sectionOf("/data/lineitem")).toBe("data");
    expect(sectionOf("/sql")).toBe("sql");
    expect(sectionOf("/history")).toBe("history");
    expect(sectionOf("/analyze")).toBe("history");
    expect(sectionOf("/analyze/k3j9x0qz")).toBe("history");
    expect(sectionOf("/compute")).toBe("compute");
    // a prefix, not a substring
    expect(sectionOf("/database")).toBe("workspace");
  });

  it("gives the files panel to the workspace and the catalog to data", () => {
    expect(section("workspace").panel).toBe("files");
    expect(section("data").panel).toBe("catalog");
    expect(section("git").panel).toBeNull();
  });
});
