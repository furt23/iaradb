"use server";

import type { QueryParams } from "@iara/protocol";

import type { AnalysisSummary, StoredAnalysis } from "@/features/analyze/types";

import * as store from "../analyze/store";
import { requireUser } from "../auth/session";
import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";

/** Runs a query with profiling on the workspace kernel and keeps the analysis: its id. */
export async function analyzeQuery(query: string, source?: string, values: QueryParams = {}): Promise<ActionResult<{ id: string }>> {
  return attempt(async () => {
    const user = await requireUser();
    const analysis = await kernels.workspace().request("sql.analyze", { query, ...values }, undefined, user.email || null);
    return { id: store.saveAnalysis({ ...analysis, source, ...values }).id };
  });
}

export async function listAnalyses(): Promise<ActionResult<AnalysisSummary[]>> {
  return attempt(async () => {
    await requireUser();
    return store.listAnalyses();
  });
}

export async function getAnalysis(id: string): Promise<ActionResult<StoredAnalysis>> {
  return attempt(async () => {
    await requireUser();
    const found = store.getAnalysis(id);
    if (!found) throw new Error(`no analysis ${id}`);
    return found;
  });
}
