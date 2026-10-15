import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

// a throwaway repository whose workspace is a subdirectory
const repo = fs.mkdtempSync(path.join(os.tmpdir(), "iara-git-"));
const workspace = path.join(repo, "analytics");
fs.mkdirSync(path.join(workspace, "notebooks"), { recursive: true });
process.env.IARA_WORKSPACE = workspace;

const run = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

describe("git (workspace inside a repository)", () => {
  let git: typeof import("./git");

  beforeAll(async () => {
    run("init", "-q", "-b", "main");
    run("config", "user.email", "studio@example.com");
    run("config", "user.name", "Studio Test");
    fs.writeFileSync(path.join(repo, "outside.txt"), "not part of the workspace\n");
    fs.writeFileSync(path.join(workspace, "notebooks", "a.py"), "print('a')\n");
    git = await import("./git");
  });

  it("reports only workspace files, relative to the workspace", async () => {
    const st = await git.status();
    expect(st.branch).toBe("main");
    expect(st.files.map((f) => f.path)).toEqual(["notebooks/a.py"]);
  });

  it("diffs untracked files against nothing", async () => {
    expect(await git.diff("notebooks/a.py")).toContain("+print('a')");
  });

  it("commits the selected files and shows the change afterwards", async () => {
    const hash = await git.commit("add notebook a", ["notebooks/a.py"]);
    expect(hash).toMatch(/^[0-9a-f]{7,}$/);
    expect((await git.status()).files).toEqual([]);
    expect((await git.log())[0].subject).toBe("add notebook a");
    fs.writeFileSync(path.join(workspace, "notebooks", "a.py"), "print('b')\n");
    const diff = await git.diff("notebooks/a.py");
    expect(diff).toContain("-print('a')");
    expect(diff).toContain("+print('b')");
    expect(run("status", "--porcelain")).toContain("?? outside.txt"); // untouched
  });

  it("refuses empty messages and paths outside the workspace", async () => {
    await expect(git.commit("  ", ["notebooks/a.py"])).rejects.toThrow(/message/);
    await expect(git.commit("x", ["../outside.txt"])).rejects.toThrow();
  });
});
