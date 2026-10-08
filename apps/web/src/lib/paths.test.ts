import { describe, expect, it } from "vitest";

import { copyName, isWithin, movedPath, nameError, parentOf } from "./paths";

describe("paths", () => {
  it("moves files and the contents of folders", () => {
    expect(movedPath("nb/a.py", "nb/a.py", "nb/b.py")).toBe("nb/b.py");
    expect(movedPath("nb/sub/a.py", "nb/sub", "old/sub")).toBe("old/sub/a.py");
    expect(movedPath("nb/subway/a.py", "nb/sub", "x")).toBeNull();
    expect(isWithin("nb/sub", "nb/sub") && isWithin("nb/sub/x", "nb/sub") && !isWithin("nb/subx", "nb/sub")).toBe(true);
  });

  it("names copies next to the original", () => {
    expect(copyName("notebooks/tour.py", 1, false)).toBe("notebooks/tour_copy.py");
    expect(copyName("notebooks/tour.py", 3, false)).toBe("notebooks/tour_copy3.py");
    expect(copyName("data/raw", 1, true)).toBe("data/raw_copy");
    expect(copyName(".gitignore", 1, false)).toBe(".gitignore_copy");
    expect(parentOf("a.py")).toBe("");
  });

  it("rejects names a filesystem would not take", () => {
    expect(nameError("ok name.py")).toBeNull();
    expect(nameError("a/b")).toMatch(/cannot contain/);
    expect(nameError("..")).toMatch(/invalid/);
    expect(nameError(" ")).toMatch(/empty/);
  });
});
