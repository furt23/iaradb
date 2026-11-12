/**
 * Drafts of a team's ontology (pure): what a model proposed is checked
 * against the tables' real columns, then written at the end of the team's
 * file as drafts (`certified` is never set), leaving every line that was
 * there as it was. A term whose name the file already has, and a join it
 * already has, are not written again.
 */

import { fold, parseOntology, sameJoin, type Ontology } from "./ontology";

export interface DraftTerm {
  name: string;
  description: string;
  synonyms: string[];
  /** `catalog.schema.table.column` */
  columns: string[];
  sql: string | null;
}

export interface DraftJoin {
  left: string;
  right: string;
  description: string | null;
}

export interface Draft {
  terms: DraftTerm[];
  joins: DraftJoin[];
}

/** A table the draft was made from: its full name and the names of its columns. */
export interface DraftTable {
  full: string;
  columns: string[];
}

/** JSON Schema of what the model answers with. */
export const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    terms: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          synonyms: { type: "array", items: { type: "string" } },
          columns: { type: "array", items: { type: "string" }, description: "catalog.schema.table.column, exactly as listed" },
          sql: { type: "string", description: "the expression that computes the term, or empty" },
        },
        required: ["name", "description", "synonyms", "columns", "sql"],
      },
    },
    joins: {
      type: "array",
      items: {
        type: "object",
        properties: { left: { type: "string" }, right: { type: "string" }, description: { type: "string" } },
        required: ["left", "right", "description"],
      },
    },
  },
  required: ["terms", "joins"],
};

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * What the model answered, kept only where it is true to the tables: a column
 * that no table has is dropped, and so is a term left with none of the columns
 * it named and a join with a column that does not exist. `dropped` counts
 * the terms and joins that went.
 */
export function checkDraft(raw: unknown, tables: DraftTable[]): Draft & { dropped: number } {
  // by lowercase name, to the column as the table writes it
  const known = new Map<string, string>();
  for (const t of tables) for (const c of t.columns) known.set(`${t.full}.${c}`.toLowerCase(), `${t.full.toLowerCase()}.${c}`);
  const column = (v: unknown) => (typeof v === "string" ? known.get(v.trim().toLowerCase()) : undefined);
  const { terms, joins } = (raw ?? {}) as { terms?: unknown; joins?: unknown };
  const out: Draft & { dropped: number } = { terms: [], joins: [], dropped: 0 };

  const names = new Set<string>();
  for (const item of list(terms)) {
    const t = (item ?? {}) as Record<string, unknown>;
    const name = text(t.name, 200);
    const description = text(t.description, 2000);
    const named = list(t.columns);
    const columns = [...new Set(named.map(column).filter((c): c is string => !!c))];
    if (!name || !description || names.has(fold(name)) || (named.length > 0 && columns.length === 0)) {
      out.dropped++;
      continue;
    }
    names.add(fold(name));
    const synonyms = [...new Set(list(t.synonyms).map((s) => text(s, 200)).filter((s) => s && fold(s) !== fold(name)))].slice(0, 20);
    // the SQL keeps its line breaks
    const sql = typeof t.sql === "string" ? t.sql.trim().slice(0, 8000) : "";
    out.terms.push({ name, description, synonyms, columns, sql: sql || null });
  }

  for (const item of list(joins)) {
    const j = (item ?? {}) as Record<string, unknown>;
    const [left, right] = [column(j.left), column(j.right)];
    if (!left || !right || left === right || out.joins.some((k) => sameJoin(k, { left, right }))) {
      out.dropped++;
      continue;
    }
    out.joins.push({ left, right, description: text(j.description, 2000) || null });
  }
  return out;
}

/** A TOML string: basic for one line, a literal block for SQL of several lines when it can hold it. */
function tomlString(s: string): string {
  if (s.includes("\n") && !s.includes("'''") && !s.endsWith("'") && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s)) return `'''\n${s.replace(/\r\n/g, "\n")}'''`;
  return JSON.stringify(s);
}

const tomlList = (items: string[]): string => `[${items.map((s) => JSON.stringify(s)).join(", ")}]`;

function termBlock(t: DraftTerm): string {
  const lines = ["[[term]]", `name = ${JSON.stringify(t.name)}`, `description = ${JSON.stringify(t.description)}`];
  if (t.synonyms.length) lines.push(`synonyms = ${tomlList(t.synonyms)}`);
  lines.push("certified = false");
  if (t.columns.length) lines.push(`columns = ${tomlList(t.columns)}`);
  if (t.sql) lines.push(`sql = ${tomlString(t.sql)}`);
  return lines.join("\n");
}

function joinBlock(j: DraftJoin): string {
  const lines = ["[[join]]", `left = ${JSON.stringify(j.left)}`, `right = ${JSON.stringify(j.right)}`];
  if (j.description) lines.push(`description = ${JSON.stringify(j.description)}`);
  lines.push("certified = false");
  return lines.join("\n");
}

export interface MergedDraft {
  /** the team's file with the draft at its end */
  text: string;
  /** the terms and joins written */
  terms: number;
  joins: number;
  /** left out: the file already had them */
  known: number;
}

/**
 * The team's file with the draft written at its end. `existing` is the file's
 * text (null: the team has none, and the file starts with `name`). Nothing
 * that was there changes. Throws when the result would not be read as an
 * ontology, so a draft never breaks a team's file.
 */
export function mergeDraft(team: string, existing: string | null, draft: Draft, opts: { name?: string; date: string }): MergedDraft {
  const current: Ontology | null = existing === null ? null : parseOntology(team, existing);
  const names = new Set(current?.terms.map((t) => fold(t.name)));
  const terms = draft.terms.filter((t) => !names.has(fold(t.name)));
  const joins = draft.joins.filter((j) => !current?.joins.some((k) => sameJoin(k, j)));
  const known = draft.terms.length - terms.length + (draft.joins.length - joins.length);

  const head = existing === null ? `[ontology]\nname = ${JSON.stringify(opts.name?.trim() || team)}\nreaders = ["editors"]` : existing.replace(/\s+$/, "");
  if (!terms.length && !joins.length) return { text: existing ?? `${head}\n`, terms: 0, joins: 0, known };
  const note = `# Drafts written by Iara on ${opts.date}. Review each one, fix it, then set certified = true.`;
  const result = [head, note, ...terms.map(termBlock), ...joins.map(joinBlock)].join("\n\n") + "\n";
  parseOntology(team, result);
  return { text: result, terms: terms.length, joins: joins.length, known };
}

/** Where a draft being made is: the tables described, the tables whose rows were read, or the model's answers received. */
export interface DraftProgress {
  step: "tables" | "rows" | "terms";
  done: number;
  total: number;
}

/** What a finished draft did to the team's file. */
export interface DraftOutcome {
  team: string;
  /** written into the team's file as drafts */
  terms: number;
  joins: number;
  /** left out: the file already had them */
  known: number;
  /** left out: the tables do not support them */
  dropped: number;
  /** the tables read */
  tables: number;
  sampled: boolean;
  /** why no rows were read, when they were asked for */
  sampleError: string | null;
}

/** The server-sent events of POST /api/ontology/draft: progress (and pings that keep the connection open), then done or failed. */
export type DraftEvent =
  | { event: "progress"; data: DraftProgress }
  | { event: "ping"; data: null }
  | { event: "done"; data: DraftOutcome }
  | { event: "failed"; data: { message: string } };
