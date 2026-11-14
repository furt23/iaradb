import "server-only";

import type { LangGraphRunnableConfig } from "@langchain/langgraph";

import type { IaraMemory } from "@/lib/iara/protocol";

import { CODE_MODEL, FAST_MODEL } from "../../ai/models";
import { CHART_TOOL, drawChart } from "../../agents/chart";
import { learnOntology, teachableTeams, type Teachable } from "../../ontology/learn";
import { addMemory, removeMemory } from "../memory";
import { contextText, DASHBOARD_API, NOTEBOOK_API, resultStep, userStep } from "../prompt";
import { addUsage, emit, MAX_STEPS, type ChatReply, type ChatUsage, type FunctionDecl, type Handoff, type IaraDeps, type IaraGraphState, type IaraUpdate, type Step } from "../state";
import { COMPACT_AT, CONTEXT_BUDGET, countSteps, cutToTokens } from "../tokens";

/** tokens of the user's memories in the prompt */
const MEMORY_TOKENS = 4000;
/** tokens of the older turns (and the earlier summary) given to the model that summarizes them */
const SUMMARY_INPUT_TOKENS = 60_000;
/** characters of one function result kept when older turns are summarized */
const RESULT_CHARS = 1000;

const fn = (name: string, description: string, arg: string, argDescription: string): FunctionDecl => ({
  type: "function",
  name,
  description,
  parameters: { type: "object", properties: { [arg]: { type: "string", description: argDescription } }, required: [arg] },
});

export const IARA_TOOLS: FunctionDecl[] = [
  fn(
    "ask_analyst",
    "Ask the data analyst about the user's tables (which exist, their columns, values, counts, whether a query works), what a business term or metric means in the teams' ontology, or the workspace's notebooks and SQL files (which exist, what they do). It reads them and answers with facts.",
    "question",
    "a complete question; the analyst does not see this conversation",
  ),
  fn(
    "propose_change",
    "Have a change written for the open file: add or edit a notebook cell, run a cell, edit the SQL editor's query, or change a dashboard (its datasets, measures, relationships, charts, tables, filters and layout, together in one change). The user approves it before anything happens and you get the outcome back.",
    "task",
    "what to build, with the tables and columns to use (from the analyst) and whether to run it; the author does not see this conversation",
  ),
  fn("remember", "Save a lasting fact or preference the user stated, for future conversations.", "text", "one short sentence"),
  fn("forget", "Forget something you remembered, when the user asks.", "id", "the id shown before the memory"),
];

const STRING_LIST = { type: "array", items: { type: "string" } };

/** Offered only to users whose rules may go into a team's ontology (see teachingText). */
export const LEARN_TOOL: FunctionDecl = {
  type: "function",
  name: "learn_ontology",
  description:
    "Write a business rule the user stated into their team's ontology, so every assistant and teammate uses it: what a term or metric means, how it is computed, which columns hold it, how two tables join. Written at once, no approval.",
  parameters: {
    type: "object",
    properties: {
      team: { type: "string", description: "the team id, from the list you were given" },
      team_name: { type: "string", description: "the team's name as people read it, only for a new team" },
      terms: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            description: { type: "string", description: "the rule, as the user stated it" },
            synonyms: STRING_LIST,
            columns: { ...STRING_LIST, description: "catalog.schema.table.column, exactly as the analyst gave them; empty when the rule names none" },
            sql: { type: "string", description: "the expression that computes it, or empty" },
          },
          required: ["name", "description", "synonyms", "columns", "sql"],
        },
      },
      joins: {
        type: "array",
        items: {
          type: "object",
          properties: { left: { type: "string" }, right: { type: "string" }, description: { type: "string" } },
          required: ["left", "right", "description"],
        },
      },
    },
    required: ["team", "terms", "joins"],
  },
};

