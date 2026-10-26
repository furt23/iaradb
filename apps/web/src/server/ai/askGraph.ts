import "server-only";

import crypto from "node:crypto";

import type { ChartAgg, ChartKind } from "@iara/protocol";
import { Annotation, Command, END, interrupt, MemorySaver, START, StateGraph } from "@langchain/langgraph";

import { newLayoutItem } from "@/features/dashboards/editor/newWidget";
import { MAX_QUESTION, type AskAnswer, type AskDecision, type AskProposal, type AskReply, type AskStep } from "@/lib/dashboards/ask";
import { DATASET_NAME, datasetStatement } from "@/lib/dashboards/query";
import type { Dashboard, Dataset, Widget, WidgetData } from "@/lib/dashboards/types";
import { checkWidget, newWidgetId } from "@/lib/dashboards/widgets";

import { renderDashboard } from "../dashboards/run";
import { saveDataset, saveLayout, saveWidget } from "../dashboards/store";
import { CODE_MODEL, FAST_MODEL, type Llm } from "./models";
import { describeTable, explainSql, listTables, type ToolContext } from "./tools";

/**
 * Ask: a question becomes a dataset and a widget the user approves. The model
 * only proposes: grants and read-only are enforced by the engine through
 * `tools.allow`, and everything the model writes goes through the same
 * validators as the editor's own saves.
 */

const MAX_TABLES = 5;
const MAX_ATTEMPTS = 3;
// shortcut: the prompt lists at most this many tables, in catalog order; rank them by name when catalogs get bigger
const MAX_LISTED = 400;
const THREAD_TTL_MS = 30 * 60_000;

export interface AskDeps {
  llm: Llm;
  tools: ToolContext;
  /** the dashboard as it is now: names taken, layout, and where a proposal is saved */
  dashboard: Dashboard;
}

type Candidate = Pick<AskProposal, "dataset" | "widget" | "explanation">;
type Schema = Awaited<ReturnType<typeof describeTable>>;

// ---- what the models are asked for (JSON Schema, mirroring lib/dashboards/types.ts) ----

const CHART_KINDS: ChartKind[] = ["bar", "line", "area", "scatter", "histogram", "pie", "counter"];
const CHART_AGGS: ChartAgg[] = ["sum", "avg", "count", "min", "max", "none"];

const LINK_SCHEMA = {
  type: "object",
  properties: {
    tables: { type: "array", items: { type: "string" }, maxItems: MAX_TABLES, description: "full names, copied from the list" },
    answer: { type: "string", description: "only when the question is not about the data" },
  },
};

const CHART_SPEC_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: CHART_KINDS },
    x: { type: "string", description: "column of the query for the category or time axis; empty for a counter" },
    y: { type: "array", items: { type: "string" }, description: "numeric columns of the query; empty when counting rows" },
    agg: { type: "string", enum: CHART_AGGS },
    group: { type: ["string", "null"], description: "column that splits the values into series" },
    bins: { type: "integer", minimum: 1, description: "histogram buckets" },
  },
  required: ["kind", "x", "y", "agg"],
};

const SYNTH_SCHEMA = {
  type: "object",
  properties: {
    dataset: {
      type: "object",
      properties: {
        name: { type: "string", description: "lowercase letters, digits and _, at most 64" },
        sql: { type: "string", description: "one SELECT" },
      },
      required: ["name", "sql"],
    },
    widget: {
      anyOf: [
        {
          type: "object",
          properties: { kind: { type: "string", enum: ["chart"] }, title: { type: "string" }, spec: CHART_SPEC_SCHEMA },
          required: ["kind", "spec"],
        },
        {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["table"] },
            title: { type: "string" },
            columns: { type: "array", items: { type: "string" }, description: "columns of the query to show, in order; leave out for all" },
          },
          required: ["kind"],
        },
      ],
    },
    explanation: { type: "string", description: "one or two sentences: what the tile shows and how" },
  },
  required: ["dataset", "widget", "explanation"],
};

const LINK_SYSTEM = `You help a user add a tile to a dashboard from their data.
You get a question and the tables the user may read. Pick at most ${MAX_TABLES} tables that hold what the question needs, copying their full names from the list.
If the question is not about this data, or no table fits, leave "tables" out and put a short reply in "answer".`;

