import { describe, expect, it } from "vitest";

import { handleMcp } from "./mcp";
import type { ToolContext } from "./tools";

/** A kernel that answers the catalog and one table result. */
function ctx(): ToolContext {
  const answer = (method: string) => {
    if (method === "catalog.list") return [{ name: "orders", full: "main.sales.orders", path: "", format: "parquet" }];
    if (method === "sql.run") return { type: "table", result: { id: "r1", columns: [{ name: "n", type: "int64" }], num_rows: 1 } };
    if (method === "result.page") return { offset: 0, total: 1, rows: [[1]] };
    return {};
  };
  return { request: (async (method: string) => answer(method)) as unknown as ToolContext["request"], allow: null };
}

const call = (name: string, args?: unknown, id = 1) => handleMcp({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }, ctx());

describe("MCP handshake", () => {
  it("echoes a supported protocol version, else the latest", async () => {
    const init = (version: string) => handleMcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version } }, ctx());
    expect(await init("2025-06-18")).toMatchObject({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "iara", version: "0.1.0" } } });
    expect(await init("1999-01-01")).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
    expect(await handleMcp({ jsonrpc: "2.0", id: 2, method: "initialize" }, ctx())).toMatchObject({ result: { protocolVersion: "2025-11-25" } });
  });

  it("answers ping and gives no reply to notifications", async () => {
    expect(await handleMcp({ jsonrpc: "2.0", id: 3, method: "ping" }, ctx())).toEqual({ jsonrpc: "2.0", id: 3, result: {} });
    expect(await handleMcp({ jsonrpc: "2.0", method: "notifications/initialized" }, ctx())).toBeNull();
  });
});

describe("tools/list", () => {
  it("lists the read-only tools with closed input schemas", async () => {
    const res = (await handleMcp({ jsonrpc: "2.0", id: 4, method: "tools/list" }, ctx())) as { result: { tools: { name: string; description: string; inputSchema: { additionalProperties: boolean } }[] } };
    expect(res.result.tools.map((t) => t.name)).toEqual(["list_tables", "describe_table", "explain_sql", "run_sql", "list_files", "read_file", "search_ontology"]);
    for (const t of res.result.tools) {
      expect(t.description).toMatch(/read-only/i);
      expect(t.inputSchema.additionalProperties).toBe(false);
    }
  });
});

describe("tools/call", () => {
  it("returns a tool's result as JSON text", async () => {
    const res = await call("run_sql", { sql: "SELECT 1", max_rows: 1 });
    expect(res).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: JSON.stringify({ columns: [{ name: "n", type: "int64" }], rows: [[1]], truncated: false }) }] } });
  });

  it("returns a tool's failure as an error result", async () => {
    const res = await call("describe_table", { name: "nope" });
    expect(res).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "there is no table nope you can read" }], isError: true } });
  });

  it("refuses bad arguments with -32602", async () => {
    expect(await call("run_sql", { sql: "SELECT 1", max_rows: 0 })).toMatchObject({ error: { code: -32602 } });
    expect(await call("run_sql", { sql: "SELECT 1", max_rows: 501 })).toMatchObject({ error: { code: -32602 } });
    expect(await call("explain_sql", { sql: "SELECT 1", extra: true })).toMatchObject({ error: { code: -32602 } });
    expect(await call("list_tables", "not an object")).toMatchObject({ error: { code: -32602 } });
  });

  it("refuses an unknown tool with -32602", async () => {
    expect(await call("drop_everything", {})).toMatchObject({ error: { code: -32602, message: "unknown tool: drop_everything" } });
  });
});

describe("errors", () => {
  it("answers an unknown method with -32601", async () => {
    expect(await handleMcp({ jsonrpc: "2.0", id: 5, method: "resources/list" }, ctx())).toEqual({ jsonrpc: "2.0", id: 5, error: { code: -32601, message: "method not found: resources/list" } });
  });

  it("refuses a message that is not a JSON-RPC request with -32600", async () => {
    expect(await handleMcp({ jsonrpc: "1.0", id: 6, method: "ping" }, ctx())).toMatchObject({ error: { code: -32600 } });
    expect(await handleMcp({ id: 7, method: "ping" }, ctx())).toMatchObject({ error: { code: -32600 } });
    expect(await handleMcp("ping", ctx())).toMatchObject({ error: { code: -32600 } });
  });
});
