"use server";

import type { ExplainResult, HistoryEntry } from "@workhouse/protocol";

import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";

export async function explainSql(query: string): Promise<ActionResult<ExplainResult>> {
  return attempt(() => kernels.workspace().request("sql.explain", { query }));
}

export async function queryHistory(limit = 200): Promise<ActionResult<HistoryEntry[]>> {
  return attempt(() => kernels.workspace().request("history.list", { limit }));
}
