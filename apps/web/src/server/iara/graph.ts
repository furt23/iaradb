import "server-only";

import { END, interrupt, START, StateGraph } from "@langchain/langgraph";

import type { IaraDecision } from "@/lib/iara/protocol";

import { analystNode } from "./agents/analyst";
import { authorNode } from "./agents/author";
import { iaraNode } from "./agents/iara";
import { observerNode } from "./agents/observer";
import { reviewerNode } from "./agents/reviewer";
import { iaraSaver } from "./checkpointer";
import { IaraState, type IaraDeps, type IaraGraphState } from "./state";

// the node runs again from its top when resumed: nothing before interrupt() may have effects
function approval(s: IaraGraphState) {
  const decision = interrupt({ proposal: s.proposal }) as IaraDecision;
  return { decision };
}

/** The Iara graph for one request; the checkpointer is shared, so a rebuilt graph resumes a paused turn. */
export function buildIaraGraph(deps: IaraDeps, saver = iaraSaver()) {
  return new StateGraph(IaraState)
    .addNode("iara", iaraNode(deps))
    .addNode("analyst", analystNode(deps))
    .addNode("author", authorNode(deps))
    .addNode("reviewer", reviewerNode(deps))
    .addNode("approval", approval)
    .addNode("observer", observerNode())
    .addEdge(START, "iara")
    .addConditionalEdges("iara", (s) => (s.handoff?.name === "ask_analyst" ? "analyst" : s.handoff?.name === "propose_change" ? "author" : END))
    .addEdge("analyst", "iara")
    // an author that wrote no draft leaves its failure as the handoff result
    .addConditionalEdges("author", (s) => (s.draft ? "reviewer" : "iara"))
    .addConditionalEdges("reviewer", (s) => (s.proposal ? "approval" : "author"))
    .addEdge("approval", "observer")
    // the observer sends a failed run back to the author, anything else back to iara
    .addConditionalEdges("observer", (s) => (s.handoffResult !== null ? "iara" : "author"))
    .compile({ checkpointer: saver });
}
