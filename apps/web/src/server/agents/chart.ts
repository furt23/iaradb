import "server-only";

import crypto from "node:crypto";

import type { CellValue } from "@iara/protocol";
import { z } from "zod";

import type { IaraChart } from "@/lib/iara/protocol";
import { isNumericType } from "@/lib/format";

import { runSql, type ToolContext } from "../ai/tools";
import type { FunctionDecl } from "../iara/state";

/** rows a chart's query may give (categories × series) */
const CHART_ROWS = 200;

/** Offered to an agent whose answers may have charts. */
export const CHART_TOOL: FunctionDecl = {
  type: "function",
  name: "show_chart",
  description:
    "Draw a chart under your answer, from a read-only SQL query that already aggregates its rows: one row per category (and per series). Use it when a comparison, a ranking or a trend reads better as a picture. Use the tables and SQL the analyst gave.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string", description: "a short title, in the user's language" },
      kind: { type: "string", enum: ["bar", "line", "area", "pie"], description: "line or area for time, pie only for a few parts of a whole" },
      sql: { type: "string", description: "the query; its columns are named as x, y and group say" },
      x: { type: "string", description: "the category or date column" },
      y: { type: "array", items: { type: "string" }, description: "the numeric value columns" },
      group: { type: "string", description: "a column that splits the values into series, or empty" },
    },
    required: ["title", "kind", "sql", "x", "y", "group"],
  },
};

const Args = z.object({
  title: z.string().trim().min(1).max(120),
  kind: z.enum(["bar", "line", "area", "pie"]),
  sql: z.string().trim().min(1).max(20_000),
  x: z.string().min(1),
  y: z.array(z.string().min(1)).min(1).max(6),
  group: z.string().optional().default(""),
});

/** Runs the chart's query within `ctx` (the agent's tables) and checks its columns fit; a problem is an error the model reads. */
export async function drawChart(ctx: ToolContext, args: unknown): Promise<{ chart: IaraChart } | { error: string }> {
  const parsed = Args.safeParse(args);
  if (!parsed.success) return { error: z.prettifyError(parsed.error) };
  const { title, kind, sql, x, y, group } = parsed.data;
  let out;
  try {
    out = await runSql(ctx, sql, CHART_ROWS);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const columns = out.columns as { name: string; type: string }[];
  const type = (name: string) => columns.find((c) => c.name === name)?.type;
  const missing = [x, ...y, ...(group ? [group] : [])].filter((name) => !type(name));
  if (missing.length) return { error: `the query has no column ${missing.join(", ")}; it gives ${columns.map((c) => c.name).join(", ")}` };
  const notNumeric = y.filter((name) => !isNumericType(type(name)!));
  if (notNumeric.length) return { error: `${notNumeric.join(", ")} must be numeric` };
  if (!out.rows.length) return { error: "the query gave no rows: nothing to draw" };
  return {
    chart: {
      id: crypto.randomUUID(),
      title,
      // the query aggregates already: sum over one row per category is the value itself
      spec: { kind, x, y, agg: "sum", group: kind === "pie" || !group ? null : group },
      xType: type(x)!,
      data: { columns: columns.map((c) => c.name), rows: out.rows as CellValue[][], truncated: out.truncated },
      sql,
    },
  };
}