/** What iara is told about learn_ontology for this user; null when nothing they say may go into an ontology. */
export function teachingText(t: Teachable): string | null {
  if (!t.teams.length && !t.anyTeam) return null;
  const teams = t.teams.map((x) => `${x.team} (${x.name})`).join(", ");
  const where = t.anyTeam ? `any team (${teams ? `these exist: ${teams}; ` : ""}a new one gets a new id)` : teams;
  return `This user owns the ontology of ${where}.
You decide what goes into it, with learn_ontology, without asking: when they state a lasting business rule of their team (what a term or metric means, how it is computed, which columns hold it, how tables join) that someone else asking the same question would need. Not one-off requests, personal preferences (remember those), nor your own guesses or inferences. Check the columns with the analyst first, unless the rule names none. Pick the team the rule belongs to. Then say in one short line that you added it.`;
}

const SUMMARY_SYSTEM = "Summarize this conversation for yourself, keeping facts, decisions, table and column names and open questions.";
const OUT_OF_STEPS = "You are out of steps for this message. Tell the user briefly where things stand.";

const SYSTEM = `You are Iara, the data assistant of Iara Studio: a workspace of notebooks, a SQL editor and dashboards on the Iara engine.
SQL is Apache DataFusion with DuckDB-style syntax. Python cells use the \`iara\` DataFrame API, close to polars (below).
Answer in the user's language. Be concise; markdown is fine.

You never read data yourself, so never guess a table, a column or a value:
- ask_analyst for anything about the user's tables, columns, values or other notebooks and SQL files you do not know yet, and for what a business term or metric means: the analyst reads the teams' ontology. What the analyst answered earlier in this conversation still holds: reuse it, and ask only for what is new.
- When an answer or a change rests on a definition from the ontology, say which term and team it came from, and say so when it is a draft.
- propose_change to add or edit a notebook cell, run a cell, edit the SQL editor's query, or change a dashboard. The user approves every change, and you get back what happened. Describe the task completely.
- remember for lasting facts or preferences the user states, not one-off details. forget when they ask you to.
Never say you did something you did not do: a change is done only when its outcome says so.

${NOTEBOOK_API}`;

/** Index where the kept steps start: the last `keepTurns` user messages stay whole, so a call never loses its result. 0 when nothing can be dropped. */
export function compactionCut(history: Step[], keepTurns = 2): number {
  const starts = history.flatMap((s, i) => (s.type === "user_input" ? [i] : []));
  return starts.length > keepTurns ? starts[starts.length - keepTurns] : 0;
}

/** A step as the lines the summarizer reads (thoughts are left out). */
function transcript(step: Step): { role: string; text: string }[] {
  switch (step.type) {
    case "user_input":
      return [{ role: "user", text: step.content.map((c) => c.text).join("") }];
    case "model_output":
      return [{ role: "iara", text: (step.content ?? []).map((c) => c.text).join("") }];
    case "function_call":
      return [{ role: "call", text: `${step.name} ${JSON.stringify(step.arguments)}` }];
    case "function_result":
      return [{ role: "result", text: step.result.slice(0, RESULT_CHARS) }];
    case "thought":
      return [];
  }
}

type Compacted = { history: Step[]; summary: string | null; usage: ChatUsage };

/** Summarizes the older turns once the history passes COMPACT_AT of the budget; the summary then stands in for them. */
async function compact(deps: IaraDeps, history: Step[], summary: string | null, signal?: AbortSignal): Promise<Compacted> {
  const same = { history, summary, usage: { input: 0, output: 0 } };
  if ((await countSteps(history)) <= CONTEXT_BUDGET * COMPACT_AT) return same;
  const cut = compactionCut(history);
  if (!cut) return same;
  const dropped = JSON.stringify(history.slice(0, cut).flatMap(transcript));
  const input = await cutToTokens(`${summary ? `Earlier summary:\n${summary}\n\n` : ""}Conversation:\n${dropped}`, SUMMARY_INPUT_TOKENS);
  const reply = await deps.chat({ model: FAST_MODEL, system: SUMMARY_SYSTEM, steps: [userStep(input)], signal });
  // an empty summary would lose the older turns for nothing
  return reply.text.trim() ? { history: history.slice(cut), summary: reply.text.trim(), usage: reply.usage } : { ...same, usage: reply.usage };
}

