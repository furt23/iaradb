"use server";

import type { KernelInfo } from "@iara/protocol";

import { requireUser } from "../auth/session";
import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";
import { listTree, readText, type FileNode } from "../workspace/files";

export async function workspaceTree(): Promise<ActionResult<FileNode[]>> {
  return attempt(async () => {
    await requireUser();
    return listTree();
  });
}

export async function workspaceInfo(): Promise<ActionResult<KernelInfo>> {
  return attempt(async () => {
    await requireUser();
    return kernels.workspace().request("workspace.info", {});
  });
}

export async function readWorkspaceFile(path: string): Promise<ActionResult<{ text: string; truncated: boolean }>> {
  return attempt(async () => {
    await requireUser();
    return readText(path);
  });
}
