import "server-only";

import { execFile } from "node:child_process";

import { config } from "../config";
import { normalizeRelative } from "../kernel/keys";
import { parseStatus, type GitStatus } from "./status";

export class GitError extends Error {
  name = "GitError";
}

function git(args: string[], allowCodes: number[] = [0]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: config.workspace, maxBuffer: 32 << 20, windowsHide: true }, (err, stdout, stderr) => {
      const code = err ? Number((err as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0;
      if (err && !allowCodes.includes(code)) {
        reject(new GitError((stderr || err.message).trim()));
      } else {
        resolve(stdout);
      }
    });
  });
}

/** Status of the workspace directory (which may be a subdirectory of the
 * repository), with paths relative to the workspace. */
export async function status(): Promise<GitStatus> {
  const prefix = (await git(["rev-parse", "--show-prefix"])).trim();
  const st = parseStatus(await git(["status", "--porcelain=v1", "--branch", "-z", "--untracked-files=all", "--", "."]));
  const strip = (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);
  st.files = st.files.map((f) => ({ ...f, path: strip(f.path), from: f.from && strip(f.from) }));
  return st;
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

export async function commit(message: string, paths: string[]): Promise<string> {
  if (!message.trim()) throw new GitError("a commit message is required");
  if (paths.length === 0) throw new GitError("select files to commit");
  const files = paths.map(normalizeRelative);
  await git(["add", "--all", "--", ...files]);
  await git(["commit", "-m", message, "--", ...files]);
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
