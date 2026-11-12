import "server-only";

import crypto from "node:crypto";

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { z } from "zod";

import { detectParams } from "@/features/queries/queryParams";
import { datasetsWritten, opsProblems } from "@/lib/dashboards/iaraOps";
import { applyEdits } from "@/lib/iara/edits";
import type { ContextCell, IaraChange, IaraEdit, IaraFileContext } from "@/lib/iara/protocol";

import { FAST_MODEL } from "../../ai/models";
import { explainSql } from "../../ai/tools";
import { contextText } from "../prompt";
import { emit, MAX_REVIEWS, type IaraDeps, type IaraGraphState, type IaraUpdate } from "../state";

const REVIEW_SYSTEM = `You review a change another agent wrote for a user's notebook, SQL editor or dashboard.
Answer ok=false only when the change does not do the task or is wrong.
In notes, name anything with side effects (writes, deletes, overwrites tables or files, long runs) so the user sees it before approving. Be terse.`;

const REVIEW_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" }, notes: { type: "string", description: "empty when nothing to say" } },
  required: ["ok", "notes"],
};
const Review = z.object({ ok: z.boolean(), notes: z.string() });

// the SQL is planned as a query, so statements that write or change settings are left to the model review
const NOT_A_QUERY = /^\s*(create|insert|update|delete|drop|alter|merge|copy|truncate|optimize|vacuum|set|use|attach|detach)\b/i;

/** Problems that make a change impossible to apply to the open file (pure). */
export function checkChange(change: IaraChange, ctx: IaraFileContext): string[] {
  if (change.action === "edit_dashboard") {
    return ctx.surface === "dashboard" ? opsProblems(change.operations, ctx) : ["edit_dashboard only works in a dashboard"];
  }
  if (ctx.surface === "dashboard") return [`${change.action} does not work in a dashboard: use edit_dashboard`];
  if (change.action === "edit_query") {
    if (ctx.surface !== "sql") return ["edit_query only works in the SQL editor"];
    return editProblems(ctx.query, change.edits);
  }
  if (ctx.surface !== "notebook") return [`${change.action} only works in a notebook`];
  if (change.action === "insert_cell") {
    const problems: string[] = [];
    if (change.afterCellId !== null && !ctx.cells.some((c) => c.id === change.afterCellId)) problems.push(`there is no cell ${change.afterCellId} to insert after`);
    if (!change.code.trim()) problems.push("the code is empty");
    return problems;
  }
  const cell = ctx.cells.find((c) => c.id === change.cellId);
  if (!cell) return [`there is no cell ${change.cellId}`];
  if (change.action !== "edit_cell") return [];
  // the setup holds the notebook's imports and `iara`/`ws`: a wrong edit there breaks every cell
  if (cell.setup) return [`cell ${cell.id} is the notebook's setup, which you must not edit; change another cell or add one`];
  return editProblems(cell.code, change.edits);
}

/** What is wrong with edits to `code`: they do not fit it, or they leave it empty. */
function editProblems(code: string, edits: IaraEdit[]): string[] {
  try {
    return applyEdits(code, edits).trim() ? [] : ["the code is empty"];
  } catch (e) {
    return [(e as Error).message];
  }
}

/** The code a change writes and the kind of cell (or editor) it goes to; null when it writes none. */
function written(change: IaraChange, ctx: IaraFileContext): { kind: ContextCell["kind"]; code: string } | null {
  switch (change.action) {
    case "edit_query":
      return ctx.surface === "sql" ? { kind: "sql", code: applyEdits(ctx.query, change.edits) } : null;
    case "insert_cell":
      return { kind: change.kind, code: change.code };
    case "edit_cell": {
      const cell = ctx.surface === "notebook" ? ctx.cells.find((c) => c.id === change.cellId) : undefined;
      return cell ? { kind: cell.kind, code: applyEdits(cell.code, change.edits) } : null;
    }
    case "run_cell":
    case "edit_dashboard":
      return null;
  }
}

/** The reviewer: deterministic checks first (the change fits the file, SQL plans with the user's grants, Python lints), then a quick model review against the task. A refused draft goes back to the author until MAX_REVIEWS; then it reaches the user with the reviewer's notes. */
export function reviewerNode(deps: IaraDeps) {
  return async (s: IaraGraphState, config: LangGraphRunnableConfig): Promise<IaraUpdate> => {
    emit(config, { type: "agent", agent: "reviewer" });
    const { change, explanation } = s.draft!;
    const problems = checkChange(change, s.context);
    const warnings: string[] = [];
    const code = problems.length ? null : written(change, s.context);

    if (code?.kind === "sql" && !NOT_A_QUERY.test(code.code)) {
      await explainSql(deps.tools, code.code).catch((e: Error) => problems.push(`The SQL does not plan: ${e.message}`));
    } else if (code?.kind === "python") {
      for (const item of (await deps.lint?.(code.code, "python")) ?? []) (item.severity === "error" ? problems : warnings).push(item.message);
    } else if (!problems.length && change.action === "edit_dashboard") {
      for (const { name, sql } of datasetsWritten(change.operations)) {
        // a placeholder has no value to plan with
        if (!detectParams(sql).length) await explainSql(deps.tools, sql).catch((e: Error) => problems.push(`The query of dataset ${name} does not plan: ${e.message}`));
      }
    }

    let steps = s.steps;
    let ok = true;
    if (!problems.length) {
      // an insert's code is already in the change
      const after = code && change.action !== "insert_cell" ? `\n\nThe code after the change:\n${code.code}` : "";
      const prompt = `Task: ${s.handoff!.request}\n\nChange:\n${JSON.stringify(change)}${after}\n\nThe author's explanation: ${explanation}\n\nThe open file:\n${await contextText(s.context, 8000)}`;
      const review = Review.safeParse(await deps.llm(FAST_MODEL, REVIEW_SYSTEM, prompt, REVIEW_SCHEMA)).data;
      steps++;
      if (review) {
        ok = review.ok;
        if (review.notes.trim()) warnings.push(review.notes.trim());
      }
    }

    const notes = warnings.join("\n");
    if ((problems.length || !ok) && s.reviews < MAX_REVIEWS) {
      return { refusal: problems.join("\n") || notes || "The change does not do the task.", reviews: s.reviews + 1, proposal: null, steps };
    }
    const review = [problems.join("\n"), notes].filter(Boolean).join("\n") || null;
    return { proposal: { id: crypto.randomUUID(), change, explanation, review, attempt: s.fixes + 1 }, refusal: null, reviewNotes: notes || null, steps };
  };
}
