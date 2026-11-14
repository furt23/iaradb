import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { describe, expect, it, vi } from "vitest";

import type { ToolContext } from "../../ai/tools";
import { ANALYST_STEPS, MAX_STEPS, type ChatReply, type ChatRequest, type IaraDeps, type IaraGraphState, type Step } from "../state";
import { analystNode } from "./analyst";

// chars / 4, and a token count the tests can raise
const tokens = vi.hoisted(() => ({ steps: 0 }));
vi.mock("../tokens", () => ({
  countTokens: async (text: string) => Math.ceil(text.length / 4),
  countSteps: async () => tokens.steps,
  cutToTokens: async (text: string, max: number) => (text.length / 4 > max ? `${text.slice(0, max * 4)}\n… (cut)` : text),
}));

const CONTEXT = { surface: "sql", path: "q.sql", query: "SELECT 1" } as const;

const state = (over: Partial<IaraGraphState> = {}): IaraGraphState => ({
  context: CONTEXT,
  history: [],
  summary: null,
  memories: [],
  handoff: { callId: "h1", name: "ask_analyst", request: "which table has the orders?" },
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

/** A kernel with one table and a big result. */
function kernel(): ToolContext {
  const request = async (method: string) => {
    switch (method) {
      case "catalog.list":
        return [{ name: "orders", full: "main.sales.orders", path: "", format: "parquet" }];
      case "catalog.table":
        return { name: "orders", full: "main.sales.orders", columns: [{ name: "id", type: "int64" }], num_rows: 7 };
      case "sql.run":
        return { type: "table", result: { id: "r1", columns: [{ name: "id", type: "int64" }], num_rows: 1 } };
      case "result.page":
        return { offset: 0, total: 1, rows: [["x".repeat(100_000)]] };
      default:
        return {};
    }
  };
  return { request: request as unknown as ToolContext["request"], allow: null };
}

type Call = Extract<Step, { type: "function_call" }>;
const callStep = (id: string, name: string, args: Record<string, unknown>): Call => ({ type: "function_call", id, name, arguments: args });
const calling = (...steps: Call[]): ChatReply => ({ steps, text: "", calls: steps, usage: { input: 10, output: 2 } });
const answering = (text: string): ChatReply => ({ steps: [{ type: "model_output", content: [{ type: "text", text }] }], text, calls: [], usage: { input: 20, output: 4 } });

/** Deps whose model answers with `reply(request, n)` and records its requests. */
function deps(reply: (req: ChatRequest, n: number) => ChatReply) {
  const requests: { tools: ChatRequest["tools"]; steps: Step[] }[] = [];
  const chat = async (req: ChatRequest) => {
    // the node keeps appending to the same array: keep what this call saw
    requests.push({ tools: req.tools, steps: [...req.steps] });
    return reply(req, requests.length);
  };
  return { deps: { chat, llm: vi.fn(), tools: kernel(), user: {} as IaraDeps["user"], lint: null } satisfies IaraDeps, requests };
}

const config = () => {
  const writer = vi.fn();
  return { config: { writer } as unknown as LangGraphRunnableConfig, writer };
};

describe("analystNode", () => {
  it("as an agent: works within its brief, with no workspace files and no open file", async () => {
    const systems: string[] = [];
    const { deps: d, requests } = deps((req) => {
      systems.push(req.system);
      return answering("orders has 7 rows");
    });
    await analystNode({ ...d, agent: { brief: "Only main.sales.orders; revenue excludes returns", charts: true } })(state({ context: { surface: "agent", path: "sales" } }), config().config);

    expect(requests[0].tools?.map((t) => t.name)).toEqual(["list_tables", "describe_table", "explain_sql", "run_sql", "search_ontology"]);
    expect(systems[0]).toContain("revenue excludes returns");
    const first = requests[0].steps[0] as Extract<Step, { type: "user_input" }>;
    expect(first.content[0].text).not.toContain("The open file");
  });

  it("gives run_sql's query with the tool event", async () => {
    const { deps: d } = deps((_, n) => (n === 1 ? calling(callStep("c1", "run_sql", { sql: "SELECT id FROM main.sales.orders" })) : answering("ok")));
    const { config: c, writer } = config();
    await analystNode(d)(state(), c);
    expect(writer.mock.calls.map(([e]) => e)).toContainEqual({ type: "tool", use: { agent: "analyst", tool: "run_sql", sql: "SELECT id FROM main.sales.orders" } });
  });

  it("uses the tools, then gives the model's text as the summary", async () => {
    const { deps: d, requests } = deps((_, n) => (n === 1 ? calling(callStep("c1", "describe_table", { name: "orders" })) : answering("main.sales.orders(id int64), 7 rows")));
    const { config: c, writer } = config();
    const out = await analystNode(d)(state({ findings: ["earlier"], steps: 3 }), c);

    expect(out).toEqual({
      handoffResult: "main.sales.orders(id int64), 7 rows",
      findings: ["earlier", "main.sales.orders(id int64), 7 rows"],
      steps: 5,
      usage: { input: 35, output: 7 },
    });
    expect(writer.mock.calls.map(([e]) => e)).toEqual([
      { type: "agent", agent: "analyst" },
      { type: "tool", use: { agent: "analyst", tool: "describe_table", target: "orders" } },
    ]);
    // the question and the open file first, then the call and its result
    const first = requests[0].steps[0] as Extract<Step, { type: "user_input" }>;
    expect(first.content[0].text).toContain("which table has the orders?");
    expect(first.content[0].text).toContain("SELECT 1");
    expect(requests[0].tools?.map((t) => t.name)).toEqual(["list_tables", "describe_table", "explain_sql", "run_sql", "list_files", "read_file", "search_ontology"]);
    expect(requests[1].steps.at(-1)).toMatchObject({ type: "function_result", call_id: "c1", name: "describe_table" });
  });

  it("gives a failing tool to the model as an error result", async () => {
    const { deps: d, requests } = deps((_, n) => (n === 1 ? calling(callStep("c1", "describe_table", { name: "nope" })) : answering("no such table")));
    await analystNode(d)(state(), config().config);
    expect(requests[1].steps.at(-1)).toMatchObject({ type: "function_result", result: "there is no table nope you can read", is_error: true });
  });

  it("cuts a big result to 6000 tokens", async () => {
    const { deps: d, requests } = deps((_, n) => (n === 1 ? calling(callStep("c1", "run_sql", { sql: "SELECT 1" })) : answering("done")));
    await analystNode(d)(state(), config().config);
    const result = requests[1].steps.at(-1) as Extract<Step, { type: "function_result" }>;
    expect(result.result.length).toBeLessThan(6000 * 4 + 20);
    expect(result.result).toMatch(/… \(cut\)$/);
  });

  it("asks for a summary without tools when the steps run out", async () => {
    const { deps: d, requests } = deps((req, n) => (req.tools ? calling(callStep(`c${n}`, "list_tables", {})) : answering("what I found")));
    const out = await analystNode(d)(state(), config().config);

    expect(requests).toHaveLength(ANALYST_STEPS + 1);
    expect(requests.slice(0, ANALYST_STEPS).every((r) => r.tools)).toBe(true);
    expect(requests.at(-1)!.tools).toBeUndefined();
    expect(requests.at(-1)!.steps.at(-1)).toMatchObject({ type: "user_input", content: [{ text: expect.stringContaining("Stop using tools") }] });
    expect(out).toMatchObject({ handoffResult: "what I found", steps: ANALYST_STEPS + 1 });
  });

  it("stops at the turn's step limit", async () => {
    const { deps: d, requests } = deps((req, n) => (req.tools ? calling(callStep(`c${n}`, "list_tables", {})) : answering("enough")));
    const out = await analystNode(d)(state({ steps: MAX_STEPS - 2 }), config().config);
    expect(requests.map((r) => !!r.tools)).toEqual([true, true, false]);
    expect(out.steps).toBe(MAX_STEPS + 1);
  });

  it("asks for a summary when its context grows past 60 000 tokens", async () => {
    tokens.steps = 60_001;
    try {
      const { deps: d, requests } = deps((req, n) => (req.tools ? calling(callStep(`c${n}`, "list_tables", {})) : answering("short")));
      await analystNode(d)(state(), config().config);
      expect(requests.map((r) => !!r.tools)).toEqual([true, false]);
    } finally {
      tokens.steps = 0;
    }
  });

  it("does not leave a call without its result when it stops", async () => {
    const { deps: d, requests } = deps((req) => (req.tools ? calling(callStep("a", "list_tables", {}) as never, callStep("b", "list_tables", {})) : answering("ok")));
    await analystNode(d)(state({ steps: MAX_STEPS - 1 }), config().config);
    const types = requests.at(-1)!.steps.map((s) => s.type);
    expect(types).toEqual(["user_input", "function_call", "function_call", "function_result", "function_result", "user_input"]);
  });

  it("falls back to a line when the model says nothing", async () => {
    const { deps: d } = deps(() => answering("  "));
    const out = await analystNode(d)(state(), config().config);
    expect(out.handoffResult).toBe("The analyst found nothing to report.");
  });
});
