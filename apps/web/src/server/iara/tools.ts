import "server-only";

import { z } from "zod";

import type { IaraKnowledge, IaraToolUse } from "@/lib/iara/protocol";
import type { OntologySearch } from "@/lib/ontology";

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

/** characters of a term's description the panel is given */
const KNOWLEDGE_CHARS = 240;

/** The terms a search gave, as the panel shows them. */
function knowledgeOf(found: OntologySearch): IaraKnowledge[] {
  return found.terms.map((t) => ({ team: t.team, term: t.name, certified: t.certified, description: t.description.slice(0, KNOWLEDGE_CHARS) }));
}

type DataToolResult = { text: string; isError: boolean; use: Omit<IaraToolUse, "agent"> };

/** Runs a data tool call; a failure (bad arguments, a refused query) is an error result the model reads, never a throw. */
export async function runDataTool(ctx: ToolContext, name: string, args: unknown): Promise<DataToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { text: `unknown tool: ${name}`, isError: true, use: { tool: name } };
  const parsed = tool.args.safeParse(args ?? {});
  if (!parsed.success) return { text: z.prettifyError(parsed.error), isError: true, use: { tool: name } };
  const data = parsed.data as { name?: string; path?: string; query?: string; sql?: string };
  const target = name === "describe_table" ? data.name : name === "read_file" ? data.path : name === "search_ontology" ? data.query?.trim() || undefined : undefined;
  const use = { tool: name, ...(target && { target }), ...(name === "run_sql" && data.sql && { sql: data.sql }) };
  try {
    const out = await tool.run(ctx, parsed.data);
    const knowledge = name === "search_ontology" ? knowledgeOf(out as OntologySearch) : [];
    return { text: JSON.stringify(out), isError: false, use: knowledge.length ? { ...use, knowledge } : use };
  } catch (e) {
    return { text: e instanceof Error ? e.message : String(e), isError: true, use };
  }
}
