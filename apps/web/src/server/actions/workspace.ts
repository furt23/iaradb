"use server";

import type { KernelInfo } from "@workhouse/protocol";

import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";
import { listTree, readText, type FileNode } from "../workspace/files";

export async function workspaceTree(): Promise<ActionResult<FileNode[]>> {
  return attempt(() => listTree());
}

export async function workspaceInfo(): Promise<ActionResult<KernelInfo>> {
  return attempt(() => kernels.workspace().request("workspace.info", {}));
}

export async function readWorkspaceFile(path: string): Promise<ActionResult<{ text: string; truncated: boolean }>> {
  return attempt(() => readText(path));
}
