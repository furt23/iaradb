"use server";

import * as git from "../git/git";
import type { GitStatus } from "../git/status";
import { attempt, type ActionResult } from "../result";

export async function gitStatus(): Promise<ActionResult<GitStatus>> {
  return attempt(() => git.status());
}

export async function gitDiff(path: string): Promise<ActionResult<string>> {
  return attempt(() => git.diff(path));
}

export async function gitCommit(message: string, paths: string[]): Promise<ActionResult<string>> {
  return attempt(() => git.commit(message, paths));
}

export async function gitLog(): Promise<ActionResult<Awaited<ReturnType<typeof git.log>>>> {
  return attempt(() => git.log());
}
