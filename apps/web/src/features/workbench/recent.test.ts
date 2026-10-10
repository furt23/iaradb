import { describe, expect, it } from "vitest";

import { dropRecent, MAX_RECENT, parseRecent, renameRecent, touchRecent } from "./recent";

describe("recent files", () => {
  it("keeps the most recent first, without duplicates, up to a limit", () => {
    let r: string[] = [];
    for (const p of ["a.py", "b.py", "a.py"]) r = touchRecent(r, p);
    expect(r).toEqual(["a.py", "b.py"]);
    for (let i = 0; i < 20; i++) r = touchRecent(r, `n${i}.py`);
    expect(r).toHaveLength(MAX_RECENT);
    expect(r[0]).toBe("n19.py");
    expect(touchRecent(r, "n19.py")).toBe(r);
  });

  it("follows renames and forgets deleted files", () => {
    const r = ["nb/a.py", "nb/sub/b.py", "c.sql"];
    expect(renameRecent(r, "nb", "notebooks")).toEqual(["notebooks/a.py", "notebooks/sub/b.py", "c.sql"]);
    expect(dropRecent(r, "nb/sub")).toEqual(["nb/a.py", "c.sql"]);
  });

  it("restores stored lists defensively", () => {
    expect(parseRecent(["a", 1, "a", "b"])).toEqual(["a", "b"]);
    expect(parseRecent("a")).toEqual([]);
  });
});
