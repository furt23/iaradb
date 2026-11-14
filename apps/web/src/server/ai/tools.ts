import "server-only";

import { datasetStatement } from "@/lib/dashboards/query";
import { searchOntologies, type Ontology, type OntologySearch } from "@/lib/ontology";

import type { StudioUser } from "../auth/access";
import type { RunDeps } from "../dashboards/run";
import { canRead } from "../governance/grants";
import { userAllow } from "../governance/store";
import { ontologiesFor } from "../ontology/store";
import { normalizeRelative } from "../kernel/keys";
import { kernels, METADATA_METHODS, type MetadataMethod } from "../kernel/manager";
import { type FileKind, type FileNode, listTree, readText } from "../workspace/files";

/** What the AI tools (and the MCP server) may do: query through a kernel, within `allow` (null: unchecked). */
export interface ToolContext {
  request: RunDeps["request"];
  allow: string[] | null;
  /** the teams' ontologies the user may read, with the files that are broken (absent: there are none) */
  ontologies?: () => Promise<{ ontologies: Ontology[]; problems: { team: string; message: string }[] }>;
}

export const MAX_ROWS = 500;
/** what the file tools list and read: what users write, never data files or hidden ones */
const READABLE: FileKind[] = ["notebook", "python", "sql", "text"];
const MAX_FILES = 500;
const MAX_FILE_CHARS = 40_000;
export const TIMEOUT_MS = 30_000;

/** A query as a subquery of `SELECT *`, with a row limit when given. */
export function wrapQuery(sql: string, limit?: number): string {
  const select = `SELECT * FROM (\n${datasetStatement(sql)}\n) AS _d`;
  return limit === undefined ? select : `${select}\nLIMIT ${limit}`;
}

/** The engine's check of what the query may read (sent even when empty: only null means unchecked). */
const grant = (ctx: ToolContext) => (ctx.allow ? { allow: ctx.allow } : {});

/** The tables the user may read. */
export async function listTables(ctx: ToolContext): Promise<{ name: string; full: string; format: string }[]> {
  const tables = await ctx.request("catalog.list", {});
  return tables.filter((t) => canRead(ctx.allow, t.full)).map(({ name, full, format }) => ({ name, full, format }));
}

/** A table's columns and row count. A table that does not exist and one the user may not read give the same error. */
export async function describeTable(ctx: ToolContext, name: string): Promise<{ name: string; full: string; columns: { name: string; type: string }[]; num_rows: number | null }> {
  const wanted = name.trim().toLowerCase();
  const tables = await ctx.request("catalog.list", {});
  const t = tables.find((x) => x.full === wanted || x.name.toLowerCase() === wanted);
  if (!t || !canRead(ctx.allow, t.full)) throw new Error(`there is no table ${name} you can read`);
  const info = await ctx.request("catalog.table", { name: t.name });
  return { name: info.name, full: info.full, columns: info.columns.map(({ name, type }) => ({ name, type })), num_rows: info.num_rows };
}

/**
 * The business terms that answer `query` (every term when it is empty) and the joins between their tables, from the
 * ontologies the user may read. A term over a table the user may not read is left out.
 */
export async function searchOntology(ctx: ToolContext, query: string): Promise<OntologySearch & { problems?: string[] }> {
  const { ontologies, problems } = (await ctx.ontologies?.()) ?? { ontologies: [], problems: [] };
  const found = searchOntologies(ontologies, query, (table) => canRead(ctx.allow, table));
  return problems.length ? { ...found, problems: problems.map((p) => `${p.team}.toml could not be read: ${p.message}`) } : found;
}

/** The workspace's notebooks, SQL and text files, by path. */
export async function listFiles(): Promise<{ path: string; kind: FileKind }[]> {
  const out: { path: string; kind: FileKind }[] = [];
  const walk = (nodes: FileNode[]) => {
    for (const n of nodes) {
      if (n.children) walk(n.children);
      else if (READABLE.includes(n.kind)) out.push({ path: n.path, kind: n.kind });
    }
  };
  walk(await listTree());
  return out.slice(0, MAX_FILES);
}

/** A file listFiles gives, as text (a notebook as its Python source); anything else is refused like a missing file. */
export async function readFile(path: string): Promise<{ path: string; text: string; truncated: boolean }> {
  let wanted = "";
  try {
    wanted = normalizeRelative(path);
  } catch {
    // an escape reads as a file that is not there
  }
  const file = wanted ? (await listFiles()).find((f) => f.path === wanted) : undefined;
  if (!file) throw new Error(`there is no notebook, SQL or text file ${path}`);
  const { text, truncated } = await readText(file.path);
  return { path: file.path, text: text.slice(0, MAX_FILE_CHARS), truncated: truncated || text.length > MAX_FILE_CHARS };
}

/** The plan of a query, without running it. */
export async function explainSql(ctx: ToolContext, sql: string): Promise<{ text: string }> {
  const { text } = await ctx.request("sql.explain", { query: wrapQuery(sql), ...grant(ctx) });
  return { text };
}

/**
 * The first `maxRows` rows of a query (clamped to 1..MAX_ROWS). A query that
 * runs past TIMEOUT_MS is interrupted in its kernel.
 */
export async function runSql(ctx: ToolContext, sql: string, maxRows = MAX_ROWS) {
  const rows = Math.min(Math.max(Math.floor(maxRows), 1), MAX_ROWS);
  const timedOut = Symbol("timeout");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<typeof timedOut>((resolve) => {
    timer = setTimeout(() => resolve(timedOut), TIMEOUT_MS);
  });
  const output = await Promise.race([ctx.request("sql.run", { query: wrapQuery(sql, rows + 1), source: "assistant", ...grant(ctx) }), limit]).finally(() => clearTimeout(timer));
  if (output === timedOut) {
    ctx.request("interrupt", {}).catch(() => {});
    throw new Error(`the query took longer than ${TIMEOUT_MS / 1000} s`);
  }
  if (output.type === "error") throw new Error(`${output.ename}: ${output.evalue}`);
  if (output.type !== "table") throw new Error("the query did not return a table");
  const page = await ctx.request("result.page", { result_id: output.result.id, offset: 0, limit: rows });
  return { columns: output.result.columns, rows: page.rows, truncated: page.total > rows };
}

/** The context of the assistant's kernel for `user`, within the user's grants. */
export function assistantContext(user: StudioUser): ToolContext {
  // catalog reads and plans need no cluster; queries run on the assistant's kernel
  const request: ToolContext["request"] = (method, params) =>
    (METADATA_METHODS as readonly string[]).includes(method) ? kernels.metadata(method as MetadataMethod, params as never) : kernels.forAssistant().request(method, params, undefined, user.email || null);
  return { request, allow: userAllow(user), ontologies: () => ontologiesFor(user) };
}
