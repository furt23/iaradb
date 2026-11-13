/**
 * A team's ontology (pure): its business terms, the columns they map to, the
 * SQL that computes them and how its tables join. One TOML file per team:
 *
 *     [ontology]
 *     name = "Finance"
 *     readers = ["editors"]            # or emails; admins read every ontology
 *     owners = ["ana@example.com"]     # Iara writes what they teach her into the file, besides admins
 *
 *     [[term]]
 *     name = "Net revenue"
 *     description = "Revenue after discounts, before tax."
 *     synonyms = ["receita líquida"]
 *     certified = true                 # false (the default) is a draft
 *     columns = ["main.sales.orders.amount", "main.sales.orders.discount"]
 *     sql = "sum(amount * (1 - discount))"
 *
 *     [[join]]
 *     left = "main.sales.orders.customer_id"
 *     right = "main.sales.customers.id"
 *
 * A term or join is shown only to someone who may read every table it names.
 */

import { parse } from "smol-toml";
import { z } from "zod";

export const MAX_TERMS = 2000;
/** the terms one search gives */
export const SEARCH_LIMIT = 8;
const JOIN_LIMIT = 12;

/** A team's file name without `.toml`: its id. */
export const TEAM_ID = /^[a-z0-9][a-z0-9_-]{0,62}$/;

export interface OntologyTerm {
  name: string;
  description: string;
  synonyms: string[];
  /** reviewed by the team; otherwise a draft */
  certified: boolean;
  /** `catalog.schema.table.column` */
  columns: string[];
  /** tables the term's SQL reads besides those of `columns` */
  tables: string[];
  /** the expression or query that computes the term */
  sql: string | null;
}

export interface OntologyJoin {
  /** `catalog.schema.table.column` */
  left: string;
  right: string;
  description: string | null;
  certified: boolean;
}

export interface Ontology {
  /** the file's name without `.toml` */
  team: string;
  /** the team's name as people read it */
  name: string;
  description: string | null;
  /** lowercase emails or `editors` */
  readers: string[];
  /** lowercase emails of those whose rules Iara writes into the file (admins always) */
  owners: string[];
  terms: OntologyTerm[];
  joins: OntologyJoin[];
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;
const EMAIL = /^[^\s@]+@[^\s@]+$/;

const line = (max: number) => z.string().trim().min(1).max(max);

/** `catalog.schema.table` in lowercase. */
const TableName = line(400)
  .transform((s) => s.toLowerCase())
  .refine((s) => s.split(".").length === 3 && s.split(".").every((p) => IDENTIFIER.test(p)), "a table is catalog.schema.table");

/** `catalog.schema.table.column`: the table in lowercase, the column as written. */
const ColumnName = line(600).transform((s, ctx) => {
  const parts = s.split(".");
  const table = parts.slice(0, 3).join(".").toLowerCase();
  const column = parts.slice(3).join(".");
  if (parts.length < 4 || !column || !table.split(".").every((p) => IDENTIFIER.test(p))) {
    ctx.addIssue({ code: "custom", message: "a column is catalog.schema.table.column" });
    return z.NEVER;
  }
  return `${table}.${column}`;
});

const Reader = line(320)
  .transform((s) => s.toLowerCase())
  .refine((s) => s === "editors" || EMAIL.test(s), "a reader is an email or editors");

const Owner = line(320)
  .transform((s) => s.toLowerCase())
  .refine((s) => EMAIL.test(s), "an owner is an email");

const Term = z.strictObject({
  name: line(200),
  description: line(2000),
  synonyms: z.array(line(200)).max(50).default([]),
  certified: z.boolean().default(false),
  columns: z.array(ColumnName).max(100).default([]),
  tables: z.array(TableName).max(100).default([]),
  sql: line(8000).optional(),
});

const Join = z.strictObject({
  left: ColumnName,
  right: ColumnName,
  description: line(2000).optional(),
  certified: z.boolean().default(false),
});

const File = z.strictObject({
  ontology: z
    .strictObject({
      name: line(200).optional(),
      description: line(2000).optional(),
      readers: z.array(Reader).max(500).default(["editors"]),
      owners: z.array(Owner).max(500).default([]),
    })
    .default({ readers: ["editors"], owners: [] }),
  term: z.array(Term).max(MAX_TERMS).default([]),
  join: z.array(Join).max(MAX_TERMS).default([]),
});

/** The table of a `catalog.schema.table.column`. */
export const tableOf = (column: string): string => column.split(".").slice(0, 3).join(".");

/** The ontology in a team's file. Throws with what is wrong: an unknown key is an error, so a typo never hides a definition. */
export function parseOntology(team: string, text: string): Ontology {
  if (!TEAM_ID.test(team)) throw new Error(`${team} is not a team id (lowercase letters, digits, - and _)`);
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    throw new Error(`not valid TOML: ${(e as Error).message.split("\n")[0]}`);
  }
  const file = File.safeParse(data);
  if (!file.success) throw new Error(z.prettifyError(file.error));
  const { ontology, term, join } = file.data;
  const seen = new Set<string>();
  for (const t of term) {
    const key = fold(t.name);
    if (seen.has(key)) throw new Error(`the term "${t.name}" is defined twice`);
    seen.add(key);
  }
  return {
    team,
    name: ontology.name ?? team,
    description: ontology.description ?? null,
    readers: ontology.readers,
    owners: ontology.owners,
    terms: term.map((t) => ({ ...t, sql: t.sql ?? null })),
    joins: join.map((j) => ({ ...j, description: j.description ?? null })),
  };
}

