import "server-only";

import { z } from "zod";

import type { IaraToolUse } from "@/lib/iara/protocol";

import { TOOLS } from "../ai/mcp";
import type { ToolContext } from "../ai/tools";
import type { FunctionDecl } from "./state";

/** The data tools of the MCP server (same code, same grants), as function declarations for the model. */
export const DATA_TOOLS: FunctionDecl[] = TOOLS.map(({ name, description, args }) => {
  // the model needs neither key; the arguments are checked with the strict zod schema anyway
  const { $schema: _schema, additionalProperties: _closed, ...parameters } = z.toJSONSchema(args);
  return { type: "function", name, description, parameters };
});

/** The subset of DATA_TOOLS with these names. */
export function dataTools(names: string[]): FunctionDecl[] {
  return DATA_TOOLS.filter((t) => names.includes(t.name));
}

type DataToolResult = { text: string; isError: boolean; use: Omit<IaraToolUse, "agent"> };

/** Runs a data tool call; a failure (bad arguments, a refused query) is an error result the model reads, never a throw. */
export async function runDataTool(ctx: ToolContext, name: string, args: unknown): Promise<DataToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `unknown tool: ${name}`, isError: true, use: { tool: name } };
  const parsed = tool.args.safeParse(args ?? {});
  if (!parsed.success) return { text: z.prettifyError(parsed.error), isError: true, use: { tool: name } };
  const target = name === "describe_table" ? (parsed.data as { name: string }).name : name === "read_file" ? (parsed.data as { path: string }).path : undefined;
  const use = { tool: name, ...(target && { target }) };
  try {
    return { text: JSON.stringify(await tool.run(ctx, parsed.data)), isError: false, use };
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), isError: true, use };
  }
}
