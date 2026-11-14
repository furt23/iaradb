import { vi } from "vitest";

import type { IaraFileContext } from "@/lib/iara/protocol";

import type { ToolContext } from "../ai/tools";
import type { ChatReply, ChatRequest, IaraDeps, Step } from "./state";

/** Fakes for the graph and turn tests: a model that replays scripted replies and a kernel that knows one table. Never the network. */

type Call = Extract<Step, { type: "function_call" }>;

export const callStep = (id: string, name: string, args: Record<string, unknown>): Call => ({ type: "function_call", id, name, arguments: args });
export const calling = (...calls: Call[]): ChatReply => ({ steps: calls, text: "", calls, usage: { input: 10, output: 2 } });
export const answering = (text: string): ChatReply => ({ steps: [{ type: "model_output", content: [{ type: "text", text }] }], text, calls: [], usage: { input: 20, output: 4 } });

export const SQL_CONTEXT = { surface: "sql", path: "q.sql", query: "SELECT 1" } satisfies IaraFileContext;
export const NOTEBOOK_CONTEXT = { surface: "notebook", path: "n.ipynb", cells: [{ id: "c1", kind: "python", code: "x = 1" }], variables: [] } satisfies IaraFileContext;

/** The agents a scripted model tells apart by the start of the system prompt. */
const AGENTS: [prefix: string, agent: string][] = [
  ["You are Iara", "iara"],
  ["You are a data agent", "iara"],
  ["You explore", "analyst"],
  ["You write exactly one", "author"],
  ["Summarize this", "summary"],
];

/** A chat that answers each agent from its own queue, streaming the text as the real one does. */
export function scriptedChat(script: Record<string, ChatReply[]>) {
  const requests: { agent: string; steps: Step[]; tools: ChatRequest["tools"]; system: string }[] = [];
  const chat = async (req: ChatRequest): Promise<ChatReply> => {
    const agent = AGENTS.find(([prefix]) => req.system.startsWith(prefix))?.[1] ?? "unknown";
    // the node keeps appending to the same array: keep what this call saw
    requests.push({ agent, steps: [...req.steps], tools: req.tools, system: req.system });
    const reply = script[agent]?.shift();
    if (!reply) throw new Error(`no scripted reply left for ${agent}`);
    if (reply.text) req.onText?.(reply.text);
    return reply;
  };
  return { chat, requests };
}

/** A kernel with the table main.sales.orders; `sql.explain` plans everything. */
export function fakeKernel(): ToolContext {
  const request = async (method: string) => {
    switch (method) {
      case "catalog.list":
        return [{ name: "orders", full: "main.sales.orders", path: "", format: "parquet" }];
      case "catalog.table":
        return { name: "orders", full: "main.sales.orders", columns: [{ name: "id", type: "int64" }], num_rows: 7 };
      case "sql.explain":
        return { text: "plan" };
      default:
        return {};
    }
  };
  return { request: request as unknown as ToolContext["request"], allow: null };
}

/** Deps around a scripted model; the review model says ok. */
export function fakeDeps(script: Record<string, ChatReply[]>, user: IaraDeps["user"] = { email: "ana@example.com", name: "Ana", admin: false }) {
  const { chat, requests } = scriptedChat(script);
  const llm = vi.fn(async (_model: string, system: string, _prompt: string, _schema?: object) => (system.startsWith("Name this") ? { title: "Orders" } : { ok: true, notes: "" }));
  const deps: IaraDeps = { chat, llm, tools: fakeKernel(), user, lint: null };
  return { deps, requests, llm };
}
