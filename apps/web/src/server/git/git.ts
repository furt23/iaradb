import "server-only";

import { execFile } from "node:child_process";
import path from "node:path";

import { config } from "../config";
import { normalizeRelative } from "../kernel/keys";
import { parseStatus, type GitStatus } from "./status";
import { redact } from "./validate";

export class GitError extends Error {
  name = "GitError";
}

export interface GitOptions {
  /** extra environment for this git process only */
  env?: Record<string, string>;
  /** values to strip from error messages */
  secrets?: string[];
}

export function git(args: string[], allowCodes: number[] = [0], opts: GitOptions = {}): Promise<string> {
  const env = opts.env ? { ...process.env, ...opts.env } : process.env;
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: config.workspace, env, maxBuffer: 32 << 20, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? Number((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
      if (err && !allowCodes.includes(code)) {
        reject(new GitError(redact((stderr || err.message).trim(), opts.secrets ?? [])));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** Status of the workspace directory (which may be a subdirectory of the
 * repository), with paths relative to the workspace. Ahead and behind are
 * counted against `origin/<branch>` when that remote-tracking branch exists. */
export async function status(): Promise<GitStatus> {
  const prefix = (await git(["rev-parse", "--show-prefix"])).trim();
  const st = parseStatus(await git(["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all", "--", "."]));
  const strip = (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);
  st.files = st.files.map((f) => ({ ...f, path: strip(f.path), from: f.from && strip(f.from) }));
  if (st.branch && !st.upstream) {
    const d = await divergence(st.branch).catch(() => null);
    if (d) Object.assign(st, { upstream: `origin/${st.branch}`, ahead: d.ahead, behind: d.behind });
  }
  return st;
}

/** Commits of HEAD ahead of and behind `origin/<branch>`, or null when that branch is not fetched. */
export async function divergence(branch: string): Promise<{ ahead: number; behind: number } | null> {
  const ref = `refs/remotes/origin/${branch}`;
  if (!(await git(["rev-parse", "--verify", "-q", ref], [0, 1])).trim()) return null;
  const counts = (await git(["rev-list", "--left-right", "--count", `${ref}...HEAD`])).trim();
  const [behind, ahead] = counts.split(/\s+/).map(Number);
  return { ahead, behind };
}

/** Unified diff of a path against HEAD (untracked files diff against nothing). */
export async function diff(rel: string): Promise<string> {
  const p = normalizeRelative(rel);
  const tracked = await git(["ls-files", "--", p]);
  if (!tracked.trim()) {
    // Git (Git for Windows too) understands /dev/null here
    return git(["diff", "--no-color", "--no-index", "--", "/dev/null", p], [0, 1]);
  }
  return git(["diff", "--no-color", "HEAD", "--", p], [0, 1]).catch(() => git(["diff", "--no-color", "--cached", "--", p]));
}

export interface Author {
  name: string;
  email: string;
}

const identity = (s: string) => s.replace(/[\r\n<>]/g, "").trim();

/** Commit the selected paths. `author` sets the commit's identity (the signed-in user); without it the local git config applies. */
export async function commit(message: string, paths: string[], author?: Author): Promise<string> {
  if (!message.trim()) throw new GitError("a commit message is required");
  if (paths.length === 0) throw new GitError("select files to commit");
  const files = paths.map(normalizeRelative);
  const as = author?.email ? ["-c", `user.name=${identity(author.name) || identity(author.email)}`, "-c", `user.email=${identity(author.email)}`] : [];
  await git(["add", "--all", "--", ...files]);
  await git([...as, "commit", "-m", message, "--", ...files]);
  return (await git(["rev-parse", "--short", "HEAD"])).trim();
}

export async function log(limit = 20): Promise<{ hash: string; subject: string; author: string; date: string }[]> {
  const out = await git(["log", `-${limit}`, "--pretty=format:%h%x1f%s%x1f%an%x1f%cI", "--", "."], [0, 128]).catch(() => "");
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash, subject, author, date] = line.split("\x1f");
      return { hash, subject, author, date };
    });
}

/** Whether the workspace is inside a Git work tree (its own or a parent's). */
export async function isRepo(): Promise<boolean> {
  const out = await git(["rev-parse", "--is-inside-work-tree"], [0, 128]).catch(() => "");
  return out.trim() === "true";
}

/**
 * Throw when the workspace is inside a repository whose root is a parent
 * directory: setting its remote would change someone else's repository
 * (a workspace in a checkout of this project, for one).
 */
export async function ensureOwnRepo(): Promise<void> {
  if (!(await isRepo())) return;
  const top = (await git(["rev-parse", "--show-toplevel"])).trim();
  const same = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!same(path.resolve(top), path.resolve(config.workspace))) {
    throw new GitError(`the workspace is inside another repository (${top}): a remote can be set only on a workspace that is its own repository`);
  }
}

export async function initRepo(branch: string): Promise<void> {
  await git(["init", "-q", "-b", branch]);
}

/** Point `origin` at the url (added when missing). */
export async function setOrigin(url: string): Promise<void> {
  const names = (await git(["remote"])).split("\n").map((n) => n.trim());
  await git(names.includes("origin") ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url]);
}
