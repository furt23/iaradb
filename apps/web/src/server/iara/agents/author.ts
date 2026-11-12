import "server-only";

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";

import { Change } from "@/lib/iara/protocol";

import { CODE_MODEL } from "../../ai/models";
import { contextText, DASHBOARD_API, NOTEBOOK_API, resultStep, userStep } from "../prompt";
import { addUsage, AUTHOR_STEPS, emit, MAX_STEPS, type ChatUsage, type FunctionDecl, type IaraDeps, type IaraGraphState, type IaraUpdate, type Step } from "../state";
import { cutToTokens } from "../tokens";
import { dataTools, runDataTool } from "../tools";
import { checkChange } from "./reviewer";

/** tokens of one tool result the author keeps */
const RESULT_TOKENS = 6000;

const AUTHOR_SYSTEM = `You write exactly one change for the user's open file in Iara Studio, then submit it with submit_change.
- Notebook cells are python, sql or markdown. The SQL editor holds one query.
- SQL is a single statement in Iara SQL (Apache DataFusion, DuckDB-style syntax). Write table names in full (catalog.schema.table). Python cells use the \`iara\` DataFrame API, close to polars (below).
- Use only tables and columns you have seen, in the analyst's findings or from list_tables and describe_table. Never guess. Call describe_table only for a table the findings do not describe.
- Keep the code small and readable.
- Change existing code with edits, not by rewriting it: copy each old exactly from the current code, and keep each edit to the lines that change plus a line or two around them. An empty cell or editor takes one edit with an empty old.
- Never edit the notebook's setup cell (read-only). What it should define goes in a new cell instead.
- A new cell goes after the cell it builds on (afterCellId), or at the end (null). Set run to true when running it is the point.
- When an earlier change ran with an error, fix it by editing the cell it made (its id is in the message) instead of inserting a new cell.
You must end by calling submit_change.

${NOTEBOOK_API}`;

/** On a dashboard the change is one edit_dashboard, its steps together. */
const DASHBOARD_SYSTEM = `You write exactly one change for the dashboard the user has open in Iara Studio, then submit it with submit_change, as one edit_dashboard with all the operations the task needs (a table to add, its relationship and the chart that uses it go together).
- SQL is a single read-only query in Iara SQL (Apache DataFusion, DuckDB-style syntax). Write table names in full (catalog.schema.table).
- Use only tables and columns you have seen, in the dashboard, in the analyst's findings or from list_tables and describe_table. Never guess. Call describe_table only for a table you have not seen.
- Change the model with edit_model only to change what is there: copy each old exactly from it. New lines go in add_model_lines.
- To change a widget, send the whole widget with its id: it replaces the file.
- When an earlier change drew with an error, fix it with the ids in the message.
You must end by calling submit_change.

${DASHBOARD_API}`;

const KIND = { type: "string", enum: ["python", "sql", "markdown"] };
const EDITS = {
  type: "array",
  minItems: 1,
  description: "applied in order; to rewrite the code entirely, one edit whose old is the whole current code",
  items: {
    type: "object",
    properties: {
      old: { type: "string", description: "text copied exactly from the current code (same spaces and line breaks), with enough of the lines around it to occur there once; empty only when the code is empty" },
      new: { type: "string", description: "what replaces it" },
    },
    required: ["old", "new"],
  },
};
const action =(name: string) => ({ type: "string", enum: [name] });
const run = { type: "boolean", description: "run the cell (or the query) once the change is applied" };

