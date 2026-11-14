"use server";

import type { ExplainResult, QueryParams } from "@iara/protocol";

import type { QueryLogEntry } from "@/lib/system/types";

import { requireUser } from "../auth/session";
import { kernels } from "../kernel/manager";
import { attempt, type ActionResult } from "../result";
import { recentQueries } from "../system/queryLog";

export async function explainSql(query: string, values: QueryParams = {}): Promise<ActionResult<ExplainResult>> {
  return attempt(async () => {
    await requireUser();
    return kernels.workspace().request("sql.explain", { query, ...values });
  });
}

export async function queryHistory(limit = 200): Promise<ActionResult<QueryLogEntry[]>> {
  return attempt(async () => {
    await requireUser();
    return recentQueries(limit);
  });
}