async function systemPrompt(memories: IaraMemory[], summary: string | null, file: string, dashboard: boolean, teaching: string | null): Promise<string> {
  const known = await cutToTokens(memories.map((m) => `- [${m.id}] ${m.text}`).join("\n"), MEMORY_TOKENS);
  return [SYSTEM, dashboard && DASHBOARD_API, teaching, `What you remember about this user:\n${known || "(nothing yet)"}`, summary && `Earlier in this conversation (summarized):\n${summary}`, `The open file:\n${file}`]
    .filter(Boolean)
    .join("\n\n");
}

/** An agent of the Studio's Agents section only asks the analyst. */
export const AGENT_TOOLS: FunctionDecl[] = IARA_TOOLS.filter((t) => t.name === "ask_analyst");

const AGENT_SYSTEM = `You are a data agent of Iara Studio, made for one subject (below). People ask you about their data; answer in their language, concisely, with the numbers that answer the question (a small markdown table when it helps).
You never read data yourself, so never guess a table, a column or a value: ask_analyst for every fact, with a complete question that names the tables to use. What the analyst answered earlier in this conversation still holds: reuse it, and ask only for what is new.
Answer only within the agent's subject and tables. When a question is outside them, say so in one line and say what you can answer.
When an answer rests on a definition from the ontology, say which term it came from.
Never say you did something you did not do.`;

function agentPrompt(agent: string, summary: string | null): string {
  return [AGENT_SYSTEM, agent, summary && `Earlier in this conversation (summarized):\n${summary}`].filter(Boolean).join("\n\n");
}

const argText = (args: Record<string, unknown> | undefined, key: string) => (typeof args?.[key] === "string" ? (args[key] as string) : "");

