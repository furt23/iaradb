/**
 * What a team's owner taught Iara in a conversation (pure): the terms and
 * joins she decided belong in the ontology are checked against the tables'
 * real columns, then written at the end of the team's file as certified (an
 * owner or an admin said so), leaving every line that was there as it was. A
 * term whose name the file already has, and a join it already has, are not
 * written again.
 */

import { fold, parseOntology, sameJoin, type Ontology } from "./ontology";

export interface LessonTerm {
  name: string;
  description: string;
  synonyms: string[];
  /** `catalog.schema.table.column` */
  columns: string[];
  sql: string | null;
}

export interface LessonJoin {
  left: string;
  right: string;
  description: string | null;
}

export interface Lesson {
  terms: LessonTerm[];
  joins: LessonJoin[];
}

/** A table the lesson names: its full name and the names of its columns. */
export interface LessonTable {
  full: string;
  columns: string[];
}

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max) : "");
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/**
 * What the model answered, kept only where it is true to the tables: a column
 * that no table has is dropped, and so is a term left with none of the columns
 * it named and a join with a column that does not exist. `dropped` counts
 * the terms and joins that went.
 */
export function checkLesson(raw: unknown, tables: LessonTable[]): Lesson & { dropped: number } {
  // by lowercase name, to the column as the table writes it
  const known = new Map<string, string>();
  for (const t of tables) for (const c of t.columns) known.set(`${t.full}.${c}`.toLowerCase(), `${t.full.toLowerCase()}.${c}`);
  const column = (v: unknown) => (typeof v === "string" ? known.get(v.trim().toLowerCase()) : undefined);
  const { terms, joins } = (raw ?? {}) as { terms?: unknown; joins?: unknown };
  const out: Lesson & { dropped: number } = { terms: [], joins: [], dropped: 0 };

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

function termBlock(t: LessonTerm): string {
  const lines = ["[[term]]", `name = ${JSON.stringify(t.name)}`, `description = ${JSON.stringify(t.description)}`];
  if (t.synonyms.length) lines.push(`synonyms = ${tomlList(t.synonyms)}`);
  lines.push("certified = true");
  if (t.columns.length) lines.push(`columns = ${tomlList(t.columns)}`);
  if (t.sql) lines.push(`sql = ${tomlString(t.sql)}`);
  return lines.join("\n");
}

function joinBlock(j: LessonJoin): string {
  const lines = ["[[join]]", `left = ${JSON.stringify(j.left)}`, `right = ${JSON.stringify(j.right)}`];
  if (j.description) lines.push(`description = ${JSON.stringify(j.description)}`);
  lines.push("certified = true");
  return lines.join("\n");
}

export interface MergedLesson {
  /** the team's file with the lesson at its end */
  text: string;
  /** the terms and joins written */
  terms: number;
  joins: number;
  /** left out: the file already had them */
  known: number;
}

/**
 * The team's file with the lesson written at its end. `existing` is the file's
 * text (null: the team has none, and the file starts with `name`). Nothing
 * that was there changes. Throws when the result would not be read as an
 * ontology, so a lesson never breaks a team's file.
 */
export function mergeLesson(team: string, existing: string | null, lesson: Lesson, opts: { name?: string; by: string; date: string }): MergedLesson {
  const current: Ontology | null = existing === null ? null : parseOntology(team, existing);
  const names = new Set(current?.terms.map((t) => fold(t.name)));
  const terms = lesson.terms.filter((t) => !names.has(fold(t.name)));
  const joins = lesson.joins.filter((j) => !current?.joins.some((k) => sameJoin(k, j)));
  const known = lesson.terms.length - terms.length + (lesson.joins.length - joins.length);

  const head = existing === null ? `[ontology]\nname = ${JSON.stringify(opts.name?.trim() || team)}\nreaders = ["editors"]` : existing.replace(/\s+$/, "");
  if (!terms.length && !joins.length) return { text: existing ?? `${head}\n`, terms: 0, joins: 0, known };
  const note = `# Taught to Iara by ${opts.by} on ${opts.date}.`;
  const result = [head, note, ...terms.map(termBlock), ...joins.map(joinBlock)].join("\n\n") + "\n";
  parseOntology(team, result);
  return { text: result, terms: terms.length, joins: joins.length, known };
}
