"use server";

import type { AgentConfig, AgentExample, AgentLogEntry, AgentRating } from "@/lib/agents/types";

import { requireUser } from "../auth/session";
import { deleteLog, listLog, rateLog } from "../agents/log";
import { createAgent, deleteAgent, listAgents, readAgent, saveAgentConfig, saveExamples, saveInstructions } from "../agents/store";
import { agentAllow } from "../agents/brief";
import { assistantContext, describeTable, listTables, runSql } from "../ai/tools";
import { attempt, type ActionResult } from "../result";

/** rows an example's test shows */
const TEST_ROWS = 20;

export async function listAgentsAction(): Promise<ActionResult<Awaited<ReturnType<typeof listAgents>>>> {
  return attempt(async () => {
    await requireUser();
    return listAgents();
  });
}

export async function createAgentAction(title: string): Promise<ActionResult<{ slug: string }>> {
  return attempt(async () => {
    await requireUser();
    return { slug: await createAgent(title) };
  });
}

export async function openAgentAction(slug: string): Promise<ActionResult<Awaited<ReturnType<typeof readAgent>>>> {
  return attempt(async () => {
    await requireUser();
    return readAgent(slug);
  });
}

export async function saveAgentConfigAction(slug: string, config: AgentConfig): Promise<ActionResult<AgentConfig>> {
  return attempt(async () => {
    await requireUser();
    return saveAgentConfig(slug, config);
  });
}

export async function saveInstructionsAction(slug: string, text: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    await saveInstructions(slug, text);
    return null;
  });
}

export async function saveExamplesAction(slug: string, examples: AgentExample[]): Promise<ActionResult<AgentExample[]>> {
  return attempt(async () => {
    await requireUser();
    return saveExamples(slug, examples);
  });
}

/** Deletes the agent's folder and its log. */
export async function deleteAgentAction(slug: string): Promise<ActionResult<null>> {
  return attempt(async () => {
    await requireUser();
    const id = await deleteAgent(slug);
    if (id) await deleteLog(id);
    return null;
  });
}

export async function listAgentLogAction(slug: string): Promise<ActionResult<AgentLogEntry[]>> {
  return attempt(async () => {
    await requireUser();
    const { config } = await readAgent(slug);
    return listLog(config.id);
  });
}

/** Rates an answer; `note` undefined keeps its note. */
export async function rateAgentLogAction(slug: string, entryId: string, rating: AgentRating | null, note?: string): Promise<ActionResult<AgentLogEntry>> {
  return attempt(async () => {
    await requireUser();
    const { config } = await readAgent(slug);
    return rateLog(config.id, entryId, rating, note);
  });
}

/** A table's columns with their types, and its row count (null: not counted), as the signed-in user may read it. */
export async function agentTableInfoAction(full: string): Promise<ActionResult<{ columns: { name: string; type: string }[]; numRows: number | null }>> {
  return attempt(async () => {
    const user = await requireUser();
    const t = await describeTable(assistantContext(user), full);
    return { columns: t.columns, numRows: t.num_rows };
  });
}

/** Runs an example's SQL as the agent would: only its included tables, within the user's grants; the first rows come back. */
export async function testExampleAction(slug: string, sql: string): Promise<ActionResult<{ columns: { name: string; type: string }[]; rows: unknown[][]; truncated: boolean }>> {
  return attempt(async () => {
    const user = await requireUser();
    const agent = await readAgent(slug);
    const ctx = assistantContext(user);
    const out = await runSql({ ...ctx, allow: agentAllow(ctx.allow, agent) }, sql, TEST_ROWS);
    return { columns: out.columns.map(({ name, type }: { name: string; type: string }) => ({ name, type })), rows: out.rows as unknown[][], truncated: out.truncated };
  });
}

/** The full names of the tables the signed-in user may read, sorted. */
export async function readableTablesAction(): Promise<ActionResult<string[]>> {
  return attempt(async () => {
    const user = await requireUser();
    return (await listTables(assistantContext(user))).map((t) => t.full).sort();
  });
}
