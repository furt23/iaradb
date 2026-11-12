import "server-only";

import { checkDraft, DRAFT_SCHEMA, type Draft, type DraftProgress, type DraftTable } from "@/lib/ontologyDraft";

import { CODE_MODEL, type Llm } from "../ai/models";
import { describeTable, listFiles, listTables, readFile, runSql, type ToolContext } from "../ai/tools";
import { canRead } from "../governance/grants";

/**
 * A draft of a team's ontology, written by a model from what the Studio can
 * show it: the tables' columns, a few of their rows, and the queries people
 * wrote over them. Everything is read with the user's grants. What the model
 * answers is checked against the real columns before it is kept.
 */

/** the tables one draft reads */
export const MAX_TABLES = 40;
/** the tables one model call is given in full */
const BATCH = 10;
const SAMPLE_ROWS = 3;
const SAMPLE_CHARS = 40;
/** characters of the workspace's queries one model call is given */
const QUERY_CHARS = 30_000;
const FILE_CHARS = 6000;

const SYSTEM = `You draft a team's ontology for a data catalog: the business terms its people use, mapped to the columns that hold them. A person reviews everything you write, so be useful and never invent.
- A term is a business concept or a metric (net revenue, active customer, order status), not a column restated. Skip surrogate ids, technical columns and timestamps of loading.
- Map a term only to columns that are listed, written catalog.schema.table.column exactly as listed.
- sql: the expression or query that computes the term, only when a query people wrote shows it or the columns make it evident; otherwise leave it empty. SQL is DuckDB-style.
- A join only when the key is evident from the names and types on both sides, or a query people wrote uses it. left is the many side when you can tell.
- Say in the description what you are unsure of ("probably", "check with the team") instead of stating a guess as a fact.
- At most 6 terms per table. Do not repeat the terms that already exist.`;

type Described = Awaited<ReturnType<typeof describeTable>>;

export interface DraftDeps {
  llm: Llm;
  tools: ToolContext;
  /** the workspace's files with queries (default: the notebooks and SQL files) */
  files?: () => Promise<{ path: string; text: string }[]>;
  /** told where the draft is, as it goes */
  onProgress?: (p: DraftProgress) => void;
  /** aborted: the draft stops before its next step */
  signal?: AbortSignal;
}

export interface DraftRequest {
  /** what to read: `*`, catalogs, `catalog.schema`s or tables, as grants name them */
  scope: string[];
  /** read a few rows of each table (needs a running cluster) */
  samples: boolean;
  /** the names of the terms the team already has */
  existing: string[];
  /** the language of the names and descriptions */
  language: "pt" | "en";
}

export interface DraftResult extends Draft {
  /** the tables read */
  tables: string[];
  /** rows were read too */
  sampled: boolean;
  /** why rows were not read, when they were asked for */
  sampleError: string | null;
  /** terms and joins the model wrote that the tables do not support */
  dropped: number;
}

const cell = (v: unknown): string => {
  const s = v === null || v === undefined ? "null" : typeof v === "string" ? v : JSON.stringify(v);
  return s.length > SAMPLE_CHARS ? `${s.slice(0, SAMPLE_CHARS)}…` : s;
};

/** A table as prompt text: its columns with types and, when rows were read, a few values of each. */
function tableText(t: Described, rows: unknown[][] | null): string {
  const columns = t.columns.map((c, i) => {
    const values = rows?.length ? ` e.g. ${[...new Set(rows.map((r) => cell(r[i])))].join(" | ")}` : "";
    return `  ${c.name} ${c.type}${values}`;
  });
  return [`${t.full}${t.num_rows === null ? "" : ` (${t.num_rows} rows)`}`, ...columns].join("\n");
}

async function workspaceQueries(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  for (const f of await listFiles()) {
    if (f.kind !== "sql" && f.kind !== "notebook") continue;
    out.push({ path: f.path, text: (await readFile(f.path)).text });
  }
  return out;
}

