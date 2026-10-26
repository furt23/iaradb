import "server-only";

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { IaraMemory } from "@/lib/iara/protocol";

import type { StudioUser } from "../auth/access";
import { dataDir } from "../compute/store";
import { writeAtomic } from "../workspace/atomic";
import { iaraDir } from "./paths";

/**
 * What Iara remembers about a user: one JSON array per user, oldest first.
 * Changes to one user's file run one at a time, so two saves at once both land.
 */

export const MAX_MEMORIES = 100;
export const MAX_MEMORY_TEXT = 500;

const queues = new Map<string, Promise<unknown>>();

/** Runs `fn` after the earlier changes to `file` have finished. */
function inOrder<T>(file: string, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(file) ?? Promise.resolve()).then(fn);
  queues.set(file, run.catch(() => {}));
  return run;
}

const fileOf = (user: StudioUser, root: string) => path.join(iaraDir(user, root), "memories.json");

async function readAll(file: string): Promise<IaraMemory[]> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as IaraMemory[];
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return [];
    throw e;
  }
}

const save = (file: string, memories: IaraMemory[]) => writeAtomic(file, JSON.stringify(memories, null, 2));

/** The memory's text, trimmed; it must be 1 to MAX_MEMORY_TEXT characters. */
function cleanText(text: string): string {
  const clean = text.trim();
  if (clean.length < 1 || clean.length > MAX_MEMORY_TEXT) throw new Error(`a memory is 1 to ${MAX_MEMORY_TEXT} characters`);
  return clean;
}

/** How two memories' texts are compared for "the same": trimmed and lowercased. */
const sameKey = (text: string) => text.trim().toLowerCase();

/** The memories, oldest first; none when Iara has saved nothing for the user. */
export function listMemories(user: StudioUser, root = dataDir()): Promise<IaraMemory[]> {
  return readAll(fileOf(user, root));
}

/** Saves a memory; the same text again returns the one already saved. */
export async function addMemory(user: StudioUser, text: string, root = dataDir()): Promise<IaraMemory> {
  const clean = cleanText(text);
  const file = fileOf(user, root);
  return inOrder(file, async () => {
    const memories = await readAll(file);
    const same = memories.find((m) => sameKey(m.text) === sameKey(clean));
    if (same) return same;
    if (memories.length >= MAX_MEMORIES) throw new Error(`Iara remembers at most ${MAX_MEMORIES} things: forget one first`);
    const memory = { id: crypto.randomUUID(), text: clean, created: Date.now() };
    await save(file, [...memories, memory]);
    return memory;
  });
}

/** Changes a memory's text, keeping its id and when it was saved. */
export async function updateMemory(user: StudioUser, id: string, text: string, root = dataDir()): Promise<IaraMemory> {
  const clean = cleanText(text);
  const file = fileOf(user, root);
  return inOrder(file, async () => {
    const memories = await readAll(file);
    const i = memories.findIndex((m) => m.id === id);
    if (i < 0) throw new Error("there is no such memory");
    memories[i] = { ...memories[i], text: clean };
    await save(file, memories);
    return memories[i];
  });
}

/** Forgets a memory; returns it, or null when there is no such one. */
export async function removeMemory(user: StudioUser, id: string, root = dataDir()): Promise<IaraMemory | null> {
  const file = fileOf(user, root);
  return inOrder(file, async () => {
    const memories = await readAll(file);
    const removed = memories.find((m) => m.id === id);
    if (!removed) return null;
    await save(file, memories.filter((m) => m.id !== id));
    return removed;
  });
}
