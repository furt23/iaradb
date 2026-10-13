"use server";

import { requireUser } from "../auth/session";
import * as git from "../git/git";
import { GitError } from "../git/git";
import { clearToken, gitAuth, remoteSettings, saveRemote, storedToken } from "../git/remote";
import type { GitStatus } from "../git/status";
import { pull, push } from "../git/sync";
import { redact } from "../git/validate";
import { attempt, type ActionResult } from "../result";

/** The team's remote as the client may see it: never the token itself. */
export interface GitRemoteSettings {
  url: string;
  branch: string;
  hasToken: boolean;
  /** the workspace is inside a Git repository */
  repo: boolean;
}

/** `attempt`, with the stored token (and any token sent in) removed from error messages. */
async function secured<T>(fn: () => Promise<T>, sent: string[] = []): Promise<ActionResult<T>> {
  const result = await attempt(fn);
  if (result.ok) return result;
  const secrets = [storedToken(), ...sent];
  return { ok: false, error: { ...result.error, message: redact(result.error.message, secrets) } };
}

async function remoteState(): Promise<GitRemoteSettings> {
  const saved = remoteSettings();
  return { url: saved?.url ?? "", branch: saved?.branch ?? "main", hasToken: saved?.hasToken ?? false, repo: await git.isRepo() };
}

function connectedRemote() {
  const saved = remoteSettings();
  if (!saved) throw new GitError("connect a repository first");
  return saved;
}

export async function gitStatus(): Promise<ActionResult<GitStatus>> {
  return attempt(async () => {
    await requireUser();
    return git.status();
  });
}

export async function gitDiff(path: string): Promise<ActionResult<string>> {
  return attempt(async () => {
    await requireUser();
    return git.diff(path);
  });
}

export async function gitCommit(message: string, paths: string[]): Promise<ActionResult<string>> {
  return attempt(async () => {
    const user = await requireUser();
    return git.commit(message, paths, user.email ? { name: user.name, email: user.email } : undefined);
  });
}

export async function gitLog(): Promise<ActionResult<Awaited<ReturnType<typeof git.log>>>> {
  return attempt(async () => {
    await requireUser();
    return git.log();
  });
}

export async function gitRemoteSettings(): Promise<ActionResult<GitRemoteSettings>> {
  return secured(async () => {
    await requireUser();
    return remoteState();
  });
}

/** Validate and save the remote; initializes the workspace repository when there is none. */
export async function gitSaveRemote(input: { url: string; branch: string; token?: string }): Promise<ActionResult<GitRemoteSettings>> {
  return secured(
    async () => {
      await requireUser();
      await git.ensureOwnRepo();
      const saved = saveRemote(input);
      if (!(await git.isRepo())) await git.initRepo(saved.branch);
      await git.setOrigin(saved.url);
      return { ...saved, repo: true };
    },
    [input.token ?? ""],
  );
}

export async function gitClearToken(): Promise<ActionResult<GitRemoteSettings>> {
  return secured(async () => {
    await requireUser();
    clearToken();
    return remoteState();
  });
}

/** Fetch and fast-forward the branch from origin. */
export async function gitPull(): Promise<ActionResult<string>> {
  return secured(async () => {
    await requireUser();
    const saved = connectedRemote();
    await git.ensureOwnRepo();
    await git.setOrigin(saved.url);
    return pull(saved.branch, gitAuth());
  });
}

/** Push HEAD to the branch on origin. */
export async function gitPush(): Promise<ActionResult<string>> {
  return secured(async () => {
    await requireUser();
    const saved = connectedRemote();
    await git.ensureOwnRepo();
    await git.setOrigin(saved.url);
    return push(saved.branch, gitAuth());
  });
}