// mirrors Change in lib/iara/protocol.ts; the model's answer is checked with that schema anyway
const SUBMIT_CHANGE: FunctionDecl = {
  type: "function",
  name: "submit_change",
  description: "Submit the change. Call it once, when the change is ready.",
  parameters: {
    type: "object",
    properties: {
      change: {
        anyOf: [
          {
            type: "object",
            properties: {
              action: action("insert_cell"),
              kind: KIND,
              code: { type: "string" },
              afterCellId: { type: ["string", "null"], description: "id of the cell to insert after; null for the end of the notebook" },
              run,
            },
            required: ["action", "kind", "code", "afterCellId", "run"],
          },
          { type: "object", properties: { action: action("edit_cell"), cellId: { type: "string" }, edits: EDITS, run }, required: ["action", "cellId", "edits", "run"] },
          { type: "object", properties: { action: action("run_cell"), cellId: { type: "string" } }, required: ["action", "cellId"] },
          { type: "object", properties: { action: action("edit_query"), edits: EDITS, run }, required: ["action", "edits", "run"] },
          {
            type: "object",
            properties: {
              action: action("edit_dashboard"),
              operations: {
                type: "array",
                minItems: 1,
                items: {
                  type: "object",
                  description: "op, and what that op takes (see the instructions)",
                  properties: {
                    op: { type: "string", enum: ["set_dataset", "remove_dataset", "add_model_lines", "edit_model", "set_widget", "remove_widget", "move_widget"] },
                    name: { type: "string" },
                    sql: { type: "string" },
                    lines: { type: "array", items: { type: "string" } },
                    edits: EDITS,
                    id: { type: ["string", "null"] },
                    widget: { type: "object", additionalProperties: true },
                    place: { type: "object", properties: { x: { type: "integer" }, y: { type: "integer" }, w: { type: "integer" }, h: { type: "integer" } } },
                    x: { type: "integer" },
                    y: { type: "integer" },
                    w: { type: "integer" },
                    h: { type: "integer" },
                  },
                  required: ["op"],
                },
              },
            },
            required: ["action", "operations"],
          },
        ],
      },
      explanation: { type: "string", description: "one or two sentences for the user: what the change does" },
    },
    required: ["change", "explanation"],
  },
};

const DATA = dataTools(["list_tables", "describe_table", "read_file"]);
const TOOLS = [...DATA, SUBMIT_CHANGE];
const Submission = z.object({ change: Change, explanation: z.string().trim().min(1) });

async function taskPrompt(s: IaraGraphState): Promise<string> {
  const parts = [`Task: ${s.handoff!.request}`];
  if (s.findings.length) parts.push(`What the analyst found (in this conversation):\n${s.findings.join("\n\n")}`);
  parts.push(`The open file:\n${await contextText(s.context, 20_000)}`);
  if (s.refusal) parts.push(`Your previous change:\n${JSON.stringify(s.draft)}\nIt was refused: ${s.refusal}\nFix it.`);
  return parts.join("\n\n");
}

/** The author: writes the one change the task asks for, looking at the tables with the read-only data tools, and submits it as a draft. It never touches the file; the reviewer and the user come next. */
export function authorNode(deps: IaraDeps) {
  return async (s: IaraGraphState, config: LangGraphRunnableConfig): Promise<IaraUpdate> => {
    emit(config, { type: "agent", agent: "author" });
    const steps: Step[] = [userStep(await taskPrompt(s))];
    let calls = 0;
    let usage: ChatUsage = { input: 0, output: 0 };
    let lastError = "no change submitted";

    while (calls < AUTHOR_STEPS && s.steps + calls < MAX_STEPS) {
      const reply = await deps.chat({
        model: CODE_MODEL,
        system: s.context.surface === "dashboard" ? DASHBOARD_SYSTEM : AUTHOR_SYSTEM,
        steps,
        tools: TOOLS,
        onThought: (id, delta) => emit(config, { type: "thought", agent: "author", id, delta }),
        signal: config.signal,
      });
      calls++;
      usage = addUsage(usage, reply.usage);
      steps.push(...reply.steps);
      if (!reply.calls.length) {
        steps.push(userStep("Call submit_change with the change."));
        continue;
      }
      for (const call of reply.calls) {
        if (call.name === "submit_change") {
          const submission = Submission.safeParse(call.arguments);
          if (submission.success) {
            const problems = checkChange(submission.data.change, s.context);
            if (!problems.length) return { draft: submission.data, refusal: null, proposal: null, steps: s.steps + calls, usage: addUsage(s.usage, usage) };
            lastError = problems.join("\n");
            steps.push(resultStep(call, lastError, true));
            continue;
          }
          lastError = z.prettifyError(submission.error);
          steps.push(resultStep(call, lastError, true));
        } else if (DATA.some((t) => t.name === call.name)) {
          const result = await runDataTool(deps.tools, call.name, call.arguments);
          emit(config, { type: "tool", use: { agent: "author", ...result.use } });
          steps.push(resultStep(call, await cutToTokens(result.text, RESULT_TOKENS), result.isError));
        } else {
          steps.push(resultStep(call, `unknown tool: ${call.name}`, true));
        }
      }
    }
    return { draft: null, handoffResult: `The author could not write the change: ${lastError}`, steps: s.steps + calls, usage: addUsage(s.usage, usage) };
  };
}