/** Iara: talks with the user, remembers what they ask her to, and hands data questions to the analyst and changes to the author. A handoff ends her turn here; the answer comes back as the function result when she runs again. */
export function iaraNode(deps: IaraDeps) {
  return async (s: IaraGraphState, config: LangGraphRunnableConfig): Promise<IaraUpdate> => {
    emit(config, { type: "agent", agent: "iara" });
    let history = s.history;
    if (s.handoff && s.handoffResult !== null) history = [...history, resultStep({ id: s.handoff.callId, name: s.handoff.name }, s.handoffResult)];
    let { summary, memories, reply, contextTokens } = s;
    let calls = 0;
    let used: ChatUsage = { input: 0, output: 0 };
    const file = await contextText(s.context, 30_000);
    // an agent answers the same for everyone: no memories, no ontology lessons, no changes
    const agent = s.context.surface === "agent" ? (deps.agent?.brief ?? "") : null;
    const charts = agent !== null && deps.agent?.charts === true;
    const teaching = agent === null ? teachingText(await teachableTeams(deps.user, deps.tools)) : null;
    const tools = agent !== null ? (charts ? [...AGENT_TOOLS, CHART_TOOL] : AGENT_TOOLS) : teaching ? [...IARA_TOOLS, LEARN_TOOL] : IARA_TOOLS;
    const system = async () => (agent !== null ? agentPrompt(agent, summary) : systemPrompt(memories, summary, file, s.context.surface === "dashboard", teaching));

    /** One model call; `extra` steps are asked about but not kept in the history. */
    async function ask(tools: FunctionDecl[] | undefined, extra: Step[] = []): Promise<ChatReply> {
      let started = false;
      const r = await deps.chat({
        model: CODE_MODEL,
        system: await system(),
        steps: [...history, ...extra],
        tools,
        onText: (d) => {
          if (!d) return;
          // a new paragraph when the reply goes on after a tool call
          if (!started && reply) {
            reply += "\n\n";
            emit(config, { type: "text", delta: "\n\n" });
          }
          started = true;
          reply += d;
          emit(config, { type: "text", delta: d });
        },
        onThought: (id, delta) => emit(config, { type: "thought", agent: "iara", id, delta }),
        signal: config.signal,
      });
      calls++;
      used = addUsage(used, r.usage);
      history = [...history, ...r.steps];
      contextTokens = r.usage.input;
      const turn = addUsage(s.usage, used);
      emit(config, { type: "usage", usage: { context: contextTokens, budget: CONTEXT_BUDGET, turnInput: turn.input, turnOutput: turn.output } });
      return r;
    }

    const finish = (more: IaraUpdate = {}): IaraUpdate => ({
      history,
      summary,
      memories,
      reply,
      handoff: null,
      handoffResult: null,
      steps: s.steps + calls,
      usage: addUsage(s.usage, used),
      contextTokens,
      ...more,
    });

    /** remember, forget and learn_ontology run here; an error is a result the model reads. */
    async function memoryCall(call: Extract<Step, { type: "function_call" }>): Promise<Step> {
      try {
        if (call.name === "remember") {
          const memory = await addMemory(deps.user, argText(call.arguments, "text"));
          if (!memories.some((m) => m.id === memory.id)) memories = [...memories, memory];
          emit(config, { type: "memory", action: "saved", memory });
          return resultStep(call, "saved");
        }
        if (call.name === "forget") {
          const memory = await removeMemory(deps.user, argText(call.arguments, "id"));
          if (!memory) return resultStep(call, "there is no memory with that id", true);
          memories = memories.filter((m) => m.id !== memory.id);
          emit(config, { type: "memory", action: "forgotten", memory });
          return resultStep(call, "forgotten");
        }
        // never offered to a user who may not teach; learnOntology checks again against the file
        if (call.name === "learn_ontology" && teaching) return resultStep(call, await learnOntology(deps.user, call.arguments, { tools: deps.tools }));
        return resultStep(call, `unknown tool: ${call.name}`, true);
      } catch (e) {
        return resultStep(call, (e as Error).message, true);
      }
    }

    while (s.steps + calls < MAX_STEPS) {
      const compacted = await compact(deps, history, summary, config.signal);
      ({ history, summary } = compacted);
      used = addUsage(used, compacted.usage);

      const r = await ask(tools);
      if (!r.calls.length) return finish();

      const results: Step[] = [];
      let handoff: Handoff | null = null;
      for (const call of r.calls) {
        if (call.name === "ask_analyst" || call.name === "propose_change") {
          const key = call.name === "ask_analyst" ? "question" : "task";
          const request = argText(call.arguments, key).trim();
          if (!request) results.push(resultStep(call, `${key} is the text of the request`, true));
          else if (handoff) results.push(resultStep(call, "one handoff at a time: call it again after this one", true));
          else handoff = { callId: call.id, name: call.name, request };
        } else if (call.name === "show_chart" && charts) {
          const drawn = await drawChart(deps.tools, call.arguments);
          if ("chart" in drawn) emit(config, { type: "chart", chart: drawn.chart });
          results.push("chart" in drawn ? resultStep(call, `shown under your answer (${drawn.chart.data.rows.length} rows)`) : resultStep(call, drawn.error, true));
        } else {
          results.push(await memoryCall(call));
        }
      }
      history = [...history, ...results];
      if (handoff) {
        // a new change starts from nothing: no draft, refusal or review of an earlier one
        const fresh = handoff.name === "propose_change" && { draft: null, refusal: null, reviewNotes: null, reviews: 0, fixes: 0, proposal: null, decision: null };
        return finish({ handoff, ...fresh });
      }
    }

    // she must still answer the user, so this call may pass MAX_STEPS by one
    await ask(undefined, [userStep(OUT_OF_STEPS)]);
    return finish();
  };
}
