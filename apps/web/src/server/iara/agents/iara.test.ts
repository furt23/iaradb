import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LOCAL_USER } from "../../auth/access";
import { answering, callStep, calling, fakeDeps, SQL_CONTEXT } from "../fakes";
import { addMemory, listMemories } from "../memory";
import { userStep } from "../prompt";
import { MAX_STEPS, type IaraGraphState, type Step } from "../state";
import { compactionCut, IARA_TOOLS, iaraNode } from "./iara";

// chars / 4, and a token count the tests can raise
const tokens = vi.hoisted(() => ({ steps: 0 }));
vi.mock("../tokens", () => ({
  CONTEXT_BUDGET: 200_000,
  COMPACT_AT: 0.8,
  countTokens: async (text: string) => Math.ceil(text.length / 4),
  countSteps: async () => tokens.steps,
  cutToTokens: async (text: string, max: number) => (text.length / 4 > max ? `${text.slice(0, max * 4)}\n… (cut)` : text),
}));

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "iara-agent-"));
  vi.stubEnv("IARA_STUDIO_DATA", dir);
});
afterEach(() => {
  vi.unstubAllEnvs();
  tokens.steps = 0;
  fs.rmSync(dir, { recursive: true, force: true });
});

const state = (over: Partial<IaraGraphState> = {}): IaraGraphState => ({
  context: SQL_CONTEXT,
  history: [userStep("hello")],
  summary: null,
  memories: [],
  handoff: null,
  handoffResult: null,
  findings: [],
  draft: null,
  refusal: null,
  reviewNotes: null,
  reviews: 0,
  fixes: 0,
  proposal: null,
  decision: null,
  steps: 0,
  usage: { input: 5, output: 1 },
  contextTokens: 0,
  reply: "",
  ...over,
});

const config = () => {
  const writer = vi.fn();
  return { config: { writer } as unknown as LangGraphRunnableConfig, writer };
};

const emitted = (writer: ReturnType<typeof vi.fn>, type: string) => writer.mock.calls.map(([e]) => e).filter((e) => e.type === type);

describe("compactionCut", () => {
  const turn = (n: number): Step[] => [userStep(`q${n}`), { type: "model_output", content: [{ type: "text", text: `a${n}` }] }];

  it("is 0 when there are not more turns than are kept", () => {
    expect(compactionCut([])).toBe(0);
    expect(compactionCut([...turn(1)])).toBe(0);
    expect(compactionCut([...turn(1), ...turn(2)])).toBe(0);
  });

  it("starts at the user message that opens the second to last turn", () => {
    const history = [...turn(1), ...turn(2), ...turn(3), ...turn(4)];
    expect(compactionCut(history)).toBe(4);
    expect(compactionCut(history, 1)).toBe(6);
    expect(compactionCut(history, 3)).toBe(2);
  });

  it("never separates a call from its result: it cuts only at user messages", () => {
    const call = callStep("c1", "ask_analyst", { question: "q" });
    const result: Step = { type: "function_result", call_id: "c1", result: "r" };
    const history: Step[] = [userStep("q1"), call, result, ...turn(2).slice(1), userStep("q2"), call, result, userStep("q3"), call];
    const cut = compactionCut(history);
    expect(history[cut].type).toBe("user_input");
    expect(cut).toBe(history.findIndex((s) => s.type === "user_input" && s.content[0].text === "q2"));
  });
});

