import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { IaraDecision, IaraProposal, IaraRequest } from "@/lib/iara/protocol";

import { FileSaver } from "./checkpointer";
import { answering, callStep, fakeDeps, NOTEBOOK_CONTEXT } from "./fakes";
import { readThread } from "./threads";
import { runTurn } from "./turn";
import type { ChatReply, ChatRequest } from "./state";

vi.mock("./tokens", () => ({
  CONTEXT_BUDGET: 200_000,
  COMPACT_AT: 0.8,
  countTokens: async (text: string) => Math.ceil(text.length / 4),
  countSteps: async () => 0,
  cutToTokens: async (text: string) => text,
}));

let dir: string;
let saver: FileSaver;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "iara-turn-"));
  vi.stubEnv("IARA_STUDIO_DATA", dir);
  saver = new FileSaver(path.join(dir, "checkpoints"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ANA = { email: "ana@example.com", name: "Ana", admin: false };
const message = (text: string, threadId: string | null = null, fileId = "f1"): IaraRequest => ({ kind: "message", threadId, fileId, text, context: NOTEBOOK_CONTEXT });
const decide = (threadId: string, proposalId: string, decision: IaraDecision): IaraRequest => ({ kind: "decision", threadId, proposalId, decision, context: NOTEBOOK_CONTEXT });
const approve: IaraDecision = { kind: "approve", run: true, outcome: { applied: true, cellId: "c2", ran: true, status: "ok", output: "count\n7" } };

/** Runs a request and returns the events it sent. */
async function run(req: IaraRequest, deps: Parameters<typeof runTurn>[1], signal?: AbortSignal) {
  const events: [string, unknown][] = [];
  await runTurn(req, deps, (e, d) => events.push([e, d]), signal, saver);
  return { events, names: events.map(([e]) => e), last: events.at(-1) };
}
const sent = (events: [string, unknown][], name: string) => events.filter(([e]) => e === name).map(([, d]) => d);

/** Iara says a line, then asks the author for a change; the author writes an insert_cell. */
const proposing = (): Record<string, ChatReply[]> => ({
  iara: [
    {
      steps: [{ type: "model_output", content: [{ type: "text", text: "Let me write that." }] }, callStep("p1", "propose_change", { task: "count the orders" })],
      text: "Let me write that.",
      calls: [callStep("p1", "propose_change", { task: "count the orders" })],
      usage: { input: 10, output: 2 },
    },
    answering("Done."),
  ],
  author: [
    {
      steps: [callStep("s1", "submit_change", { change: { action: "insert_cell", kind: "python", code: "n = 7", afterCellId: "c1", run: true }, explanation: "Counts them." })],
      text: "",
      calls: [callStep("s1", "submit_change", { change: { action: "insert_cell", kind: "python", code: "n = 7", afterCellId: "c1", run: true }, explanation: "Counts them." })],
      usage: { input: 10, output: 2 },
    },
  ],
});

/** the turns still in the checkpoint folder */
const leftover = () => (fs.existsSync(path.join(dir, "checkpoints")) ? fs.readdirSync(path.join(dir, "checkpoints")) : []);
const lgFile = (threadId: string, turn: string) => path.join(dir, "checkpoints", `${threadId}.${turn}.json`);

describe("runTurn", () => {
  it("streams a proposing turn, pauses at the proposal and saves the conversation", async () => {
    const { deps } = fakeDeps(proposing());
    const { names, events } = await run(message("count the orders"), deps);

    expect(names).toEqual(["thread", "agent", "text", "usage", "agent", "agent", "approval", "thread"]);
    expect(events[0]).toEqual(["thread", { id: expect.any(String), title: "" }]);
    expect(sent(events, "agent")).toEqual([{ agent: "iara" }, { agent: "author" }, { agent: "reviewer" }]);
    expect(sent(events, "text")).toEqual([{ delta: "Let me write that." }]);
    const proposal = sent(events, "approval")[0] as IaraProposal;
    expect(proposal).toMatchObject({ attempt: 1, explanation: "Counts them.", change: { action: "insert_cell" } });
    // named after the first turn
    expect(events.at(-1)).toEqual(["thread", { id: expect.any(String), title: "Orders" }]);

    const id = (events[0][1] as { id: string }).id;
    const thread = await readThread(ANA, id);
    expect(thread.title).toBe("Orders");
    expect(thread.pending).toEqual({ turn: expect.any(String), proposal });
    expect(thread.history).toEqual([]);
    expect(thread.usage).toMatchObject({ context: 10, budget: 200_000, turnInput: 10, turnOutput: 2 });
    expect(thread.messages).toMatchObject([
      { role: "user", text: "count the orders" },
      { role: "iara", text: "Let me write that.", proposals: [{ ...proposal, decision: "pending" }], steps: [], memories: [] },
    ]);
    expect(fs.existsSync(lgFile(id, thread.pending!.turn))).toBe(true);
  });

  it("finishes a turn when the user decides: the reply goes on in the same message and the turn is cleaned up", async () => {
    const { deps } = fakeDeps(proposing());
    const first = await run(message("count the orders"), deps);
    const id = (first.events[0][1] as { id: string }).id;
    const proposal = sent(first.events, "approval")[0] as IaraProposal;
    const turn = (await readThread(ANA, id)).pending!.turn;

    const { names, events, last } = await run(decide(id, proposal.id, approve), deps);
    expect(names).toEqual(["thread", "agent", "agent", "text", "text", "usage", "done"]);
    expect(sent(events, "agent")).toEqual([{ agent: "observer" }, { agent: "iara" }]);

    const thread = await readThread(ANA, id);
    expect(thread.pending).toBeNull();
    expect(thread.messages).toHaveLength(2);
    expect(last).toEqual(["done", { messageId: thread.messages[1].id }]);
    expect(thread.messages[1]).toMatchObject({
      text: "Let me write that.\n\nDone.",
      proposals: [{ id: proposal.id, decision: "approved", outcome: approve.kind === "approve" ? approve.outcome : null }],
    });
    // the model's conversation is kept for the next message
    expect(thread.history.map((s) => s.type)).toEqual(["user_input", "model_output", "function_call", "function_result", "model_output"]);
    expect(thread.history[3]).toMatchObject({ call_id: "p1", result: expect.stringContaining("The change was applied as cell c2.") });
    expect(fs.existsSync(lgFile(id, turn))).toBe(false);
  });

  it("keeps the reasoning summary as one thought step per item, and sends each delta", async () => {
    const { deps } = fakeDeps({ iara: [answering("Hi.")] });
    const thinking = {
      ...deps,
      chat: (req: ChatRequest) => {
        req.onThought?.("rs_1", "Checking ");
        req.onThought?.("rs_1", "the orders.");
        req.onThought?.("rs_2", "Then the customers.");
        return deps.chat(req);
      },
    };
    const { names, events } = await run(message("hello"), thinking);
    expect(names).toEqual(["thread", "agent", "thought", "thought", "thought", "text", "usage", "done", "thread"]);
    expect(sent(events, "thought")).toEqual([
      { agent: "iara", id: "rs_1", delta: "Checking " },
      { agent: "iara", id: "rs_1", delta: "the orders." },
      { agent: "iara", id: "rs_2", delta: "Then the customers." },
    ]);

    const thread = await readThread(ANA, (events[0][1] as { id: string }).id);
    expect(thread.messages[1].steps).toEqual([
      { kind: "thought", agent: "iara", id: "rs_1", text: "Checking the orders." },
      { kind: "thought", agent: "iara", id: "rs_2", text: "Then the customers." },
    ]);
  });

  it("records a rejection", async () => {
    const { deps } = fakeDeps(proposing());
    const first = await run(message("count the orders"), deps);
    const id = (first.events[0][1] as { id: string }).id;
    const proposal = sent(first.events, "approval")[0] as IaraProposal;

    const { last } = await run(decide(id, proposal.id, { kind: "reject", feedback: "no" }), deps);
    expect(last?.[0]).toBe("done");
    const thread = await readThread(ANA, id);
    expect(thread.messages[1].proposals).toMatchObject([{ decision: "rejected" }]);
    expect(thread.messages[1].proposals?.[0]).not.toHaveProperty("outcome");
  });

  it("takes a failed run back to the author and waits again with attempt 2", async () => {
    const script = proposing();
    script.author.push({
      steps: [callStep("s2", "submit_change", { change: { action: "edit_cell", cellId: "c1", edits: [{ old: "x = 1", new: "n = 7 + 0" }], run: true }, explanation: "Fixes it." })],
      text: "",
      calls: [callStep("s2", "submit_change", { change: { action: "edit_cell", cellId: "c1", edits: [{ old: "x = 1", new: "n = 7 + 0" }], run: true }, explanation: "Fixes it." })],
      usage: { input: 10, output: 2 },
    });
    const { deps } = fakeDeps(script);
    const first = await run(message("count the orders"), deps);
    const id = (first.events[0][1] as { id: string }).id;
    const proposal = sent(first.events, "approval")[0] as IaraProposal;

    const failed: IaraDecision = { kind: "approve", run: true, outcome: { applied: true, cellId: "c1", ran: true, status: "error", error: "boom" } };
    const second = await run(decide(id, proposal.id, failed), deps);
    expect(second.names).toEqual(["thread", "agent", "agent", "agent", "approval"]);
    expect(sent(second.events, "agent")).toEqual([{ agent: "observer" }, { agent: "author" }, { agent: "reviewer" }]);
    const again = sent(second.events, "approval")[0] as IaraProposal;
    expect(again).toMatchObject({ attempt: 2, change: { action: "edit_cell" } });

    const thread = await readThread(ANA, id);
    expect(thread.pending?.proposal.id).toBe(again.id);
    expect(thread.messages[1].proposals).toMatchObject([
      { id: proposal.id, decision: "approved", outcome: { status: "error" } },
      { id: again.id, decision: "pending", attempt: 2 },
    ]);
  });

  it("refuses a message while a proposal waits, and leaves it waiting", async () => {
    const { deps, requests } = fakeDeps(proposing());
    const first = await run(message("count the orders"), deps);
    const id = (first.events[0][1] as { id: string }).id;
    const before = requests.length;

    const { events } = await run(message("and the customers", id), deps);
    expect(events).toEqual([["failed", { message: "answer the proposal first" }]]);
    expect(requests).toHaveLength(before);
    expect((await readThread(ANA, id)).pending).not.toBeNull();
  });

  it("refuses a decision on a proposal that is not the waiting one", async () => {
    const { deps } = fakeDeps(proposing());
    const first = await run(message("count the orders"), deps);
    const id = (first.events[0][1] as { id: string }).id;

    expect((await run(decide(id, "other", approve), deps)).events).toEqual([["failed", { message: "this proposal is no longer waiting" }]]);
    expect((await readThread(ANA, id)).pending).not.toBeNull();

    const finished = fakeDeps({ iara: [answering("Hi.")] });
    const plain = await run(message("hello"), finished.deps);
    const plainId = (plain.events[0][1] as { id: string }).id;
    expect((await run(decide(plainId, "p", approve), finished.deps)).last).toEqual(["failed", { message: "this proposal is no longer waiting" }]);
  });

  it("refuses a conversation that is not there or belongs to another file", async () => {
    const { deps } = fakeDeps({ iara: [answering("Hi.")] });
    expect((await run(message("hello", "nope"), deps)).events).toEqual([["failed", { message: "there is no such conversation" }]]);

    const plain = await run(message("hello"), deps);
    const id = (plain.events[0][1] as { id: string }).id;
    expect((await run(message("again", id, "other-file"), deps)).events).toEqual([["failed", { message: "there is no such conversation" }]]);
  });

  it("answers a plain message with text and done, and keeps the history for the next one", async () => {
    const { deps, requests } = fakeDeps({ iara: [answering("Hello!"), answering("Again!")] });
    const first = await run(message("hello"), deps);
    expect(first.names).toEqual(["thread", "agent", "text", "usage", "done", "thread"]);
    const id = (first.events[0][1] as { id: string }).id;

    await run(message("hi again", id), deps);
    // the second turn starts from the first one's conversation
    expect(requests[1].steps.map((s) => s.type)).toEqual(["user_input", "model_output", "user_input"]);
    const thread = await readThread(ANA, id);
    expect(thread.messages.map((m) => m.role)).toEqual(["user", "iara", "user", "iara"]);
    expect(thread.history).toHaveLength(4);
  });

  it("keeps what the analyst found for the next turns, so they build on it", async () => {
    const asking = (id: string) => ({ ...answering(""), steps: [callStep(id, "ask_analyst", { question: "which table has orders?" })], calls: [callStep(id, "ask_analyst", { question: "which table has orders?" })] });
    const { deps, requests } = fakeDeps({
      iara: [asking("a1"), answering("main.sales.orders."), asking("a2"), answering("Still that one.")],
      analyst: [answering("orders is main.sales.orders"), answering("as found")],
    });
    const first = await run(message("where are the orders?"), deps);
    const id = (first.events[0][1] as { id: string }).id;
    expect((await readThread(ANA, id)).findings).toEqual(["orders is main.sales.orders"]);

    await run(message("and now?", id), deps);
    const second = requests.filter((r) => r.agent === "analyst")[1];
    expect(JSON.stringify(second.steps[0])).toContain("Already found in this conversation");
    expect(JSON.stringify(second.steps[0])).toContain("orders is main.sales.orders");
    expect((await readThread(ANA, id)).findings).toEqual(["orders is main.sales.orders", "as found"]);
  });

  it("does not run two turns of a conversation at once", async () => {
    const { deps } = fakeDeps({ iara: [answering("Hello!")] });
    const first = await run(message("hello"), deps);
    const id = (first.events[0][1] as { id: string }).id;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = { ...deps, chat: async () => (await gate, answering("Later.")) };
    const running = run(message("slow", id), slow);

    const refused = await run(message("meanwhile", id), deps);
    expect(refused.events).toEqual([["failed", { message: "Iara is still answering in this conversation" }]]);

    release();
    expect((await running).last?.[0]).toBe("done");
    // the lock is released
    const next = fakeDeps({ iara: [answering("Free.")] });
    expect((await run(message("now", id), next.deps)).names).toContain("done");
  });

  it("keeps what was streamed when an agent fails, and sends the message", async () => {
    const { deps } = fakeDeps({
      iara: [
        {
          steps: [{ type: "model_output", content: [{ type: "text", text: "Let me check." }] }, callStep("a1", "ask_analyst", { question: "?" })],
          text: "Let me check.",
          calls: [callStep("a1", "ask_analyst", { question: "?" })],
          usage: { input: 10, output: 2 },
        },
      ],
      analyst: [],
    });
    const { names, last, events } = await run(message("what is in orders?"), deps);
    expect(names).toEqual(["thread", "agent", "text", "usage", "agent", "failed"]);
    expect(last).toEqual(["failed", { message: "no scripted reply left for analyst" }]);

    const thread = await readThread(ANA, (events[0][1] as { id: string }).id);
    expect(thread.pending).toBeNull();
    expect(thread.history).toEqual([]);
    expect(thread.messages).toMatchObject([{ role: "user", text: "what is in orders?" }, { role: "iara", text: "Let me check." }]);
    expect(leftover()).toEqual([]);
  });

  it("saves the user's message and drops the blank answer when the model fails at once", async () => {
    const { deps } = fakeDeps({});
    const { last, events } = await run(message("hello"), deps);
    expect(last).toEqual(["failed", { message: "no scripted reply left for iara" }]);
    const thread = await readThread(ANA, (events[0][1] as { id: string }).id);
    expect(thread.messages).toMatchObject([{ role: "user", text: "hello" }]);
    expect(thread.messages).toHaveLength(1);
  });

  it("fails a decision turn but clears the waiting proposal", async () => {
    const { deps } = fakeDeps({ ...proposing(), iara: [proposing().iara[0]] });
    const first = await run(message("count the orders"), deps);
    const id = (first.events[0][1] as { id: string }).id;
    const proposal = sent(first.events, "approval")[0] as IaraProposal;

    // iara has nothing left to say after the decision
    const { last } = await run(decide(id, proposal.id, approve), deps);
    expect(last?.[0]).toBe("failed");
    const thread = await readThread(ANA, id);
    expect(thread.pending).toBeNull();
    expect(thread.messages[1].text).toBe("Let me write that.");
    expect(thread.messages[1].proposals).toMatchObject([{ decision: "approved" }]);
  });

  it("sends nothing more when the request was aborted, and still cleans up", async () => {
    const controller = new AbortController();
    const { deps } = fakeDeps({});
    const aborting = {
      ...deps,
      chat: async () => {
        controller.abort();
        throw new Error("This operation was aborted");
      },
    };
    const { names, events } = await run(message("hello"), aborting, controller.signal);
    expect(names[0]).toBe("thread");
    expect(names).not.toContain("failed");
    const thread = await readThread(ANA, (events[0][1] as { id: string }).id);
    expect(thread.messages).toMatchObject([{ role: "user" }]);
    expect(leftover()).toEqual([]);
  });

  it("leaves the conversation unnamed when naming fails, and names it on the next turn", async () => {
    const { deps, llm } = fakeDeps({ iara: [answering("One."), answering("Two.")] });
    llm.mockRejectedValueOnce(new Error("quota"));
    const first = await run(message("hello"), deps);
    expect(first.names.at(-1)).toBe("done");
    const id = (first.events[0][1] as { id: string }).id;
    expect((await readThread(ANA, id)).title).toBe("");

    const second = await run(message("hello again", id), deps);
    expect(second.last).toEqual(["thread", { id, title: "Orders" }]);
    // named from the first message
    expect(llm.mock.calls.at(-1)?.[2]).toBe("hello");
  });
});
