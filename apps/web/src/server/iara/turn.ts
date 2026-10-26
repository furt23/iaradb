import "server-only";

import crypto from "node:crypto";

import { Command } from "@langchain/langgraph";
import { z } from "zod";

import type { IaraEvent, IaraMessage, IaraProposal, IaraRequest } from "@/lib/iara/protocol";

import { FAST_MODEL } from "../ai/models";
import { iaraSaver } from "./checkpointer";
import { buildIaraGraph } from "./graph";
import { listMemories } from "./memory";
import { userStep } from "./prompt";
import type { Emit, IaraDeps, IaraGraphState } from "./state";
import { createThread, readThread, saveThread, type ThreadRecord } from "./threads";

// one graph run per conversation; on globalThis so a dev reload does not forget a running one
const globalForTurn = globalThis as unknown as { __iaraBusy?: Set<string> };
const busy = (globalForTurn.__iaraBusy ??= new Set<string>());

/** Iara is answering in this conversation (deleting it now would let the turn's last save bring it back). */
export const isBusy = (threadId: string) => busy.has(threadId);

/** model calls of every agent are capped by MAX_STEPS; this only keeps LangGraph's own loop guard (25) from cutting a long turn short */
const RECURSION_LIMIT = 100;

/** how long a finished turn waits for a name that is still being made; the conversation is locked meanwhile */
const TITLE_WAIT_MS = 10_000;
/** the analyst's latest answers a conversation keeps for its next turns */
const MAX_FINDINGS = 8;
const TITLE_SYSTEM = "Name this conversation in at most 6 words, in the user's language.";
const TITLE_SCHEMA = { type: "object", properties: { title: { type: "string" } }, required: ["title"] };
const Title = z.object({ title: z.string() });

type Send = (event: IaraEvent["event"], data: unknown) => void;
type Input = Parameters<ReturnType<typeof buildIaraGraph>["stream"]>[0];

interface Started {
  thread: ThreadRecord;
  /** Iara's message of this turn: new, or the one a decision continues */
  message: IaraMessage;
  /** the LangGraph thread of the turn (a proposal waits on it between requests) */
  turn: string;
  input: Input;
}

/** Reads or creates the conversation and the message this request works on, and checks the request fits it. */
async function begin(req: IaraRequest, deps: IaraDeps): Promise<Started> {
  if (req.kind === "message") {
    const thread = req.threadId ? await readThread(deps.user, req.threadId) : await createThread(deps.user, req.fileId, req.context.surface);
    if (thread.fileId !== req.fileId) throw new Error("there is no such conversation");
    if (thread.pending) throw new Error("answer the proposal first");
    const at = Date.now();
    const message: IaraMessage = { id: crypto.randomUUID(), role: "iara", text: "", at, steps: [], memories: [], proposals: [] };
    thread.messages.push({ id: crypto.randomUUID(), role: "user", text: req.text, at }, message);
    const input = { context: req.context, history: [...thread.history, userStep(req.text)], summary: thread.summary, findings: thread.findings ?? [], memories: await listMemories(deps.user) };
    return { thread, message, turn: crypto.randomUUID(), input };
  }
  const thread = await readThread(deps.user, req.threadId);
  const message = thread.messages.at(-1);
  if (thread.pending?.proposal.id !== req.proposalId || message?.role !== "iara") throw new Error("this proposal is no longer waiting");
  const record = message.proposals?.find((p) => p.id === req.proposalId);
  if (record) Object.assign(record, req.decision.kind === "approve" ? { decision: "approved", outcome: req.decision.outcome } : { decision: "rejected" });
  return { thread, message, turn: thread.pending.turn, input: new Command({ resume: req.decision, update: { context: req.context } }) };
}

/** A name from the first message; empty when naming fails (the conversation stays unnamed and the next turn tries again). */
async function nameOf(firstMessage: string, deps: IaraDeps): Promise<string> {
  try {
    const answer = Title.parse(await deps.llm(FAST_MODEL, TITLE_SYSTEM, firstMessage, TITLE_SCHEMA));
    return answer.title.trim().slice(0, 80);
  } catch {
    return "";
  }
}

