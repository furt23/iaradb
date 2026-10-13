"use server";

import type { ExplainResult, HistoryEntry, QueryParams } from "@workhouse/protocol";

import { requireUser } from "../auth/session";
import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";

export async function explainSql(query: string, values: QueryParams = {}): Promise<ActionResult<ExplainResult>> {
  return attempt(async () => {
    await requireUser();
    return kernels.workspace().request("sql.explain", { query, ...values });
  });
}

export async function queryHistory(limit = 200): Promise<ActionResult<HistoryEntry[]>> {
  return attempt(async () => {
    await requireUser();
    return kernels.workspace().request("history.list", { limit });
  });
}
