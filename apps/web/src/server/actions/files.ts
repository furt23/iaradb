"use server";

import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";
import * as ops from "../workspace/fileOps";

/** Rename or move a file or folder; open notebooks inside keep their kernels. */
export async function renameEntry(from: string, to: string): Promise<ActionResult<{ from: string; to: string }>> {
  return attempt(() =>
    kernels.exclusive(async () => {
      const moved = await ops.renameEntry(from, to);
      await kernels.moved(moved.from, moved.to);
      return moved;
    }),
  );
}

export async function duplicateEntry(path: string): Promise<ActionResult<{ path: string }>> {
  return attempt(async () => ({ path: await ops.duplicateEntry(path) }));
}

export async function createFolder(path: string): Promise<ActionResult<{ path: string }>> {
  return attempt(async () => ({ path: await ops.createFolder(path) }));
}

/** Delete a file or folder, stopping the kernels of the notebooks in it. */
export async function deleteEntry(path: string): Promise<ActionResult<{ path: string }>> {
  return attempt(() =>
    kernels.exclusive(async () => {
      const info = await ops.entryInfo(path);
      kernels.stopWithin(info.path);
      return { path: await ops.deleteEntry(info.path) };
    }),
  );
}

export async function entryInfo(path: string): Promise<ActionResult<ops.EntryInfo>> {
  return attempt(() => ops.entryInfo(path));
}