const SYNTH_SYSTEM = `You write one dashboard tile for Iara Studio: a dataset (a query) and a widget that draws it.
- dataset.sql is a single read-only SELECT in Iara SQL (an Apache DataFusion engine with DuckDB-style syntax). No other statement, no :placeholders.
- Write table names exactly as given in the list (the full name, catalog.schema.table). Use only the columns shown; never invent tables or columns.
- dataset.name is lowercase letters, digits and _ (at most 64) and is not one of the names already taken.
- The widget draws the rows the query returns, so its columns are the query's output columns (use aliases for computed ones).
- A chart's agg says how rows with the same x are combined: sum, avg, min, max, count (rows) or none (values as they are). Let the query do the grouping and use sum when it returns one row per x.
  - bar, line, area, pie: x is the category or time column, y the numeric columns, optional group splits series.
  - scatter: x and y are numeric columns. histogram: x is a numeric column, optional bins.
  - counter: one number. x is "", y has one numeric column with agg sum, avg, min or max; or y is empty with agg count.
- Use a table widget to list rows, optionally with the columns to show.`;

// ---- state ----

const field = <T>(init: T) => Annotation<T>({ reducer: (_, next) => next, default: () => init });

const State = Annotation.Root({
  question: Annotation<string>(),
  /** the tables picked, by full name */
  tables: field<string[]>([]),
  schemas: field<Schema[]>([]),
  /** what the code model last answered, unchecked */
  draft: field<unknown>(null),
  candidate: field<Candidate | null>(null),
  proposal: field<AskProposal | null>(null),
  /** why the last draft was refused */
  error: field<string | null>(null),
  attempts: field<number>(0),
  /** what the user asked to change, kept until the next change */
  feedback: field<string | null>(null),
  decision: field<AskDecision | null>(null),
  /** the end of an Ask that saved nothing: the answer, the reason it failed, or "cancelled" */
  message: field<string | null>(null),
  saved: field<{ dataset: string; widget: string } | null>(null),
  steps: Annotation<AskStep[]>({ reducer: (all, more) => all.concat(more), default: () => [] }),
});
type AskState = typeof State.State;