/** Whether a user may read a team's ontology: admins all of them, the others when it names them or `editors`. Viewers never. */
export function mayReadOntology(user: { email: string; admin: boolean; viewer?: boolean }, o: Pick<Ontology, "readers">): boolean {
  if (user.admin) return true;
  if (user.viewer) return false;
  return o.readers.includes("editors") || (!!user.email && o.readers.includes(user.email.toLowerCase()));
}

/** Whether what a user tells Iara may be written into a team's file (null: the team has none yet): admins, and the owners the file names. */
export function mayTeachOntology(user: { email: string; admin: boolean; viewer?: boolean }, o: Pick<Ontology, "owners"> | null): boolean {
  if (user.admin) return true;
  if (user.viewer || !o) return false;
  return !!user.email && o.owners.includes(user.email.toLowerCase());
}

/** Every table a term names: those of its columns and those its SQL reads. */
export function termTables(t: Pick<OntologyTerm, "columns" | "tables">): string[] {
  return [...new Set([...t.columns.map(tableOf), ...t.tables])];
}

/** The ontology as someone reads it: without the terms and joins over a table they may not read. */
export function readableOntology(o: Ontology, canRead: (table: string) => boolean): Ontology {
  return {
    ...o,
    terms: o.terms.filter((t) => termTables(t).every(canRead)),
    joins: o.joins.filter((j) => canRead(tableOf(j.left)) && canRead(tableOf(j.right))),
  };
}

/** Whether two joins link the same columns, in either direction. */
export function sameJoin(a: Pick<OntologyJoin, "left" | "right">, b: Pick<OntologyJoin, "left" | "right">): boolean {
  const [al, ar, bl, br] = [a.left, a.right, b.left, b.right].map((c) => c.toLowerCase());
  return (al === bl && ar === br) || (al === br && ar === bl);
}

// ---- search ----

/** Lowercase without accents, so "receita líquida" finds "Receita Liquida": how two names of a term are compared. */
export function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}

// words that say nothing about a term, in the languages the Studio speaks
const STOP = new Set(
  "a an and are as at by da das de do dos e em for from how in is me na no nas nos o of on or os para por qual quais que show the to um uma what which with como com".split(" "),
);

function words(s: string): string[] {
  return fold(s)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** Two words are the same, or one starts with the other (plurals and the like), from four letters on. */
function alike(a: string, b: string): boolean {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 4 && long.startsWith(short);
}

const hits = (query: string[], text: string[]): number => query.filter((q) => text.some((w) => alike(q, w))).length;

/** How well a term answers the query: its name and synonyms count most, then its columns, then its description. 0: no match. */
function score(t: OntologyTerm, query: string[], phrase: string): number {
  const names = [t.name, ...t.synonyms];
  let s = 0;
  if (phrase && names.some((n) => fold(n).includes(phrase))) s += 6;
  s += 3 * Math.max(...names.map((n) => hits(query, words(n))));
  s += 2 * hits(query, t.columns.flatMap((c) => words(c.split(".").slice(2).join(" "))));
  s += hits(query, words(t.description));
  return s;
}

export interface FoundTerm extends Omit<OntologyTerm, "tables"> {
  /** the team's name */
  team: string;
}

export interface FoundJoin extends OntologyJoin {
  team: string;
}

export interface OntologySearch {
  terms: FoundTerm[];
  joins: FoundJoin[];
  /** terms that matched beyond the ones given */
  more: number;
}

/**
 * The terms that answer `query` (every term, by name, when it is empty), best
 * first and certified before drafts, with the joins between their tables.
 * `canRead` says whether a table may be read: a term or join with one that
 * may not is left out, as if it did not exist.
 */
export function searchOntologies(ontologies: Ontology[], query: string, canRead: (table: string) => boolean, limit = SEARCH_LIMIT): OntologySearch {
  const q = words(query);
  const phrase = q.length > 1 ? fold(query).trim().replace(/\s+/g, " ") : "";
  const found: { term: FoundTerm; tables: string[]; score: number }[] = [];
  const readable = ontologies.map((o) => readableOntology(o, canRead));
  for (const o of readable) {
    for (const t of o.terms) {
      const tables = termTables(t);
      const s = q.length ? score(t, q, phrase) : 1;
      if (!s) continue;
      const { tables: _reads, ...term } = t;
      found.push({ term: { team: o.name, ...term }, tables, score: s });
    }
  }
  found.sort((a, b) => b.score - a.score || Number(b.term.certified) - Number(a.term.certified) || a.term.name.localeCompare(b.term.name));
  const top = found.slice(0, limit);

  const wanted = new Set(top.flatMap((f) => f.tables));
  const joins: FoundJoin[] = [];
  for (const o of readable) {
    for (const j of o.joins) {
      const [l, r] = [tableOf(j.left), tableOf(j.right)];
      const named = q.length > 0 && hits(q, words(`${l.split(".").slice(1).join(" ")} ${r.split(".").slice(1).join(" ")} ${j.description ?? ""}`)) > 0;
      if (wanted.has(l) || wanted.has(r) || named) joins.push({ team: o.name, ...j });
    }
  }
  joins.sort((a, b) => Number(b.certified) - Number(a.certified));
  return { terms: top.map((f) => f.term), joins: joins.slice(0, JOIN_LIMIT), more: found.length - top.length };
}
