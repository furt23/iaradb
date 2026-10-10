import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { diskIdFiles, FileIds, randomId, type IdFiles } from "./fileIds";

function memoryFiles(): IdFiles & { text: string | null; writes: number } {
  const f = {
    text: null as string | null,
    writes: 0,
    read: () => f.text,
    write: (t: string) => {
      f.text = t;
      f.writes++;
    },
  };
  return f;
}

/** ids "id000001", "id000002", ... */
function counter(): () => string {
  let n = 0;
  return () => `id${String(++n).padStart(6, "0")}`;
}

const ROOT = "/work/space";

describe("idsFor", () => {
  it("assigns an id to each new path and keeps it afterwards", () => {
    const files = memoryFiles();
    const ids = new FileIds(ROOT, files, counter());
    expect(ids.idsFor(["a.py", "q/b.sql"])).toEqual({ "a.py": "id000001", "q/b.sql": "id000002" });
    expect(ids.idsFor(["q/b.sql", "c.py", "a.py"])).toEqual({ "q/b.sql": "id000002", "c.py": "id000003", "a.py": "id000001" });
  });

  it("writes only when something is new", () => {
    const files = memoryFiles();
    const ids = new FileIds(ROOT, files, counter());
    ids.idsFor(["a.py"]);
    ids.idsFor(["a.py"]);
    expect(files.writes).toBe(1);
  });

  it("survives a restart (a new instance on the same file)", () => {
    const files = memoryFiles();
    new FileIds(ROOT, files, counter()).idsFor(["a.py"]);
    expect(new FileIds(ROOT, files, counter()).idsFor(["a.py"])).toEqual({ "a.py": "id000001" });
  });

  it("skips an id that is taken", () => {
    const ids = new FileIds(ROOT, memoryFiles(), ((seq) => () => seq.shift() as string)(["same0001", "same0001", "same0002"]));
    expect(ids.idsFor(["a.py", "b.py"])).toEqual({ "a.py": "same0001", "b.py": "same0002" });
  });

  it("keeps workspaces apart", () => {
    const files = memoryFiles();
    new FileIds("/one", files, counter()).idsFor(["a.py"]);
    const two = new FileIds("/two", files, counter());
    expect(two.idsFor(["b.py"])).toEqual({ "b.py": "id000001" });
    expect(two.pathOf("id000001")).toBe("b.py");
    expect(new FileIds("/one", files, counter()).pathOf("id000001")).toBe("a.py");
  });

  it("starts over when the file is not valid JSON", () => {
    const files = memoryFiles();
    files.text = "{ not json";
    expect(new FileIds(ROOT, files, counter()).idsFor(["a.py"])).toEqual({ "a.py": "id000001" });
  });
});

describe("pathOf", () => {
  it("finds the path of an id", () => {
    const ids = new FileIds(ROOT, memoryFiles(), counter());
    const { "a.py": id } = ids.idsFor(["a.py"]);
    expect(ids.pathOf(id)).toBe("a.py");
  });

  it("is null for unknown or malformed ids", () => {
    const ids = new FileIds(ROOT, memoryFiles(), counter());
    ids.idsFor(["a.py"]);
    expect(ids.pathOf("zzzzzzzz")).toBeNull();
    expect(ids.pathOf("a.py")).toBeNull();
    expect(ids.pathOf("__proto__")).toBeNull();
  });
});

describe("moved", () => {
  it("keeps the id of a renamed file", () => {
    const ids = new FileIds(ROOT, memoryFiles(), counter());
    const before = ids.idsFor(["a.py", "b.py"]);
    ids.moved("a.py", "z/renamed.py");
    expect(ids.idsFor(["z/renamed.py", "b.py"])).toEqual({ "z/renamed.py": before["a.py"], "b.py": before["b.py"] });
    expect(ids.pathOf(before["a.py"])).toBe("z/renamed.py");
  });

  it("keeps the ids of the files of a moved folder", () => {
    const ids = new FileIds(ROOT, memoryFiles(), counter());
    const before = ids.idsFor(["d/a.py", "d/sub/q.sql", "dd/c.py"]);
    ids.moved("d", "e/f");
    expect(ids.idsFor(["e/f/a.py", "e/f/sub/q.sql", "dd/c.py"])).toEqual({
      "e/f/a.py": before["d/a.py"],
      "e/f/sub/q.sql": before["d/sub/q.sql"],
      "dd/c.py": before["dd/c.py"],
    });
  });

  it("drops a stale id at the destination", () => {
    const ids = new FileIds(ROOT, memoryFiles(), counter());
    const before = ids.idsFor(["old.py", "new.py"]);
    ids.moved("old.py", "new.py");
    expect(ids.pathOf(before["old.py"])).toBe("new.py");
    expect(ids.pathOf(before["new.py"])).toBeNull();
  });

  it("does not write when nothing is affected", () => {
    const files = memoryFiles();
    const ids = new FileIds(ROOT, files, counter());
    ids.idsFor(["a.py"]);
    ids.moved("other.py", "x.py");
    expect(files.writes).toBe(1);
  });
});

describe("removed", () => {
  it("forgets a deleted file or folder", () => {
    const ids = new FileIds(ROOT, memoryFiles(), counter());
    const before = ids.idsFor(["a.py", "d/b.py", "d/e/c.sql", "dd.py"]);
    ids.removed("a.py");
    ids.removed("d");
    expect(ids.pathOf(before["a.py"])).toBeNull();
    expect(ids.pathOf(before["d/b.py"])).toBeNull();
    expect(ids.pathOf(before["d/e/c.sql"])).toBeNull();
    expect(ids.pathOf(before["dd.py"])).toBe("dd.py");
  });
});

describe("randomId", () => {
  it("is 8 characters of a-z and 0-9", () => {
    for (let i = 0; i < 50; i++) expect(randomId()).toMatch(/^[a-z0-9]{8}$/);
    expect(new Set(Array.from({ length: 50 }, randomId)).size).toBe(50);
  });
});

describe("diskIdFiles", () => {
  it("writes atomically to a file it creates", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-ids-"));
    try {
      const file = path.join(dir, "nested", "file-ids.json");
      const files = diskIdFiles(file);
      expect(files.read()).toBeNull();
      files.write('{"a":1}');
      expect(files.read()).toBe('{"a":1}');
      expect(fs.readdirSync(path.dirname(file))).toEqual(["file-ids.json"]);
      expect(new FileIds(ROOT, files).idsFor(["a.py"])["a.py"]).toMatch(/^[a-z0-9]{8}$/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
