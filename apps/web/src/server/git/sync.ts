import "server-only";

import { git, GitError } from "./git";
import type { GitAuth } from "./remote";

/**
 * Pull (fast-forward only) and push against `origin`. The remote must already
 * be configured; the url is not checked here (the settings did that), so the
 * tests can point origin at a local bare repository.
 */

function options(auth: GitAuth | null) {
  return { env: { GIT_TERMINAL_PROMPT: "0", ...auth?.env }, secrets: auth?.secrets ?? [] };
}

async function head(): Promise<string | null> {
  const out = (await git(["rev-parse", "--verify", "-q", "HEAD"], [0, 1])).trim();
  return out || null;
}

async function currentBranch(): Promise<string | null> {
  return (await git(["symbolic-ref", "--short", "-q", "HEAD"], [0, 1])).trim() || null;
}

/** Whether `ancestor` is reachable from `descendant`. */
async function isAncestor(ancestor: string, descendant: string): Promise<boolean> {
  return (await git(["merge-base", ancestor, descendant], [0, 1])).trim() === ancestor;
}

export async function pull(branch: string, auth: GitAuth | null = null): Promise<string> {
  const opts = options(auth);
  await git(["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`], [0], opts);
  const remote = (await git(["rev-parse", "--verify", `origin/${branch}`])).trim();
  const local = await head();

  if (!local) {
    // a fresh repository with no commits: take the remote branch as it is
    await git(["checkout", "-q", "-B", branch, `origin/${branch}`]);
    return `Checked out ${branch} at ${remote.slice(0, 7)}`;
  }
  if (local === remote || (await isAncestor(remote, local))) {
    return `Already up to date with origin/${branch}`;
  }
  const current = await currentBranch();
  if (current !== branch) {
    throw new GitError(`the workspace is on ${current ?? "a detached HEAD"}, not ${branch}: switch branches in a terminal first`);
  }
  if (await isAncestor(local, remote)) {
    const count = Number((await git(["rev-list", "--count", `${local}..${remote}`])).trim());
    await git(["merge", "--ff-only", "--quiet", `origin/${branch}`]);
    return `Fast-forwarded ${branch} by ${count} commit${count === 1 ? "" : "s"} to ${remote.slice(0, 7)}`;
  }
  const [behind, ahead] = (await git(["rev-list", "--left-right", "--count", `origin/${branch}...HEAD`])).trim().split(/\s+/).map(Number);
  throw new GitError(
    `cannot fast-forward: ${ahead} local and ${behind} remote commit${behind === 1 ? "" : "s"} diverged from origin/${branch}; merge or rebase in a terminal`,
  );
}

export async function push(branch: string, auth: GitAuth | null = null): Promise<string> {
  const local = await head();
  if (!local) throw new GitError("nothing to push: commit first");
  await git(["push", "--quiet", "origin", `HEAD:refs/heads/${branch}`], [0], options(auth));
  return `Pushed ${local.slice(0, 7)} to origin/${branch}`;
}