describe("iaraNode", () => {
  it("answers in plain text, streaming it", async () => {
    const { deps } = fakeDeps({ iara: [answering("Hi!")] });
    const { config: c, writer } = config();
    const out = (await iaraNode(deps)(state(), c)) as Partial<IaraGraphState>;

    expect(out).toMatchObject({ reply: "Hi!", handoff: null, handoffResult: null, steps: 1, usage: { input: 25, output: 5 }, contextTokens: 20, summary: null });
    expect(out.history).toHaveLength(2);
    expect(out.history?.[1]).toMatchObject({ type: "model_output" });
    expect(writer.mock.calls.map(([e]) => e)).toEqual([
      { type: "agent", agent: "iara" },
      { type: "text", delta: "Hi!" },
      { type: "usage", usage: { context: 20, budget: 200_000, turnInput: 25, turnOutput: 5 } },
    ]);
  });

  it("puts what she knows in the system prompt: the user's memories, the summary and the open file", async () => {
    const { deps, requests } = fakeDeps({ iara: [answering("ok")] });
    const memory = { id: "m1", text: "prefers short answers", created: 1 };
    await iaraNode(deps)(state({ memories: [memory], summary: "talked about orders" }), config().config);

    const { system, tools } = requests[0];
    expect(system).toContain("You are Iara");
    expect(system).toContain("What you remember about this user:\n- [m1] prefers short answers");
    expect(system).toContain("Earlier in this conversation (summarized):\ntalked about orders");
    expect(system).toContain("The open file:\nSQL editor q.sql");
    expect(tools).toBe(IARA_TOOLS);
  });

  it("starts a new paragraph when the reply goes on after a tool call", async () => {
    const { deps } = fakeDeps({ iara: [answering("Second.")] });
    const { config: c, writer } = config();
    const out = (await iaraNode(deps)(state({ reply: "First." }), c)) as Partial<IaraGraphState>;
    expect(out.reply).toBe("First.\n\nSecond.");
    expect(emitted(writer, "text").map((e) => e.delta)).toEqual(["\n\n", "Second."]);
  });

  it("saves a memory, tells the model and goes on", async () => {
    const { deps, requests } = fakeDeps({
      iara: [calling(callStep("c1", "remember", { text: "works in UTC" })), answering("Noted.")],
    });
    const { config: c, writer } = config();
    const out = (await iaraNode({ ...deps, user: LOCAL_USER })(state(), c)) as Partial<IaraGraphState>;

    const saved = await listMemories(LOCAL_USER);
    expect(saved).toHaveLength(1);
    expect(saved[0].text).toBe("works in UTC");
    expect(emitted(writer, "memory")).toEqual([{ type: "memory", action: "saved", memory: saved[0] }]);
    expect(requests[1].steps.at(-1)).toMatchObject({ type: "function_result", call_id: "c1", name: "remember", result: "saved" });
    // the new memory is in the next prompt and in the state
    expect(requests[1].system).toContain(`- [${saved[0].id}] works in UTC`);
    expect(out).toMatchObject({ reply: "Noted.", steps: 2, memories: saved });
  });

  it("forgets a memory by id, and says so when there is none", async () => {
    const memory = await addMemory(LOCAL_USER, "likes pie charts");
    const { deps, requests } = fakeDeps({
      iara: [calling(callStep("c1", "forget", { id: memory.id }), callStep("c2", "forget", { id: "nope" })), answering("Done.")],
    });
    const { config: c, writer } = config();
    const out = (await iaraNode({ ...deps, user: LOCAL_USER })(state({ memories: [memory] }), c)) as Partial<IaraGraphState>;

    expect(await listMemories(LOCAL_USER)).toEqual([]);
    expect(emitted(writer, "memory")).toEqual([{ type: "memory", action: "forgotten", memory }]);
    expect(requests[1].steps.slice(-2)).toMatchObject([
      { type: "function_result", call_id: "c1", result: "forgotten" },
      { type: "function_result", call_id: "c2", result: "there is no memory with that id", is_error: true },
    ]);
    expect(out.memories).toEqual([]);
  });

  it("gives a refused memory to the model as an error result", async () => {
    const { deps, requests } = fakeDeps({ iara: [calling(callStep("c1", "remember", { text: "x".repeat(501) })), answering("Too long.")] });
    await iaraNode({ ...deps, user: LOCAL_USER })(state(), config().config);
    expect(requests[1].steps.at(-1)).toMatchObject({ type: "function_result", is_error: true, result: "a memory is 1 to 500 characters" });
    expect(await listMemories(LOCAL_USER)).toEqual([]);
  });

  it("hands a data question to the analyst and stops, with the call still open", async () => {
    const { deps, requests } = fakeDeps({ iara: [calling(callStep("c1", "ask_analyst", { question: " which table has orders? " }))] });
    const { config: c } = config();
    const out = (await iaraNode(deps)(state(), c)) as Partial<IaraGraphState>;

    expect(out).toMatchObject({ handoff: { callId: "c1", name: "ask_analyst", request: "which table has orders?" }, handoffResult: null, steps: 1 });
    expect(out).not.toHaveProperty("draft");
    expect(out.history?.at(-1)).toMatchObject({ type: "function_call", id: "c1" });
    expect(requests).toHaveLength(1);
  });

  it("starts a change from nothing, and takes one handoff at a time", async () => {
    const { deps } = fakeDeps({
      iara: [calling(callStep("c1", "propose_change", { task: "add a query" }), callStep("c2", "ask_analyst", { question: "?" }), callStep("c3", "remember", { text: "a fact" }))],
    });
    const out = (await iaraNode({ ...deps, user: LOCAL_USER })(state({ fixes: 2, reviews: 1, refusal: "old", draft: { change: { action: "run_cell", cellId: "c" }, explanation: "x" } }), config().config)) as Partial<IaraGraphState>;

    expect(out).toMatchObject({ handoff: { callId: "c1", name: "propose_change", request: "add a query" }, draft: null, refusal: null, reviewNotes: null, reviews: 0, fixes: 0, proposal: null, decision: null });
    // the second handoff is answered with an error, the memory saved; the first one's result comes later
    expect(out.history?.slice(-2)).toMatchObject([
      { type: "function_result", call_id: "c2", is_error: true, result: "one handoff at a time: call it again after this one" },
      { type: "function_result", call_id: "c3", result: "saved" },
    ]);
  });

  it("refuses a handoff without text", async () => {
    const { deps, requests } = fakeDeps({ iara: [calling(callStep("c1", "ask_analyst", {})), answering("Sorry.")] });
    await iaraNode(deps)(state(), config().config);
    expect(requests[1].steps.at(-1)).toMatchObject({ type: "function_result", call_id: "c1", is_error: true });
  });

  it("answers an unknown tool with an error", async () => {
    const { deps, requests } = fakeDeps({ iara: [calling(callStep("c1", "delete_everything", {})), answering("ok")] });
    await iaraNode(deps)(state(), config().config);
    expect(requests[1].steps.at(-1)).toMatchObject({ type: "function_result", result: "unknown tool: delete_everything", is_error: true });
  });

  it("appends the handoff's result as the function result, and clears the handoff", async () => {
    const call = callStep("c1", "ask_analyst", { question: "?" });
    const { deps, requests } = fakeDeps({ iara: [answering("It is main.sales.orders.")] });
    const out = (await iaraNode(deps)(
      state({ history: [userStep("where are orders?"), call], handoff: { callId: "c1", name: "ask_analyst", request: "?" }, handoffResult: "main.sales.orders has 7 rows", reply: "Let me look." }),
      config().config,
    )) as Partial<IaraGraphState>;

    expect(requests[0].steps.at(-1)).toEqual({ type: "function_result", call_id: "c1", name: "ask_analyst", result: "main.sales.orders has 7 rows" });
    expect(out).toMatchObject({ handoff: null, handoffResult: null, reply: "Let me look.\n\nIt is main.sales.orders." });
    expect(out.history?.map((s) => s.type)).toEqual(["user_input", "function_call", "function_result", "model_output"]);
  });

  it("makes a last call without tools when the steps run out, and keeps the nudge out of the history", async () => {
    const { deps, requests } = fakeDeps({
      iara: [calling(callStep("c1", "remember", { text: "a fact" })), answering("Here is where we are.")],
    });
    const out = (await iaraNode({ ...deps, user: LOCAL_USER })(state({ steps: MAX_STEPS - 1 }), config().config)) as Partial<IaraGraphState>;

    expect(requests.map((r) => !!r.tools)).toEqual([true, false]);
    expect(requests[1].steps.at(-1)).toMatchObject({ type: "user_input", content: [{ text: expect.stringContaining("out of steps") }] });
    expect(out).toMatchObject({ reply: "Here is where we are.", steps: MAX_STEPS + 1 });
    expect(out.history?.filter((s) => s.type === "user_input")).toHaveLength(1);
    expect(out.history?.at(-1)).toMatchObject({ type: "model_output" });
  });

  describe("compaction", () => {
    const turn = (n: number): Step[] => [userStep(`question ${n}`), { type: "model_output", content: [{ type: "text", text: `answer ${n}` }] }];

    it("summarizes the older turns once the history passes 80% of the budget", async () => {
      tokens.steps = 160_001;
      const { deps, requests } = fakeDeps({ summary: [answering("The user asked about orders.")], iara: [answering("ok")] });
      const history = [...turn(1), ...turn(2), ...turn(3), userStep("now")];
      const { config: c } = config();
      const out = (await iaraNode(deps)(state({ history, summary: "earlier: hello" }), c)) as Partial<IaraGraphState>;

      expect(requests.map((r) => r.agent)).toEqual(["summary", "iara"]);
      const asked = (requests[0].steps[0] as Extract<Step, { type: "user_input" }>).content[0].text;
      expect(asked).toContain("earlier: hello");
      expect(asked).toContain("question 2");
      expect(asked).not.toContain("question 3");
      expect(requests[0].system).toContain("Summarize this conversation");
      // the kept turns start at the second to last user message, and the summary is in the prompt
      expect(requests[1].steps[0]).toMatchObject({ content: [{ text: "question 3" }] });
      expect(requests[1].system).toContain("The user asked about orders.");
      expect(out.summary).toBe("The user asked about orders.");
      expect(out.history).toHaveLength(4);
      // the summary call is part of the turn's cost
      expect(out.usage).toEqual({ input: 5 + 20 + 20, output: 1 + 4 + 4 });
    });

    it("leaves the history alone when it is under the threshold or has too few turns", async () => {
      const { deps, requests } = fakeDeps({ iara: [answering("a"), answering("b")] });
      await iaraNode(deps)(state({ history: [...turn(1), ...turn(2), ...turn(3), userStep("now")] }), config().config);
      tokens.steps = 190_000;
      const out = (await iaraNode(deps)(state({ history: [...turn(1), userStep("now")] }), config().config)) as Partial<IaraGraphState>;
      expect(requests.map((r) => r.agent)).toEqual(["iara", "iara"]);
      expect(out.summary).toBeNull();
    });

    it("keeps the history when the summary comes back empty", async () => {
      tokens.steps = 190_000;
      const { deps } = fakeDeps({ summary: [answering("  ")], iara: [answering("ok")] });
      const history = [...turn(1), ...turn(2), ...turn(3), userStep("now")];
      const out = (await iaraNode(deps)(state({ history }), config().config)) as Partial<IaraGraphState>;
      expect(out.summary).toBeNull();
      expect(out.history).toHaveLength(history.length + 1);
    });
  });
});