/** The files that name one of the tables (by `schema.table` or the table's own name), cut to what a prompt holds. */
function queriesAbout(files: { path: string; text: string }[], tables: Described[]): string {
  const names = tables.flatMap((t) => [t.full.split(".").slice(1).join("."), t.name]).map((n) => n.toLowerCase());
  let left = QUERY_CHARS;
  const parts: string[] = [];
  for (const f of files) {
    const text = f.text.toLowerCase();
    if (left <= 0 || !names.some((n) => new RegExp(`(^|[^a-z0-9_])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9_]|$)`).test(text))) continue;
    const cut = f.text.slice(0, Math.min(FILE_CHARS, left));
    left -= cut.length;
    parts.push(`-- ${f.path}\n${cut}`);
  }
  return parts.join("\n\n");
}

/** Drafts terms and joins for the tables in `scope` the user may read. Throws when there are none, or too many for one draft. */
export async function draftOntology(deps: DraftDeps, req: DraftRequest): Promise<DraftResult> {
  const scope = req.scope.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!scope.length) throw new Error("choose the catalogs, schemas or tables to read");
  const listed = (await listTables(deps.tools)).filter((t) => canRead(scope, t.full));
  if (!listed.length) throw new Error("there is no table you can read in what you chose");
  if (listed.length > MAX_TABLES) throw new Error(`that is ${listed.length} tables: one draft reads at most ${MAX_TABLES}, choose fewer schemas or tables`);

  const progress = (step: DraftProgress["step"], done: number, total: number) => {
    deps.signal?.throwIfAborted();
    deps.onProgress?.({ step, done, total });
  };

  const tables: Described[] = [];
  progress("tables", 0, listed.length);
  for (const t of listed) {
    tables.push(await describeTable(deps.tools, t.full));
    progress("tables", tables.length, listed.length);
  }

  // rows need a cluster: the first table that cannot be read ends the sampling, and the draft goes on from the columns
  const rows = new Map<string, unknown[][]>();
  let sampleError: string | null = null;
  if (req.samples) {
    for (const t of tables) {
      try {
        rows.set(t.full, (await runSql(deps.tools, `SELECT * FROM ${t.full} LIMIT ${SAMPLE_ROWS}`, SAMPLE_ROWS)).rows as unknown[][]);
        progress("rows", rows.size, tables.length);
      } catch (e) {
        deps.signal?.throwIfAborted();
        sampleError = (e as Error).message;
        break;
      }
    }
  }

  const files = await (deps.files ?? workspaceQueries)();
  const all: DraftTable[] = tables.map((t) => ({ full: t.full, columns: t.columns.map((c) => c.name) }));
  const others = all.map((t) => `${t.full}: ${t.columns.join(", ")}`).join("\n");
  const language = req.language === "pt" ? "Brazilian Portuguese" : "English";
  const result: DraftResult = { terms: [], joins: [], tables: all.map((t) => t.full), sampled: rows.size > 0, sampleError, dropped: 0 };
  const known = [...req.existing];
  const batches = Math.ceil(tables.length / BATCH);

  for (let i = 0; i < tables.length; i += BATCH) {
    progress("terms", i / BATCH, batches);
    const batch = tables.slice(i, i + BATCH);
    const queries = queriesAbout(files, batch);
    const prompt = [
      `Write the names and descriptions in ${language}. Give synonyms in Portuguese and English when people would use both.`,
      `Tables to draft terms for:\n\n${batch.map((t) => tableText(t, rows.get(t.full) ?? null)).join("\n\n")}`,
      tables.length > batch.length && `Every table in scope, for joins (columns only):\n${others}`,
      queries && `Queries people wrote over these tables:\n\n${queries}`,
      known.length > 0 && `Terms that already exist (do not repeat them):\n${known.map((n) => `- ${n}`).join("\n")}`,
    ]
      .filter(Boolean)
      .join("\n\n");
    const checked = checkDraft(await deps.llm(CODE_MODEL, SYSTEM, prompt, DRAFT_SCHEMA), all);
    // a later batch may write a term or a join an earlier one did: mergeDraft-style, the first stays
    const merged = checkDraft({ terms: [...result.terms, ...checked.terms], joins: [...result.joins, ...checked.joins] }, all);
    result.dropped += checked.dropped + merged.dropped;
    result.terms = merged.terms;
    result.joins = merged.joins;
    known.push(...checked.terms.map((t) => t.name));
  }
  progress("terms", batches, batches);
  return result;
}
