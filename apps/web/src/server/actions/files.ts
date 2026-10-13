"use server";

import { requireUser } from "../auth/session";
import { retargetJobs } from "../jobs/files";
import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";
import * as ops from "../workspace/fileOps";

/** The jobs that run what moved follow it; the move itself has happened, so this cannot fail it. */
async function followWithJobs(from: string, to: string): Promise<void> {
  if (from === to) return;
  try {
    await retargetJobs(from, to);
  } catch (e) {
    console.error(`jobs: could not follow ${from} to ${to}: ${(e as Error).message}`);
  }
}

/** Rename or move a file or folder; open notebooks inside keep their kernels, their ids and their jobs. */
export async function renameEntry(from: string, to: string): Promise<ActionResult<{ from: string; to: string }>> {
  return attempt(async () => {
    await requireUser();
    return kernels.exclusive(async () => {
      const moved = await ops.renameEntry(from, to);
      await kernels.moved(moved.from, moved.to);
      await followWithJobs(moved.from, moved.to);
      return moved;
    });
  });
}

export async function duplicateEntry(path: string): Promise<ActionResult<{ path: string }>> {
  return attempt(async () => {
    await requireUser();
    return { path: await ops.duplicateEntry(path) };
  });
}

export async function createFolder(path: string): Promise<ActionResult<{ path: string }>> {
  return attempt(async () => {
    await requireUser();
    return { path: await ops.createFolder(path) };
  });
}

/** Delete a file or folder, stopping the kernels of the notebooks in it. */
export async function deleteEntry(path: string): Promise<ActionResult<{ path: string }>> {
  return attempt(async () => {
    await requireUser();
    return kernels.exclusive(async () => {
      const info = await ops.entryInfo(path);
      kernels.stopWithin(info.path);
      return { path: await ops.deleteEntry(info.path) };
    });
  });
}

export async function entryInfo(path: string): Promise<ActionResult<ops.EntryInfo>> {
  return attempt(async () => {
    await requireUser();
    return ops.entryInfo(path);
  });
}
