import "server-only";

import type { LangGraphRunnableConfig } from "@langchain/langgraph";

import { emit, MAX_FIXES, type IaraGraphState, type IaraUpdate } from "../state";
import { cutToTokens } from "../tokens";

/** tokens of the run's output in the report to iara */
const OUTPUT_TOKENS = 4000;

/** The observer: reads what happened to the change the user decided on (no model). A rejection or a result goes back to iara; a run that failed goes back to the author, up to MAX_FIXES times. */
export function observerNode() {
  return async (s: IaraGraphState, config: LangGraphRunnableConfig): Promise<IaraUpdate> => {
    emit(config, { type: "agent", agent: "observer" });
    const d = s.decision!;
    if (d.kind === "reject") return { handoffResult: `The user rejected the change.${d.feedback ? ` They said: ${d.feedback}` : ""}` };

    const { outcome } = d;
    const cell = outcome.cellId ? ` as cell ${outcome.cellId}` : "";
    if (outcome.ran && outcome.status === "error" && s.fixes < MAX_FIXES) {
      const detail = [outcome.error, outcome.output].filter(Boolean).join("\n");
      // a fresh review budget: the fix is a new draft
      return { refusal: `It was applied${cell} and ran with an error:\n${detail}`, fixes: s.fixes + 1, reviews: 0 };
    }

    const report = [
      outcome.applied ? `The change was applied${cell}.` : `The change was not applied${outcome.error ? `: ${outcome.error}` : "."}`,
      outcome.ran ? `It ran with status ${outcome.status ?? "unknown"}.` : "It was not run.",
      outcome.applied && outcome.error && `Error: ${outcome.error}`,
      outcome.output && `Output:\n${await cutToTokens(outcome.output, OUTPUT_TOKENS)}`,
      s.reviewNotes && `The reviewer noted: ${s.reviewNotes}`,
    ];
    return { handoffResult: report.filter(Boolean).join("\n") };
  };
}
