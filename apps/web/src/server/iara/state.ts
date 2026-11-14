import "server-only";

import { Annotation, type LangGraphRunnableConfig } from "@langchain/langgraph";

import type { IaraAgent, IaraChange, IaraChart, IaraDecision, IaraFileContext, IaraMemory, IaraProposal, IaraToolUse, IaraUsage } from "@/lib/iara/protocol";

import type { StudioUser } from "../auth/access";
import type { ToolContext } from "../ai/tools";

/**
 * The Iara graph: iara talks with the user and hands work to the analyst
 * (reads data) or the author (writes a change), the reviewer checks the
 * change, the user approves it (interrupt), the browser applies it and the
 * observer reads what happened. One LangGraph thread is one turn; the
 * conversation itself lives in the thread store.
 */

// ---- limits ----

/** model calls of every agent in one turn */
export const MAX_STEPS = 24;
/** reviewer refusals before the change goes to the user with the reviewer's notes */
export const MAX_REVIEWS = 2;
/** fixes after a failed run, each approved again */
export const MAX_FIXES = 2;
/** model calls of the analyst for one question */
export const ANALYST_STEPS = 6;
/** model calls of the author for one change */
export const AUTHOR_STEPS = 4;

// ---- the conversation as the agents keep it (server/ai/models.ts maps it to the API's items) ----

export type TextPart = { type: "text"; text: string };
export type Step =
  | { type: "user_input"; content: TextPart[] }
  | { type: "model_output"; content?: TextPart[] }
  /** the model's reasoning, encrypted (its id and content), sent back so the next call can read it */
  | { type: "thought"; signature?: string; summary?: unknown[]; id?: string }
  | { type: "function_call"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: "function_result"; call_id: string; name?: string; result: string; is_error?: boolean };

/** A function the model may call (Interactions `type: "function"` tool). */
export interface FunctionDecl {
  type: "function";
  name: string;
  description: string;
  /** JSON Schema of the arguments */
  parameters: object;
}

export interface ChatUsage {
  input: number;
  output: number;
}

export interface ChatRequest {
  model: string;
  system: string;
  steps: Step[];
  tools?: FunctionDecl[];
  /** each text delta of the reply, as it arrives */
  onText?: (delta: string) => void;
  /** each delta of the model's reasoning summary, by reasoning item id */
  onThought?: (id: string, delta: string) => void;
  signal?: AbortSignal;
}

export interface ChatReply {
  /** the steps the model added (thoughts, text, function calls), in order */
  steps: Step[];
  /** the reply's text, joined */
  text: string;
  calls: Extract<Step, { type: "function_call" }>[];
  usage: ChatUsage;
}

/** One streamed model call (server/ai/models.ts `openaiChat`; a fake in tests). */
export type Chat = (req: ChatRequest) => Promise<ChatReply>;

/** What the agents send to the browser while they work (LangGraph custom stream). */
export type Emit =
  | { type: "agent"; agent: IaraAgent }
  | { type: "text"; delta: string }
  | { type: "tool"; use: IaraToolUse }
  | { type: "thought"; agent: IaraAgent; id: string; delta: string }
  | { type: "memory"; action: "saved" | "forgotten"; memory: IaraMemory }
  | { type: "chart"; chart: IaraChart }
  | { type: "usage"; usage: IaraUsage };

/** Sends `e` to the browser (a no-op outside a streamed run, e.g. in tests that pass no writer). */
export function emit(config: LangGraphRunnableConfig, e: Emit): void {
  config.writer?.(e);
}

export const addUsage = (a: ChatUsage, b: ChatUsage): ChatUsage => ({ input: a.input + b.input, output: a.output + b.output });

/** What the graph's nodes need; built per request (the user's grants, kernel and models). */
export interface IaraDeps {
  chat: Chat;
  /** structured output (server/ai/models.ts `openaiLlm`) */
  llm: import("../ai/models").Llm;
  tools: ToolContext;
  user: StudioUser;
  /** Python lint of a notebook cell (null: no notebook, e.g. the SQL editor) */
  lint: ((code: string, kind: "python" | "sql" | "markdown") => Promise<{ severity: string; message: string }[]>) | null;
  /** an agent's chat: its definition as prompt text (server/agents/brief.ts) and whether it may draw charts; `tools` is already narrowed to its tables */
  agent?: { brief: string; charts: boolean };
}

// ---- state ----

const field = <T>(init: T) => Annotation<T>({ reducer: (_, next) => next, default: () => init });

/** iara's open handoff: the function call the analyst or the author answers */
export interface Handoff {
  callId: string;
  name: "ask_analyst" | "propose_change";
  /** the question for the analyst or the task for the author */
  request: string;
}

export const IaraState = Annotation.Root({
  /** the browser's view of the open file (refreshed when a decision comes back) */
  context: Annotation<IaraFileContext>(),
  /** iara's conversation with the model; starts as the thread's and grows during the turn */
  history: field<Step[]>([]),
  /** the older turns, summarized when the history outgrew the budget */
  summary: field<string | null>(null),
  memories: field<IaraMemory[]>([]),

  handoff: field<Handoff | null>(null),
  /** the analyst's or the observer's answer to the handoff, for iara's function result */
  handoffResult: field<string | null>(null),
  /** what the analyst found this turn (the author reads it) */
  findings: field<string[]>([]),

  /** the author's change and its explanation, before review */
  draft: field<{ change: IaraChange; explanation: string } | null>(null),
  /** why the reviewer or the run refused the last draft (the author fixes it) */
  refusal: field<string | null>(null),
  reviewNotes: field<string | null>(null),
  reviews: field<number>(0),
  fixes: field<number>(0),
  proposal: field<IaraProposal | null>(null),
  decision: field<IaraDecision | null>(null),

  /** model calls so far this turn */
  steps: field<number>(0),
  usage: field<ChatUsage>({ input: 0, output: 0 }),
  /** iara's tokens of context at her last call */
  contextTokens: field<number>(0),
  /** iara's last reply (streamed as it came) */
  reply: field<string>(""),
});
export type IaraGraphState = typeof IaraState.State;
export type IaraUpdate = typeof IaraState.Update;
