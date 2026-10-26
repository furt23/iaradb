import "server-only";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { IaraMessage, IaraProposal, IaraSurface, IaraThreadSummary, IaraThreadView, IaraUsage } from "@/lib/iara/protocol";

import type { StudioUser } from "../auth/access";
import { dataDir } from "../compute/store";
import { writeAtomic } from "../workspace/atomic";
import { iaraDir, SAFE_ID } from "./paths";
import type { Step } from "./state";
import { CONTEXT_BUDGET } from "./tokens";

/**
 * Iara's conversations: one JSON file per conversation in the user's folder.
 * The panel lists them by file and shows their messages; the history is what
 * the model sees on the next turn.
 */

export interface ThreadRecord extends IaraThreadSummary {
  messages: IaraMessage[];
  /** Iara's conversation with the model */
  history: Step[];
  /** older turns, summarized when the history outgrew the budget */
  summary: string | null;
  /** what the analyst found in this conversation, the latest last (the next turns' agents start from it) */
  findings: string[];
  usage: IaraUsage;
  /** the last turn stopped at a proposal: its LangGraph turn id and the proposal */
  pending: { turn: string; proposal: IaraProposal } | null;
}

const NO_THREAD = "there is no such conversation";

/** The file of a conversation; an id that is not a safe file name names none. */
function threadFile(user: StudioUser, id: string, root: string): string {
  if (!SAFE_ID.test(id)) throw new Error(NO_THREAD);
  return path.join(iaraDir(user, root), "threads", `${id}.json`);
}

const summaryOf = (t: ThreadRecord): IaraThreadSummary => ({ id: t.id, fileId: t.fileId, surface: t.surface, title: t.title, updated: t.updated });

/** A new, empty conversation about a file, saved before it is returned. */
export function createThread(user: StudioUser, fileId: string, surface: IaraSurface, root = dataDir()): Promise<ThreadRecord> {
  return saveThread(
    user,
    {
      id: crypto.randomUUID(),
      fileId,
      surface,
      title: "",
      updated: Date.now(),
      messages: [],
      history: [],
      summary: null,
      findings: [],
      usage: { context: 0, budget: CONTEXT_BUDGET, turnInput: 0, turnOutput: 0 },
      pending: null,
    },
    root,
  );
}

/** The conversation with this id, if it is this user's. */
export async function readThread(user: StudioUser, id: string, root = dataDir()): Promise<ThreadRecord> {
  const file = threadFile(user, id, root);
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as ThreadRecord;
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") throw new Error(NO_THREAD);
    throw e;
  }
}

/** Saves the conversation, stamped with now, and returns it. */
export async function saveThread(user: StudioUser, thread: ThreadRecord, root = dataDir()): Promise<ThreadRecord> {
  thread.updated = Date.now();
  await writeAtomic(threadFile(user, thread.id, root), JSON.stringify(thread, null, 2));
  return thread;
}

/** The conversations, newest first; only those of one file when `fileId` is given. Unreadable files are left out. */
export async function listThreads(user: StudioUser, fileId: string | null, root = dataDir()): Promise<IaraThreadSummary[]> {
  // shortcut: reads every conversation file; keep an index when users have hundreds
  const dir = path.join(iaraDir(user, root), "threads");
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return [];
    throw e;
  }
  const threads: ThreadRecord[] = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    try {
      threads.push(JSON.parse(await fs.readFile(path.join(dir, name), "utf8")) as ThreadRecord);
    } catch {
      // left out of the list
    }
  }
  return threads
    .filter((t) => fileId === null || t.fileId === fileId)
    .sort((a, b) => b.updated - a.updated)
    .map(summaryOf);
}

/** Deletes a conversation; a missing one is fine, an invalid id is not. */
export async function removeThread(user: StudioUser, id: string, root = dataDir()): Promise<void> {
  await fs.rm(threadFile(user, id, root), { force: true });
}

/** What the panel shows: the messages, the proposal waiting for the user and the usage, not the model's history. */
export function threadView(t: ThreadRecord): IaraThreadView {
  return { ...summaryOf(t), messages: t.messages, pending: t.pending?.proposal ?? null, usage: t.usage };
}
