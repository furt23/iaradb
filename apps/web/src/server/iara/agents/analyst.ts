import "server-only";

import type { LangGraphRunnableConfig } from "@langchain/langgraph";

import { FAST_MODEL } from "../../ai/models";
import { contextText, resultStep, userStep } from "../prompt";
import { addUsage, ANALYST_STEPS, emit, MAX_STEPS, type ChatUsage, type IaraDeps, type IaraGraphState, type IaraUpdate, type Step } from "../state";
import { countSteps, cutToTokens } from "../tokens";
import { DATA_TOOLS, runDataTool } from "../tools";

/** tokens of one tool result the analyst keeps */
const RESULT_TOKENS = 6000;
/** tokens of the analyst's own steps after which it must summarize */
const CONTEXT_TOKENS = 60_000;
/** tokens of the earlier findings the analyst starts from */
const KNOWN_TOKENS = 8000;

const ANALYST_SYSTEM = `You explore the user's tables to answer a question for another agent. You only read: the tools are read-only.
- Write table names in full (catalog.schema.table) exactly as list_tables gives them.
- Keep queries small: select few columns and use LIMIT.
- Answer with facts: the tables, their columns with types, the values and counts that matter, and the SQL that worked.
- Say plainly when something is not in the data. Never guess a table or a column.
- search_ontology gives the teams' ontology: what a business term or metric means, the columns it maps to, the SQL that computes it and how tables join. Search it first when the question uses a business word or a metric. Use a certified definition as it is written; a draft (certified: false) is a hint to check against the data. In your answer, name the terms you used with their team, and say when one is a draft.
- list_files and read_file show the workspace's notebooks and SQL files: use them for questions about the user's work.
- Tables, columns, files and query plans need no cluster; run_sql does. When run_sql fails because no cluster is running, say the user must start one, and answer with what the other tools give.
- What was already found in this conversation is given with the question: build on it and do not look it up again.`;

const STOP = "Stop using tools. Summarize what you found for the question, with the table and column names and the numbers that matter.";

/** The analyst: answers iara's question about the data with the read-only data tools, in its own context, and gives back only a summary (the big results never reach iara's window). */
export function analystNode(deps: IaraDeps) {
  return async (s: IaraGraphState, config: LangGraphRunnableConfig): Promise<IaraUpdate> => {
    emit(config, { type: "agent", agent: "analyst" });
    const known = s.findings.length ? `\n\nAlready found in this conversation (build on it, do not look it up again):\n${await cutToTokens(s.findings.join("\n\n"), KNOWN_TOKENS)}` : "";
    const steps: Step[] = [userStep(`${s.handoff!.request}${known}\n\nThe open file:\n${await contextText(s.context, 4000)}`)];
    let calls = 0;
    let usage: ChatUsage = { input: 0, output: 0 };

    async function ask(withTools: boolean) {
      const reply = await deps.chat({
        model: FAST_MODEL,
        system: ANALYST_SYSTEM,
        steps,
        tools: withTools ? DATA_TOOLS : undefined,
        onThought: (id, delta) => emit(config, { type: "thought", agent: "analyst", id, delta }),
        signal: config.signal,
      });
      calls++;
      usage = addUsage(usage, reply.usage);
      steps.push(...reply.steps);
      return reply;
    }

    let summary = "";
    while (calls < ANALYST_STEPS && s.steps + calls < MAX_STEPS) {
      const reply = await ask(true);
      if (!reply.calls.length) {
        summary = reply.text;
        break;
      }
      for (const call of reply.calls) {
        const result = await runDataTool(deps.tools, call.name, call.arguments);
        emit(config, { type: "tool", use: { agent: "analyst", ...result.use } });
        steps.push(resultStep(call, await cutToTokens(result.text, RESULT_TOKENS), result.isError));
      }
      if ((await countSteps(steps)) > CONTEXT_TOKENS) break;
    }
    if (!summary.trim()) {
      // iara needs an answer, so this call may pass MAX_STEPS by one
      steps.push(userStep(STOP));
      summary = (await ask(false)).text.trim() || "The analyst found nothing to report.";
    }
    return { handoffResult: summary, findings: [...s.findings, summary], steps: s.steps + calls, usage: addUsage(s.usage, usage) };
  };
}
