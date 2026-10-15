import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// the workspace is a fresh directory with no repository of its own
const root = fs.mkdtempSync(path.join(os.tmpdir(), "iara-sync-"));
const workspace = path.join(root, "ws");
fs.mkdirSync(workspace);
process.env.IARA_WORKSPACE = workspace;

const bare = path.join(root, "remote.git");
const other = path.join(root, "other");
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const ws = (...args: string[]) => sh(workspace, ...args);
const oth = (...args: string[]) => sh(other, ...args);

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe("pull and push against a bare repository", () => {
  let git: typeof import("./git");
  let sync: typeof import("./sync");

  beforeAll(async () => {
    sh(root, "init", "-q", "--bare", "-b", "main", bare);
    fs.mkdirSync(other);
    oth("init", "-q", "-b", "main");
    oth("config", "user.email", "team@example.com");
    oth("config", "user.name", "Team");
    oth("config", "core.autocrlf", "false");
    fs.writeFileSync(path.join(other, "a.txt"), "one\n");
    oth("add", "a.txt");
    oth("commit", "-q", "-m", "first");
    oth("push", "-q", bare, "HEAD:refs/heads/main");
    git = await import("./git");
    sync = await import("./sync");
  });

  it("initializes an empty workspace from the remote branch on the first pull", async () => {
    await git.initRepo("main");
    ws("config", "core.autocrlf", "false");
    await git.setOrigin(bare);
    expect(await git.isRepo()).toBe(true);
    expect(await sync.pull("main")).toMatch(/^Checked out main at [0-9a-f]{7}$/);
    expect(fs.readFileSync(path.join(workspace, "a.txt"), "utf8")).toBe("one\n");
  });

  it("fast-forwards when the remote has new commits", async () => {
    fs.writeFileSync(path.join(other, "a.txt"), "two\n");
    oth("commit", "-q", "-am", "second");
    oth("push", "-q", bare, "HEAD:refs/heads/main");
    expect(await sync.pull("main")).toBe(`Fast-forwarded main by 1 commit to ${oth("rev-parse", "--short", "HEAD")}`);
    expect(fs.readFileSync(path.join(workspace, "a.txt"), "utf8")).toBe("two\n");
    expect(await sync.pull("main")).toBe("Already up to date with origin/main");
  });

  it("commits as the given author and pushes HEAD to the branch", async () => {
    fs.writeFileSync(path.join(workspace, "b.py"), "print('b')\n");
    const hash = await git.commit("add b", ["b.py"], { name: "Ada Lovelace", email: "ada@example.com" });
    expect(ws("log", "-1", "--format=%an <%ae>")).toBe("Ada Lovelace <ada@example.com>");
    expect(await sync.push("main")).toBe(`Pushed ${hash} to origin/main`);
    expect(sh(root, "--git-dir", bare, "log", "-1", "--format=%s", "main")).toBe("add b");
    expect((await git.status()).upstream).toBe("origin/main");
    expect((await git.status()).ahead).toBe(0);
  });

  it("reports ahead and behind against origin/<branch>", async () => {
    oth("pull", "-q", "--ff-only", bare, "main");
    fs.writeFileSync(path.join(workspace, "c.py"), "local\n");
    await git.commit("local change", ["c.py"], { name: "Ada", email: "ada@example.com" });
    fs.writeFileSync(path.join(other, "remote.txt"), "remote\n");
    oth("add", "remote.txt");
    oth("commit", "-q", "-m", "remote change");
    oth("push", "-q", bare, "HEAD:refs/heads/main");
    await sync.pull("main").catch(() => undefined); // fetches origin/main; diverged, so it refuses
    const st = await git.status();
    expect({ ahead: st.ahead, behind: st.behind }).toEqual({ ahead: 1, behind: 1 });
  });

  it("refuses to pull when the branches diverged, without merging", async () => {
    await expect(sync.pull("main")).rejects.toThrow(/cannot fast-forward: 1 local and 1 remote commit diverged/);
    expect(fs.existsSync(path.join(workspace, "remote.txt"))).toBe(false);
  });

  it("refuses to pull into a workspace on another branch", async () => {
    oth("push", "-q", bare, "HEAD:refs/heads/release");
    await expect(sync.pull("release")).rejects.toThrow(/the workspace is on main, not release/);
  });
});
