/**
 * Stage 4a: the facts of a query. A fact is a dataset whose rows measures
 * aggregate. Each fact is grouped on its own, at the grain of the chart (the
 * columns it groups by, reached through the relationships), and the results
 * are put side by side afterwards (see compile.ts): rows of two facts are never
 * joined one to one, so nothing is counted twice.
 */

import { quoteIdent } from "@/lib/dashboards/query";

import { pathToOne } from "./graph";
import type { Atom, ColumnRef, Measure, Relationship } from "./types";

export interface Fact {
  dataset: string;
  /** what it aggregates, each result named `alias` (`__a<n>`) */
  atoms: { sql: string; alias: string }[];
  /** per grouping column: the many→one steps from this dataset to it, null when it does not reach it */
  paths: (Relationship[] | null)[];
}

export interface Plan {
  facts: Fact[];
  /** the fact (index) and the column of the result an atom of the chosen measures is computed in */
  where(atom: Atom): { fact: number; alias: string };
}

/** a dataset's rows as query text */
export type Source = (dataset: string) => string;

const idOf = (a: Atom) => `${a.dataset}\0${a.sql}`;

/** Groups the atoms of `measures` by dataset (one fact each, in order of first use) and finds what each fact reaches. */
export function planFacts(rels: readonly Relationship[], measures: readonly Measure[], keys: readonly ColumnRef[]): Plan {
  const facts: Fact[] = [];
  const spots = new Map<string, { fact: number; alias: string }>();
  for (const a of measures.flatMap((m) => m.atoms)) {
    if (spots.has(idOf(a))) continue;
    let fact = facts.findIndex((f) => f.dataset === a.dataset);
    if (fact < 0) {
      const paths = keys.map((k) => pathToOne(rels, a.dataset, k.dataset));
      fact = facts.push({ dataset: a.dataset, atoms: [], paths }) - 1;
    }
    const alias = `__a${spots.size}`;
    facts[fact].atoms.push({ sql: a.sql, alias });
    spots.set(idOf(a), { fact, alias });
  }
  return { facts, where: (a) => spots.get(idOf(a))! };
}

/** `"__k<i>"`: where the i-th grouping column lives in a fact's result */
export const keyName = (i: number) => `"__k${i}"`;

/**
 * One fact's rows grouped by the columns it reaches: `__k<i>` for each, then its atoms.
 * The dimensions are joined many→one, which never duplicates a fact row; the atoms read
 * the fact's own columns (`_f.*`) as they are written, unqualified.
 */
export function factSql(f: Fact, keys: readonly ColumnRef[], source: Source): string {
  const joins = new Map<Relationship, string>();
  const on: string[] = [];
  const keyColumns: string[] = [];
  f.paths.forEach((path, i) => {
    if (!path) return;
    let owner = "_f";
    for (const step of path) {
      let alias = joins.get(step);
      if (!alias) {
        alias = `_j${joins.size}`;
        joins.set(step, alias);
        on.push(` LEFT JOIN (${source(step.one.dataset)}) AS ${alias} ON ${owner}.${quoteIdent(step.many.column)} = ${alias}.${quoteIdent(step.one.column)}`);
      }
      owner = alias;
    }
    keyColumns.push(`${owner}.${quoteIdent(keys[i].column)} AS ${keyName(i)}`);
  });

  const names = f.paths.flatMap((p, i) => (p ? [keyName(i)] : []));
  const inner = `SELECT ${["_f.*", ...keyColumns].join(", ")} FROM (${source(f.dataset)}) AS _f${on.join("")}`;
  const select = [...names, ...f.atoms.map((a) => `${a.sql} AS ${quoteIdent(a.alias)}`)].join(", ");
  return `SELECT ${select} FROM (${inner}) AS _m${names.length ? ` GROUP BY ${names.join(", ")}` : ""}`;
}
