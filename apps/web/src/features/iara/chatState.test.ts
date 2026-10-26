import { describe, expect, it } from "vitest";

import type { IaraEvent, IaraProposal } from "@/lib/iara/protocol";

import { beginTurn, emptyChat, recordDecision, reduceEvent, type ChatState } from "./chatState";

const proposal: IaraProposal = {
  id: "p1",
  change: { action: "edit_query", edits: [{ old: "", new: "select 1" }], run: true },
  explanation: "Runs a test query.",
  review: null,
  attempt: 1,
};

const fold = (state: ChatState, ...events: IaraEvent[]) => events.reduce(reduceEvent, state);
const started = () => beginTurn(emptyChat, { fileId: "f", surface: "sql", text: "hello", at: 1 });
const lastMessage = (s: ChatState) => s.thread!.messages.at(-1)!;

describe("beginTurn", () => {
  it("adds the user's message and an empty one for Iara to a new thread", () => {
    const s = started();
    expect(s.thread?.id).toBe("");
    expect(s.thread?.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "hello"],
      ["iara", ""],
    ]);
  });

  it("clears the last error and keeps the thread's messages", () => {
    const failed = fold(started(), { event: "failed", data: { message: "no" } });
    const s = beginTurn(failed, { fileId: "f", surface: "sql", text: "again", at: 2 });
    expect(s.error).toBeNull();
    expect(s.thread?.messages).toHaveLength(4);
  });
});

describe("reduceEvent", () => {
  it("names the thread", () => {
    const s = fold(started(), { event: "thread", data: { id: "t1", title: "Sales" } });
    expect(s.thread).toMatchObject({ id: "t1", title: "Sales" });
  });

  it("accumulates text deltas in Iara's message", () => {
    const s = fold(started(), { event: "text", data: { delta: "Hel" } }, { event: "text", data: { delta: "lo" } });
    expect(lastMessage(s).text).toBe("Hello");
    expect(s.thread?.messages[0].text).toBe("hello");
  });

  it("collects tools, thoughts and memory events as steps and memories", () => {
    const memory = { id: "m", text: "likes charts", created: 1 };
    const s = fold(
      started(),
      { event: "tool", data: { agent: "analyst", tool: "list_tables" } },
      { event: "thought", data: { agent: "analyst", id: "a", delta: "Looking" } },
      { event: "memory", data: { action: "saved", memory } },
    );
    expect(lastMessage(s).steps).toEqual([
      { kind: "tool", agent: "analyst", tool: "list_tables" },
      { kind: "thought", agent: "analyst", id: "a", text: "Looking" },
    ]);
    expect(lastMessage(s).memories).toEqual([{ action: "saved", memory }]);
  });

  it("joins the deltas of one thought, and a thought with another id starts a new step", () => {
    const s = fold(
      started(),
      { event: "thought", data: { agent: "analyst", id: "a", delta: "**Looking**" } },
      { event: "thought", data: { agent: "analyst", id: "a", delta: "\n\nat the tables" } },
      { event: "thought", data: { agent: "author", id: "b", delta: "Next" } },
    );
    expect(lastMessage(s).steps).toEqual([
      { kind: "thought", agent: "analyst", id: "a", text: "**Looking**\n\nat the tables" },
      { kind: "thought", agent: "author", id: "b", text: "Next" },
    ]);
  });

  it("tracks who works and clears it when done", () => {
    const working = fold(started(), { event: "agent", data: { agent: "author" } });
    expect(working.agent).toBe("author");
    expect(fold(working, { event: "done", data: { messageId: "m" } }).agent).toBeNull();
  });

  it("updates the usage", () => {
    const usage = { context: 10, budget: 100, turnInput: 8, turnOutput: 2 };
    expect(fold(started(), { event: "usage", data: usage }).thread?.usage).toEqual(usage);
  });

  it("waits on an approval: pending is set and the proposal is recorded as pending", () => {
    const s = fold(started(), { event: "approval", data: proposal });
    expect(s.thread?.pending).toEqual(proposal);
    expect(lastMessage(s).proposals).toEqual([{ ...proposal, decision: "pending" }]);
  });

  it("fails with the message and stops the agent", () => {
    const s = fold(started(), { event: "agent", data: { agent: "iara" } }, { event: "failed", data: { message: "Try again" } });
    expect(s).toMatchObject({ error: "Try again", agent: null });
  });

  it("ignores events when there is no thread", () => {
    expect(fold(emptyChat, { event: "text", data: { delta: "x" } })).toEqual(emptyChat);
  });
});

describe("recordDecision", () => {
  it("marks the proposal with its outcome and clears pending; the next events continue the same message", () => {
    const outcome = { applied: true, ran: true, status: "ok" as const };
    const waiting = fold(started(), { event: "text", data: { delta: "Here: " } }, { event: "approval", data: proposal });
    const s = fold(recordDecision(waiting, "p1", "approved", outcome), { event: "text", data: { delta: "done." } });
    expect(s.thread?.pending).toBeNull();
    expect(lastMessage(s).text).toBe("Here: done.");
    expect(lastMessage(s).proposals?.[0]).toMatchObject({ decision: "approved", outcome });
    expect(s.thread?.messages).toHaveLength(2);
  });
});
