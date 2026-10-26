"use server";

import type { IaraMemory, IaraThreadSummary, IaraThreadView } from "@/lib/iara/protocol";

import { requireUser } from "../auth/session";
import { iaraSaver } from "../iara/checkpointer";
import { addMemory, listMemories, removeMemory, updateMemory } from "../iara/memory";
import { listThreads, readThread, removeThread, threadView } from "../iara/threads";
import { isBusy } from "../iara/turn";
import { attempt, type ActionResult } from "../result";

/** Arguments come from the browser: anything that is not text is refused. */
function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new Error(`${what} is text`);
  return value;
}

/** The user's conversations about a file, newest first. */
export async function listIaraThreadsAction(fileId: string): Promise<ActionResult<IaraThreadSummary[]>> {
  return attempt(async () => {
    const user = await requireUser();
    return listThreads(user, text(fileId, "the file"));
  });
}

/** A conversation with its messages and the proposal waiting for the user, if any. */
export async function readIaraThreadAction(id: string): Promise<ActionResult<IaraThreadView>> {
  return attempt(async () => {
    const user = await requireUser();
    return threadView(await readThread(user, text(id, "the conversation")));
  });
}

/** Deletes a conversation, and the turn waiting for its decision. */
export async function deleteIaraThreadAction(id: string): Promise<ActionResult<void>> {
  return attempt(async () => {
    const user = await requireUser();
    const threadId = text(id, "the conversation");
    if (isBusy(threadId)) throw new Error("Iara is still answering in this conversation");
    const thread = await readThread(user, threadId).catch(() => null);
    if (thread?.pending) await iaraSaver().deleteThread(`${thread.id}.${thread.pending.turn}`);
    await removeThread(user, threadId);
  });
}

/** What Iara remembers about the user. */
export async function listIaraMemoriesAction(): Promise<ActionResult<IaraMemory[]>> {
  return attempt(async () => listMemories(await requireUser()));
}

export async function addIaraMemoryAction(value: string): Promise<ActionResult<IaraMemory>> {
  return attempt(async () => addMemory(await requireUser(), text(value, "the memory")));
}

export async function updateIaraMemoryAction(id: string, value: string): Promise<ActionResult<IaraMemory>> {
  return attempt(async () => updateMemory(await requireUser(), text(id, "the memory"), text(value, "the memory")));
}

export async function deleteIaraMemoryAction(id: string): Promise<ActionResult<void>> {
  return attempt(async () => {
    await removeMemory(await requireUser(), text(id, "the memory"));
  });
}
