import type { ChartData, ChartSpec } from "@iara/protocol";
import { z } from "zod";

/**
 * What the browser and the Iara agent exchange: the request of POST /api/iara,
 * its server-sent events and what the panel shows of a conversation. The
 * request is parsed with these schemas on the server (a trust boundary); the
 * file context is only prompt text, never a permission.
 */

export const MAX_MESSAGE = 4000;
const MAX_CODE = 20_000;
const MAX_CONTEXT_TEXT = 200_000;

export type IaraSurface = "notebook" | "sql" | "dashboard" | "agent";
export type IaraAgent = "iara" | "analyst" | "author" | "reviewer" | "observer";

const id = z.string().min(1).max(128);
const text = (max: number) => z.string().max(max);

export const ContextCell = z.object({
  id,
  kind: z.enum(["python", "sql", "markdown"]),
  name: text(128).optional(),
  code: text(MAX_CODE),
  /** a short summary of the cell's output, cut by the browser */
  output: text(4000).optional(),
  status: z.enum(["idle", "ok", "error", "stale"]).optional(),
  /** the notebook's setup cell: Iara reads it and never edits it */
  setup: z.boolean().optional(),
});
export type ContextCell = z.infer<typeof ContextCell>;

export const FileContext = z.discriminatedUnion("surface", [
  z.object({
    surface: z.literal("notebook"),
    path: text(1024),
    cells: z.array(ContextCell).max(500),
    selectedCellId: id.nullable().optional(),
    variables: z.array(z.object({ name: text(256), type: text(256), summary: text(512).optional() })).max(500),
    /** false while the notebook's cluster is not running: changes can be made, cells cannot run */
    canRun: z.boolean().optional(),
  }),
  z.object({
    surface: z.literal("sql"),
    path: text(1024),
    query: text(MAX_CODE),
    /** the last result (columns and first rows) or error, as text */
    result: text(8000).optional(),
  }),
  z.object({
    surface: z.literal("dashboard"),
    path: text(1024),
    title: text(200),
    /** the tab the user is on */
    view: z.enum(["canvas", "data", "model"]),
    selectedWidgetId: id.nullable().optional(),
    datasets: z
      .array(
        z.object({
          name: text(64),
          sql: text(MAX_CODE),
          /** made of cleaning steps: its SQL cannot be rewritten */
          recipe: z.boolean().optional(),
          /** null: not read yet */
          columns: z.array(z.object({ name: text(256), type: text(256) })).max(1000).nullable(),
        }),
      )
      .max(300),
    /** the semantic model's source */
    model: text(MAX_CONTEXT_TEXT),
    /** each widget's file, and how it drew last ("ok", or why not) */
    widgets: z.array(z.object({ id, json: text(MAX_CODE), status: text(1000).optional() })).max(300),
    layout: z.array(z.object({ widget: id, x: z.number(), y: z.number(), w: z.number(), h: z.number() })).max(300),
  }),
  /** an agent's test chat: the agent is read on the server by its slug (`path`); it answers, it never changes files */
  z.object({ surface: z.literal("agent"), path: text(64) }),
]);
export type IaraFileContext = z.infer<typeof FileContext>;

/** One replacement in a cell's or the query's code: `old`, copied from the code, occurs there exactly once and becomes `new`. An empty `old` writes into empty code. */
export const Edit = z.object({ old: text(MAX_CODE), new: text(MAX_CODE) });
export type IaraEdit = z.infer<typeof Edit>;
const edits = z.array(Edit).min(1).max(50);

const place = z.object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() });

/** One step of a change to a dashboard. The widget is checked against the widget files' format before the user sees it. */
export const DashboardOp = z.discriminatedUnion("op", [
  /** adds the dataset, or replaces the query of the one of that name */
  z.object({ op: z.literal("set_dataset"), name: text(64), sql: text(MAX_CODE) }),
  z.object({ op: z.literal("remove_dataset"), name: text(64) }),
  /** lines of the model: measures (`name = expression`), `relate(many.column, one.column)`, `calendar`, `param` */
  z.object({ op: z.literal("add_model_lines"), lines: z.array(text(2000)).min(1).max(50) }),
  z.object({ op: z.literal("edit_model"), edits }),
  /** id null: a new widget; `place`: where it sits (absent: below everything, or where it is) */
  z.object({ op: z.literal("set_widget"), id: id.nullable(), widget: z.record(z.string(), z.unknown()), place: place.optional() }),
  z.object({ op: z.literal("remove_widget"), id }),
  z.object({ op: z.literal("move_widget"), id, ...place.shape }),
]);
export type DashboardOp = z.infer<typeof DashboardOp>;

/** A change the author proposes; the browser shows it as a diff in the file and applies it once the user keeps it. */
export const Change = z.discriminatedUnion("action", [
  /** afterCellId null: at the end of the notebook */
  z.object({ action: z.literal("insert_cell"), kind: z.enum(["python", "sql", "markdown"]), code: text(MAX_CODE), afterCellId: id.nullable(), run: z.boolean() }),
  z.object({ action: z.literal("edit_cell"), cellId: id, edits, run: z.boolean() }),
  z.object({ action: z.literal("run_cell"), cellId: id }),
  z.object({ action: z.literal("edit_query"), edits, run: z.boolean() }),
  /** several steps that only make sense together, approved and applied as one */
  z.object({ action: z.literal("edit_dashboard"), operations: z.array(DashboardOp).min(1).max(30) }),
]);
export type IaraChange = z.infer<typeof Change>;

