import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { clearToken, gitAuth, remoteSettings, saveRemote, storedToken } from "./remote";

const TOKEN = "ghp_SecretTokenValue123";
const REPO_URL = "https://github.com/team/analytics.git";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "workhouse-remote-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("remote settings", () => {
  it("is absent until saved", () => {
    expect(remoteSettings(dir)).toBeNull();
  });

  it("never returns the token", () => {
    saveRemote({ url: REPO_URL, branch: "main", token: TOKEN }, dir);
    const settings = remoteSettings(dir);
    expect(settings).toEqual({ url: REPO_URL, branch: "main", hasToken: true });
    expect(JSON.stringify(settings)).not.toContain(TOKEN);
    expect(storedToken(dir)).toBe(TOKEN);
  });

  it("keeps the stored token when saved with an empty token, and replaces it when given one", () => {
    saveRemote({ url: REPO_URL, branch: "main", token: TOKEN }, dir);
    expect(saveRemote({ url: "https://github.com/team/other.git", branch: "dev", token: "  " }, dir).hasToken).toBe(true);
    expect(storedToken(dir)).toBe(TOKEN);
    saveRemote({ url: REPO_URL, branch: "dev", token: "ghp_new" }, dir);
    expect(storedToken(dir)).toBe("ghp_new");
  });

  it("clears only the token", () => {
    saveRemote({ url: REPO_URL, branch: "release", token: TOKEN }, dir);
    clearToken(dir);
    expect(remoteSettings(dir)).toEqual({ url: REPO_URL, branch: "release", hasToken: false });
    expect(fs.readFileSync(path.join(dir, "git-remote.json"), "utf8")).not.toContain(TOKEN);
  });

  it("validates before saving anything", () => {
    expect(() => saveRemote({ url: "http://github.com/a/b.git", branch: "main" }, dir)).toThrow(/https/);
    expect(() => saveRemote({ url: REPO_URL, branch: "../main" }, dir)).toThrow(/branch/);
    expect(fs.existsSync(path.join(dir, "git-remote.json"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("writes the settings file with mode 0600", () => {
    saveRemote({ url: REPO_URL, branch: "main", token: TOKEN }, dir);
    expect(fs.statSync(path.join(dir, "git-remote.json")).mode & 0o777).toBe(0o600);
  });
});

describe("git authentication", () => {
  it("passes the token only in the environment of git", () => {
    saveRemote({ url: REPO_URL, branch: "main", token: TOKEN }, dir);
    const auth = gitAuth(dir);
    expect(auth?.env.WORKHOUSE_GIT_TOKEN).toBe(TOKEN);
    expect(auth?.env.GIT_ASKPASS).toBe(path.join(dir, process.platform === "win32" ? "git-askpass.cmd" : "git-askpass.sh"));
    expect(auth?.secrets).toEqual([TOKEN]);
    expect(fs.readFileSync(auth!.env.GIT_ASKPASS, "utf8")).not.toContain(TOKEN);
  });

  it("has no credentials without a token", () => {
    saveRemote({ url: REPO_URL, branch: "main" }, dir);
    expect(gitAuth(dir)).toBeNull();
  });

  it.skipIf(process.platform === "win32")("the askpass script answers user name and password prompts", async () => {
    const { execFileSync } = await import("node:child_process");
    saveRemote({ url: REPO_URL, branch: "main", token: TOKEN }, dir);
    const auth = gitAuth(dir)!;
    const ask = (prompt: string) => execFileSync(auth.env.GIT_ASKPASS, [prompt], { env: { ...process.env, ...auth.env }, encoding: "utf8" }).trim();
    expect(ask("Username for 'https://github.com': ")).toBe("x-access-token");
    expect(ask("Password for 'https://x-access-token@github.com': ")).toBe(TOKEN);
  });

  it.skipIf(process.platform !== "win32")("the cmd askpass prints exact values, with shell metacharacters literal", async () => {
    const { execFileSync } = await import("node:child_process");
    const token = "ab&cd|ef<g>h^i_j-k";
    saveRemote({ url: REPO_URL, branch: "main", token }, dir);
    const auth = gitAuth(dir)!;
    const ask = (prompt: string) => execFileSync("cmd.exe", ["/d", "/c", auth.env.GIT_ASKPASS, prompt], { env: { ...process.env, ...auth.env }, encoding: "utf8" });
    expect(ask("Username for 'https://github.com': ")).toBe("x-access-token");
    expect(ask("Password for 'https://x-access-token@github.com': ")).toBe(token);
  });
});