// ---- checks (pure) ----

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} is an object`);
  return v as Record<string, unknown>;
}

/** `name`, or `name_2`, `name_3`... when taken (the number never pushes it past 64 characters). */
export function freeName(name: string, taken: string[]): string {
  let free = name;
  for (let n = 2; taken.includes(free); n++) free = `${name.slice(0, 63 - String(n).length)}_${n}`;
  return free;
}

/** A widget id nothing in the dashboard uses (`id` if it is free). */
function freeId(widgets: Widget[], id = newWidgetId()): string {
  while (widgets.some((w) => w.id === id)) id = newWidgetId();
  return id;
}

/** The tables of `granted` the model named (full name, or a name only one table has), at most MAX_TABLES; names it made up are dropped. */
export function chosenTables(names: unknown, granted: { name: string; full: string }[]): string[] {
  if (!Array.isArray(names)) return [];
  const full = new Set<string>();
  for (const n of names) {
    if (typeof n !== "string") continue;
    const key = n.trim().toLowerCase();
    const byName = granted.filter((t) => t.name.toLowerCase() === key);
    const hit = granted.find((t) => t.full === key) ?? (byName.length === 1 ? byName[0] : undefined);
    if (hit) full.add(hit.full);
  }
  return [...full].slice(0, MAX_TABLES);
}

/** The decision from the browser (a trust boundary). */
export function checkedDecision(v: unknown): AskDecision {
  const d = obj(v, "the answer");
  if (d.kind === "approve" || d.kind === "cancel") return { kind: d.kind };
  if (d.kind !== "change") throw new Error("the answer is approve, change or cancel");
  const feedback = typeof d.feedback === "string" ? d.feedback.trim() : "";
  if (!feedback || feedback.length > MAX_QUESTION) throw new Error(`the change is 1 to ${MAX_QUESTION} characters`);
  return { kind: "change", feedback };
}

function linkPrompt(question: string, tables: { full: string; format: string }[]): string {
  const listed = tables.slice(0, MAX_LISTED).map((t) => `${t.full} (${t.format})`);
  return `Question: ${question}\n\nTables:\n${listed.join("\n")}`;
}

function schemaText(s: Schema): string {
  return `${s.full} (${s.num_rows} rows)\n${s.columns.map((c) => `  ${c.name}: ${c.type}`).join("\n")}`;
}

function synthPrompt(s: AskState, dashboard: Dashboard): string {
  const taken = dashboard.datasets.map((d) => d.name);
  const parts = [`Question: ${s.question}`, `Tables:\n${s.schemas.map(schemaText).join("\n\n")}`];
  if (taken.length) parts.push(`Dataset names already taken: ${taken.join(", ")}`);
  if (s.draft && (s.error || s.feedback)) parts.push(`Your previous answer:\n${JSON.stringify(s.draft)}`);
  if (s.error) parts.push(`It was refused: ${s.error}\nFix it.`);
  if (s.feedback) parts.push(`The user asks for this change: ${s.feedback}`);
  return parts.join("\n\n");
}

/** The draft as a candidate, or why it is not one: the model's answer is checked as an action's input is. */
async function checkDraft(draft: unknown, deps: AskDeps): Promise<Candidate> {
  const d = obj(draft, "the answer");
  const ds = obj(d.dataset, "dataset");
  if (typeof ds.name !== "string" || !DATASET_NAME.test(ds.name)) throw new Error("dataset name is 1 to 64 characters of a-z, 0-9 and _");
  if (typeof ds.sql !== "string") throw new Error("dataset sql is text");
  const sql = datasetStatement(ds.sql);
  const name = freeName(ds.name, deps.dashboard.datasets.map((x) => x.name));
  // the id and the dataset are the code's, whatever the model wrote
  const widget = checkWidget(freeId(deps.dashboard.widgets), { ...obj(d.widget, "widget"), dataset: name });
  if (widget.kind !== "chart" && widget.kind !== "table") throw new Error("widget kind is chart or table");
  await explainSql(deps.tools, sql);
  return { dataset: { name, sql }, widget, explanation: typeof d.explanation === "string" ? d.explanation.trim() : "" };
}

/** The widget's data from the unsaved dataset, read with the user's grants; a failure is the preview. */
async function previewOf({ dataset, widget }: Candidate, tools: ToolContext): Promise<WidgetData> {
  try {
    const unsaved: Dataset = { ...dataset, params: {} };
    const out = await renderDashboard({ datasets: [unsaved], widgets: [widget] }, {}, { request: tools.request, redact: false, source: "ask", allow: tools.allow });
    return out.widgets[widget.id] ?? { kind: "error", message: "nothing to preview" };
  } catch (e) {
    return { kind: "error", message: (e as Error).message };
  }
}

// ---- the graph ----

/** The graph for one dashboard; the checkpointer is shared, so a rebuilt graph resumes a thread. */
export function buildAskGraph(deps: AskDeps) {
  const { llm, tools, dashboard } = deps;

  async function link(s: AskState) {
    const granted = await listTables(tools);
    if (!granted.length) return { message: "there are no tables you can read" };
    const out = obj(await llm(FAST_MODEL, LINK_SYSTEM, linkPrompt(s.question, granted), LINK_SCHEMA), "the answer");
    const tables = chosenTables(out.tables, granted);
    if (!tables.length) return { message: (typeof out.answer === "string" && out.answer.trim()) || "no table you can read answers this question" };
    return { tables, steps: [{ step: "link", note: tables.join(", ") }] satisfies AskStep[] };
  }

  async function describe(s: AskState) {
    const schemas = await Promise.all(s.tables.map((t) => describeTable(tools, t)));
    return { schemas, steps: [{ step: "describe", note: `${schemas.length} table${schemas.length === 1 ? "" : "s"}` }] satisfies AskStep[] };
  }

  async function synthesize(s: AskState) {
    const draft = await llm(CODE_MODEL, SYNTH_SYSTEM, synthPrompt(s, dashboard), SYNTH_SCHEMA);
    return { draft, attempts: s.attempts + 1, steps: [{ step: "synthesize", note: `attempt ${s.attempts + 1}` }] satisfies AskStep[] };
  }

  async function validate(s: AskState) {
    try {
      return { candidate: await checkDraft(s.draft, deps), error: null };
    } catch (e) {
      const error = (e as Error).message;
      const done = s.attempts >= MAX_ATTEMPTS;
      return { error, ...(done && { message: `could not write a valid query: ${error}` }), steps: [{ step: "validate", note: error }] satisfies AskStep[] };
    }
  }

  async function preview(s: AskState) {
    const candidate = s.candidate!;
    return { proposal: { ...candidate, tables: s.tables, preview: await previewOf(candidate, tools), steps: s.steps } satisfies AskProposal };
  }

  // the node runs again from its top when resumed: nothing before interrupt() may have effects
  function review(s: AskState) {
    const decision = interrupt({ proposal: s.proposal }) as AskDecision;
    if (decision.kind === "change") return { decision, feedback: decision.feedback, attempts: 0, error: null };
    return { decision, ...(decision.kind === "cancel" && { message: "cancelled" }) };
  }

  async function apply(s: AskState) {
    const p = s.proposal!;
    // the dashboard may have changed while the user looked: never write over what is there now
    const dataset = freeName(p.dataset.name, dashboard.datasets.map((d) => d.name));
    const widget = { ...p.widget, id: freeId(dashboard.widgets, p.widget.id), dataset };
    await saveDataset(dashboard.slug, dataset, `${p.dataset.sql}\n`);
    await saveWidget(dashboard.slug, widget);
    await saveLayout(dashboard.slug, [...dashboard.layout, newLayoutItem(dashboard.layout, widget)]);
    return { saved: { dataset, widget: widget.id } };
  }

  return new StateGraph(State)
    .addNode("link", link)
    .addNode("describe", describe)
    .addNode("synthesize", synthesize)
    .addNode("validate", validate)
    .addNode("preview", preview)
    .addNode("review", review)
    .addNode("apply", apply)
    .addEdge(START, "link")
    .addConditionalEdges("link", (s) => (s.message ? END : "describe"))
    .addEdge("describe", "synthesize")
    .addEdge("synthesize", "validate")
    .addConditionalEdges("validate", (s) => (s.message ? END : s.error ? "synthesize" : "preview"))
    .addEdge("preview", "review")
    .addConditionalEdges("review", (s) => (s.decision?.kind === "approve" ? "apply" : s.decision?.kind === "change" ? "synthesize" : END))
    .addEdge("apply", END)
    .compile({ checkpointer: ask.saver });
}

type AskGraph = ReturnType<typeof buildAskGraph>;

// ---- threads ----

interface Thread {
  email: string;
  slug: string;
  /** the last time it was started or answered */
  at: number;
  /** an answer is being worked on: a second one (a double click) is refused */
  busy: boolean;
}

// shortcut: threads live in memory, lost on restart; persist them when Asks need to survive restarts
const globalForAsk = globalThis as unknown as { __iaraAsk?: { saver: MemorySaver; threads: Map<string, Thread> } };
/** Survives module reloads in development. */
const ask = (globalForAsk.__iaraAsk ??= { saver: new MemorySaver(), threads: new Map() });

function drop(thread: string): void {
  ask.threads.delete(thread);
  void ask.saver.deleteThread(thread);
}

/** Forgets the threads nobody answered for a while. */
function sweep(): void {
  const now = Date.now();
  for (const [id, t] of ask.threads) if (now - t.at > THREAD_TTL_MS) drop(id);
}

/** The thread of `email`; another user's, an old or a finished one is "not found". */
function owned(thread: string, email: string): Thread {
  sweep();
  const t = ask.threads.get(thread);
  if (!t || t.email.toLowerCase() !== email.toLowerCase()) throw new Error("there is no such question");
  return t;
}

/** The dashboard a thread was started on (its answer is read from that one). */
export function threadSlug(thread: string, email: string): string {
  return owned(thread, email).slug;
}

/** Runs the graph until the user's review or the end. */
async function run(deps: AskDeps, thread: string, input: Parameters<AskGraph["invoke"]>[0]): Promise<AskAnswer> {
  try {
    // the paused run reports what it waits for under __interrupt__, which the types do not list
    const out = (await buildAskGraph(deps).invoke(input, { configurable: { thread_id: thread } })) as AskState & { __interrupt__?: { value: unknown }[] };
    const waiting = out.__interrupt__?.[0]?.value as { proposal: AskProposal } | undefined;
    if (waiting) {
      Object.assign(ask.threads.get(thread)!, { at: Date.now(), busy: false });
      return { thread, proposal: waiting.proposal };
    }
    drop(thread);
    return out.saved ? { saved: out.saved } : { message: out.message ?? "nothing to add" };
  } catch (e) {
    drop(thread);
    throw e;
  }
}

/** Starts an Ask for `email`: runs to the proposal waiting for review, or to the end. */
export async function startAsk(deps: AskDeps, email: string, question: string): Promise<AskReply> {
  const text = typeof question === "string" ? question.trim() : "";
  if (!text || text.length > MAX_QUESTION) throw new Error(`the question is 1 to ${MAX_QUESTION} characters`);
  const thread = crypto.randomUUID();
  sweep();
  ask.threads.set(thread, { email, slug: deps.dashboard.slug, at: Date.now(), busy: true });
  // before a review nothing can have been saved
  return (await run(deps, thread, { question: text })) as AskReply;
}

/** Answers the review of a thread: saves, asks for another proposal, or ends it. */
export async function resumeAsk(deps: AskDeps, thread: string, email: string, decision: AskDecision): Promise<AskAnswer> {
  const t = owned(thread, email);
  if (t.slug !== deps.dashboard.slug) throw new Error("there is no such question");
  const checked = checkedDecision(decision);
  if (t.busy) throw new Error("this question is already being answered");
  t.busy = true;
  return run(deps, thread, new Command({ resume: checked }));
}
