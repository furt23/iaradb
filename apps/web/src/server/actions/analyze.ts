"use server";

import type { AnalysisSummary, StoredAnalysis } from "@/features/analyze/types";

import * as store from "../analyze/store";
import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";

/** Runs a query with profiling on the workspace kernel and keeps the analysis: its id. */
export async function analyzeQuery(query: string, source?: string): Promise<ActionResult<{ id: string }>> {
  return attempt(async () => {
    const analysis = await kernels.workspace().request("sql.analyze", { query });
    return { id: store.saveAnalysis({ ...analysis, source }).id };
  });
}

export async function listAnalyses(): Promise<ActionResult<AnalysisSummary[]>> {
  return attempt(async () => store.listAnalyses());
}

export async function getAnalysis(id: string): Promise<ActionResult<StoredAnalysis>> {
  return attempt(async () => {
    const found = store.getAnalysis(id);
    if (!found) throw new Error(`no analysis ${id}`);
    return found;
  });
}
