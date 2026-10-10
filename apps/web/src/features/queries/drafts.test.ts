import { describe, expect, it } from "vitest";

import { dropDrafts, renameDrafts, type Drafts } from "./drafts";

const d = (text: string) => ({ text, saved: text });

describe("drafts", () => {
  it("follow their files and folders when renamed", () => {
    const drafts: Drafts = new Map([
      ["q/a.sql", d("a")],
      ["q/sub/b.sql", d("b")],
      ["c.sql", d("c")],
    ]);
    renameDrafts(drafts, "q", "queries");
    expect([...drafts.keys()].sort()).toEqual(["c.sql", "queries/a.sql", "queries/sub/b.sql"]);
    renameDrafts(drafts, "c.sql", "d.sql");
    expect(drafts.get("d.sql")?.text).toBe("c");
  });

  it("go with deleted files and folders", () => {
    const drafts: Drafts = new Map([
      ["q/a.sql", d("a")],
      ["qq.sql", d("b")],
    ]);
    dropDrafts(drafts, "q");
    expect([...drafts.keys()]).toEqual(["qq.sql"]);
  });
});