export interface IaraProposal {
  id: string;
  change: IaraChange;
  /** the author's one or two sentences on what the change does */
  explanation: string;
  /** what the reviewer noted (a warning shown on the card), if anything */
  review: string | null;
  /** 1 for the first proposal of a task, 2+ for fixes after a failed run */
  attempt: number;
}

/** What happened when the browser applied an approved change. */
export const Outcome = z.object({
  applied: z.boolean(),
  /** the cell the change made or edited */
  cellId: id.optional(),
  ran: z.boolean(),
  status: z.enum(["ok", "error"]).optional(),
  /** the output's summary (columns and first rows, stdout tail) */
  output: text(8000).optional(),
  error: text(4000).optional(),
});
export type IaraOutcome = z.infer<typeof Outcome>;

export const Decision = z.discriminatedUnion("kind", [
  /** run: false is "apply only" */
  z.object({ kind: z.literal("approve"), run: z.boolean(), outcome: Outcome }),
  z.object({ kind: z.literal("reject"), feedback: text(MAX_MESSAGE).optional() }),
]);
export type IaraDecision = z.infer<typeof Decision>;

export const IaraRequest = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), threadId: id.nullable(), fileId: id, text: z.string().trim().min(1).max(MAX_MESSAGE), context: FileContext }),
  z.object({ kind: z.literal("decision"), threadId: id, proposalId: id, decision: Decision, context: FileContext }),
]);
export type IaraRequest = z.infer<typeof IaraRequest>;

/** The context window of the conversation and what the last turn cost, in tokens. */
export interface IaraUsage {
  /** tokens of the conversation as Iara sees it now */
  context: number;
  budget: number;
  /** summed over every agent of the last turn */
  turnInput: number;
  turnOutput: number;
}

/** The server-sent events of POST /api/iara, in order: thread, then any of agent/text/tool/memory/usage, then approval, done or failed. */
export type IaraEvent =
  | { event: "thread"; data: { id: string; title: string } }
  /** who works now (the panel words it in the user's language) */
  | { event: "agent"; data: { agent: IaraAgent } }
  /** Iara's reply, streamed */
  | { event: "text"; data: { delta: string } }
  /** a tool an agent used: a data tool name (list_tables, describe_table, explain_sql, run_sql, search_ontology, ...), its table or file, if any, and the ontology terms it gave */
  | { event: "tool"; data: IaraToolUse }
  /** a piece of an agent's reasoning summary; deltas with the same id are one thought */
  | { event: "thought"; data: { agent: IaraAgent; id: string; delta: string } }
  | { event: "memory"; data: { action: "saved" | "forgotten"; memory: IaraMemory } }
  /** a chart an agent drew from a query, shown under its answer */
  | { event: "chart"; data: IaraChart }
  | { event: "usage"; data: IaraUsage }
  /** the turn waits for the user's decision (POST again with kind "decision") */
  | { event: "approval"; data: IaraProposal }
  | { event: "done"; data: { messageId: string } }
  | { event: "failed"; data: { message: string } };

/** A term of a team's ontology an agent read (search_ontology gave it). */
export interface IaraKnowledge {
  /** the team's name */
  team: string;
  term: string;
  /** false: a draft nobody reviewed */
  certified: boolean;
  /** the start of the term's description */
  description: string;
}

export interface IaraToolUse {
  agent: IaraAgent;
  tool: string;
  target?: string;
  /** run_sql: the query */
  sql?: string;
  /** search_ontology: the terms it gave */
  knowledge?: IaraKnowledge[];
}

/** One step of Iara's work on a message, in order: a data tool an agent used, or what an agent thought (the model's reasoning summary). */
export type IaraStep = ({ kind: "tool" } & IaraToolUse) | { kind: "thought"; agent: IaraAgent; id: string; text: string };

export interface IaraMemory {
  id: string;
  text: string;
  created: number;
}

/** A chart drawn from a query's rows: `data` holds the columns `spec` names (x, group, values), already aggregated by the query. */
export interface IaraChart {
  id: string;
  title: string;
  spec: ChartSpec;
  /** the x column's type, so dates draw as time */
  xType: string;
  data: ChartData;
  sql: string;
}

export interface IaraProposalRecord extends IaraProposal {
  decision: "pending" | "approved" | "rejected";
  outcome?: IaraOutcome;
}

export interface IaraMessage {
  id: string;
  role: "user" | "iara";
  text: string;
  at: number;
  /** Iara's: the steps of the turn (tools and thoughts), its memory events, and the proposals in order */
  steps?: IaraStep[];
  memories?: { action: "saved" | "forgotten"; memory: IaraMemory }[];
  proposals?: IaraProposalRecord[];
  charts?: IaraChart[];
}

export interface IaraThreadSummary {
  id: string;
  fileId: string;
  surface: IaraSurface;
  title: string;
  updated: number;
}

export interface IaraThreadView extends IaraThreadSummary {
  messages: IaraMessage[];
  /** the proposal waiting for the user, if the last turn stopped at one */
  pending: IaraProposal | null;
  usage: IaraUsage;
}