const wait = (ms: number) => new Promise<string>((resolve) => setTimeout(resolve, ms, "").unref());

/** Runs a message or a decision: streams the agents' events through `send`, saves the conversation, and leaves a paused turn waiting for the user's decision. */
export async function runTurn(req: IaraRequest, deps: IaraDeps, send: Send, signal?: AbortSignal, saver = iaraSaver()): Promise<void> {
  if (req.threadId && busy.has(req.threadId)) return send("failed", { message: "Iara is still answering in this conversation" });
  if (req.threadId) busy.add(req.threadId);
  let started: Started | undefined;
  let running = false;
  let lockedId = req.threadId;
  try {
    started = await begin(req, deps);
    const { thread, message, turn, input } = started;
    lockedId = thread.id;
    busy.add(thread.id);
    send("thread", { id: thread.id, title: thread.title });
    // named while the agents work, so the name costs the turn no time
    const naming = thread.title ? null : nameOf(thread.messages[0].text, deps);

    const forward = (e: Emit) => {
      switch (e.type) {
        case "agent":
          return send("agent", { agent: e.agent });
        case "text":
          message.text += e.delta;
          return send("text", { delta: e.delta });
        case "tool":
          message.steps?.push({ kind: "tool", ...e.use });
          return send("tool", e.use);
        case "thought": {
          // deltas of one reasoning item are one thought, even with other steps in between
          const last = message.steps?.findLast((s) => s.kind === "thought" && s.id === e.id);
          if (last?.kind === "thought") last.text += e.delta;
          else message.steps?.push({ kind: "thought", agent: e.agent, id: e.id, text: e.delta });
          return send("thought", { agent: e.agent, id: e.id, delta: e.delta });
        }
        case "memory":
          message.memories?.push({ action: e.action, memory: e.memory });
          return send("memory", { action: e.action, memory: e.memory });
        case "usage":
          thread.usage = e.usage;
          return send("usage", e.usage);
      }
    };

    const graph = buildIaraGraph(deps, saver);
    const config = { configurable: { thread_id: `${thread.id}.${turn}` }, streamMode: ["custom", "updates"] as ("custom" | "updates")[], recursionLimit: RECURSION_LIMIT, signal };
    let proposal: IaraProposal | null = null;
    running = true;
    for await (const [mode, chunk] of await graph.stream(input, config)) {
      if (mode === "custom") forward(chunk as Emit);
      else if ("__interrupt__" in chunk) proposal = (chunk.__interrupt__ as { value: { proposal: IaraProposal } }[])[0].value.proposal;
    }

    if (proposal) {
      thread.pending = { turn, proposal };
      message.proposals?.push({ ...proposal, decision: "pending" });
      await saveThread(deps.user, thread);
      send("approval", proposal);
    } else {
      const values = (await graph.getState(config)).values as IaraGraphState;
      thread.history = values.history;
      thread.summary = values.summary;
      thread.findings = values.findings.slice(-MAX_FINDINGS);
      thread.pending = null;
      await saveThread(deps.user, thread);
      await saver.deleteThread(config.configurable.thread_id);
      send("done", { messageId: message.id });
    }
    const title = naming && (await Promise.race([naming, wait(TITLE_WAIT_MS)]));
    if (title) {
      thread.title = title;
      // the turn is over: a failed save only leaves the conversation unnamed
      await saveThread(deps.user, thread).then(() => send("thread", { id: thread.id, title }), () => {});
    }
  } catch (e) {
    // before the run nothing was started (a refusal changes nothing, a paused turn keeps waiting)
    if (!running) return send("failed", { message: (e as Error).message });
    const { thread, message, turn } = started!;
    // what was streamed stays; an empty answer is dropped so the conversation shows no blank message
    if (!message.text && !message.steps?.length && !message.memories?.length && !message.proposals?.length) thread.messages.pop();
    thread.pending = null;
    await saveThread(deps.user, thread).catch(() => {});
    await saver.deleteThread(`${thread.id}.${turn}`).catch(() => {});
    if (!signal?.aborted) send("failed", { message: (e as Error).message });
  } finally {
    if (lockedId) busy.delete(lockedId);
  }
}
