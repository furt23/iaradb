import { z } from "zod";

import { describeTable, explainSql, listFiles, listTables, MAX_ROWS, readFile, runSql, type ToolContext } from "./tools";

/**
 * The MCP server's JSON-RPC handler (pure; unit tested): stateless, JSON
 * responses only (Streamable HTTP, see app/api/mcp). Read-only tools over
 * the tools of ./tools.
 */

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const LATEST = VERSIONS[0];
const INSTRUCTIONS = `Read-only SQL over the tables you are granted, at most ${MAX_ROWS} rows per query, and the workspace's notebooks and SQL files. Start with list_tables or list_files.`;

type Id = string | number | null;

export interface Tool {
  name: string;
  description: string;
  args: z.ZodType;
  run: (ctx: ToolContext, args: unknown) => Promise<unknown>;
}

function defineTool<S extends z.ZodType>(name: string, description: string, args: S, run: (ctx: ToolContext, a: z.output<S>) => Promise<unknown>): Tool {
  return { name, description, args, run: run as Tool["run"] };
}

export const TOOLS: Tool[] = [
  defineTool("list_tables", "List the tables you may read. Read-only.", z.strictObject({}), (ctx) => listTables(ctx)),
  defineTool("describe_table", "Columns and row count of a table you may read. Read-only.", z.strictObject({ name: z.string() }), (ctx, a) =>
    describeTable(ctx, a.name),
  ),
  defineTool("explain_sql", "The plan of a read-only SQL query, without running it.", z.strictObject({ sql: z.string() }), (ctx, a) => explainSql(ctx, a.sql)),
  defineTool(
    "run_sql",
    `Run a read-only SQL query. Returns at most max_rows rows (up to ${MAX_ROWS}).`,
    z.strictObject({ sql: z.string(), max_rows: z.number().int().min(1).max(MAX_ROWS).optional() }),
    (ctx, a) => runSql(ctx, a.sql, a.max_rows),
  ),
  defineTool("list_files", "List the workspace's notebooks, SQL files and text files. Read-only.", z.strictObject({}), () => listFiles()),
  defineTool("read_file", "The text of a notebook, SQL file or text file from list_files (a notebook as its Python source). Read-only.", z.strictObject({ path: z.string() }), (_ctx, a) =>
    readFile(a.path),
  ),
];

const ok = (id: Id, result: object) => ({ jsonrpc: "2.0", id, result });
const failure = (id: Id, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

const RpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

/** The response to a JSON-RPC message (null for a notification, which gets none). */
export async function handleMcp(message: unknown, ctx: ToolContext): Promise<object | null> {
  const req = RpcRequest.safeParse(message);
  if (!req.success) return failure(null, -32600, "invalid request");
  const { id, method, params } = req.data;
  if (id === undefined) return null;
  switch (method) {
    case "initialize":
      return ok(id, initialize(params));
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: TOOLS.map(({ name, description, args }) => ({ name, description, inputSchema: z.toJSONSchema(args) })) });
    case "tools/call":
      return callTool(id, params, ctx);
    default:
      return failure(id, -32601, `method not found: ${method}`);
  }
}

function initialize(params: unknown) {
  const requested = z.object({ protocolVersion: z.string().optional() }).safeParse(params).data?.protocolVersion;
  return {
    protocolVersion: requested && VERSIONS.includes(requested) ? requested : LATEST,
    capabilities: { tools: {} },
    serverInfo: { name: "iara", version: "0.1.0" },
    instructions: INSTRUCTIONS,
  };
}

/** A tool call: bad arguments are a protocol error, a failing tool an error result. */
async function callTool(id: Id, params: unknown, ctx: ToolContext) {
  const call = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }).safeParse(params);
  if (!call.success) return failure(id, -32602, z.prettifyError(call.error));
  const tool = TOOLS.find((t) => t.name === call.data.name);
  if (!tool) return failure(id, -32602, `unknown tool: ${call.data.name}`);
  const args = tool.args.safeParse(call.data.arguments ?? {});
  if (!args.success) return failure(id, -32602, z.prettifyError(args.error));
  try {
    const result = await tool.run(ctx, args.data);
    return ok(id, { content: [{ type: "text", text: JSON.stringify(result) }] });
  } catch (e) {
    return ok(id, { content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }], isError: true });
  }
}
