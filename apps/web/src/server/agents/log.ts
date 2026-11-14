import "server-only";

import fs from "node:fs/promises";
import path from "node:path";

import { AGENT_ID } from "@/lib/agents/check";
import type { AgentLogEntry, AgentRating } from "@/lib/agents/types";

import { dataDir } from "../compute/store";
import { writeAtomic } from "../workspace/atomic";

/**
 * The questions asked to each agent and how it answered, outside the
 * workspace (`<root>/agents/<agentId>/log.json`), newest first. Writes of one
 * agent run one after another, so two questions at once never lose one.
 */

const MAX_ENTRIES = 1000;
const MAX_QUESTION = 4000;
const MAX_ANSWER = 20_000;
const MAX_QUERY = 20_000;
const MAX_QUERIES = 20;
const MAX_NOTE = 2000;
/** charts kept per answer (each holds at most 200 rows) */
const MAX_CHARTS = 4;

const NO_AGENT = "there is no such agent";
const NO_ENTRY = "there is no such question in the log";

/** The log file of an agent; an id that is not an agent's id names none. */
function logFile(agentId: string, root: string): string {
  if (!AGENT_ID.test(agentId)) throw new Error(NO_AGENT);
  return path.join(root, "agents", agentId, "log.json");
}

/** The last write queued for each agent. */
const queue = new Map<string, Promise<unknown>>();

/** Runs `fn` after the agent's earlier writes, whether they failed or not. */
function serial<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
  const run = (queue.get(agentId) ?? Promise.resolve()).catch(() => undefined).then(fn);
  queue.set(agentId, run.catch(() => undefined));
  return run;
}

/** The entries in the file, newest first (none when the file is not there). */
async function readEntries(file: string): Promise<AgentLogEntry[]> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as AgentLogEntry[];
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
}

/** Records a question and its answer as the newest entry (its id is the agent's message id); the log keeps its newest 1000. */
export async function appendLog(agentId: string, entry: Omit<AgentLogEntry, "rating" | "note">, root = dataDir()): Promise<AgentLogEntry> {
  return serial(agentId, async () => {
    const file = logFile(agentId, root);
    const added: AgentLogEntry = {
      ...entry,
      question: entry.question.slice(0, MAX_QUESTION),
      answer: entry.answer.slice(0, MAX_ANSWER),
      queries: entry.queries.slice(0, MAX_QUERIES).map((q) => q.slice(0, MAX_QUERY)),
      charts: (entry.charts ?? []).slice(0, MAX_CHARTS),
      rating: null,
      note: "",
    };
    const entries = [added, ...(await readEntries(file))].slice(0, MAX_ENTRIES);
    await writeAtomic(file, JSON.stringify(entries));
    return added;
  });
}

/** The agent's log, newest first. */
export async function listLog(agentId: string, root = dataDir()): Promise<AgentLogEntry[]> {
  return readEntries(logFile(agentId, root));
}

/** Sets an entry's rating (null clears it) and the reviewer's note on it. */
export async function rateLog(agentId: string, entryId: string, rating: AgentRating | null, note: string | undefined, root = dataDir()): Promise<AgentLogEntry> {
  if (rating !== null && rating !== "good" && rating !== "bad") throw new Error("a rating is good, bad or none");
  if (note !== undefined && typeof note !== "string") throw new Error("the note is text");
  return serial(agentId, async () => {
    const file = logFile(agentId, root);
    const entries = await readEntries(file);
    const i = entries.findIndex((e) => e.id === entryId);
    if (i < 0) throw new Error(NO_ENTRY);
    // a rating from the chat sends no note: the reviewer's stays
    entries[i] = { ...entries[i], rating, note: note === undefined ? entries[i].note : note.trim().slice(0, MAX_NOTE) };
    await writeAtomic(file, JSON.stringify(entries));
    return entries[i];
  });
}

/** Removes the agent's log; a log that is not there is fine. */
export async function deleteLog(agentId: string, root = dataDir()): Promise<void> {
  return serial(agentId, async () => {
    await fs.rm(path.dirname(logFile(agentId, root)), { recursive: true, force: true });
  });
}
